import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  AdapterName,
  IntegrationResult,
  ReviewResult,
  RunManifest,
  RunnerConfig,
  TaskRecord,
  TaskSpec,
  WorkerResult
} from './types.js';
import { StateDatabase } from './db.js';
import { createAdapter } from '../adapters/index.js';
import { resolveRoleWithSnapshot } from './profiles.js';
import {
  INTEGRATION_SCHEMA,
  REVIEW_SCHEMA,
  WORKER_SCHEMA,
  topologicalTasks,
  validateIntegrationResult,
  validateReviewResult,
  validateWorkerResult
} from './validation.js';
import {
  abortCherryPick,
  changedFiles,
  cherryPick,
  commit,
  conflictedFiles,
  continueCherryPick,
  createWorktree,
  currentHead,
  git,
  stageAll,
  unstageAll
} from './git.js';
import { integrationPrompt, reviewFeedback, reviewerPrompt, workerPrompt } from './prompts.js';
import { checkPaths } from './path-policy.js';
import { runGlobalVerification, verifyTaskWorktree } from './verifier.js';

function safeSegment(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
}

function taskSpec(record: TaskRecord): TaskSpec {
  return JSON.parse(record.specJson) as TaskSpec;
}

function parseManifest(json: string | null): RunManifest {
  if (!json) throw new Error('Run has no manifest');
  return JSON.parse(json) as RunManifest;
}

export async function runOrchestrator(input: {
  config: RunnerConfig;
  db: StateDatabase;
  runId: string;
}): Promise<void> {
  const { config, db, runId } = input;
  let run = db.getRun(runId);
  if (!['planned', 'running', 'needs_attention', 'failed'].includes(run.status)) {
    if (run.status === 'done') return;
    throw new Error(`Run ${runId} cannot start from status ${run.status}`);
  }
  db.resetInterrupted(runId);
  db.updateRun(runId, { status: 'running', error: null, finishedAt: null });
  db.addEvent(runId, null, 'RUN_STARTED');

  const active = new Map<string, Promise<void>>();
  try {
    while (true) {
      const tasks = db.listTasks(runId);
      const approved = new Set(tasks.filter((task) => task.status === 'approved').map((task) => task.taskId));
      const terminalProblem = tasks.find((task) => task.status === 'blocked' || task.status === 'failed');
      if (terminalProblem) {
        db.updateRun(runId, { status: 'needs_attention', error: `${terminalProblem.taskId}: ${terminalProblem.lastError ?? terminalProblem.status}` });
        return;
      }
      if (tasks.length > 0 && tasks.every((task) => task.status === 'approved')) break;

      const slots = Math.max(0, config.concurrency - active.size);
      const candidates = tasks.filter((record) => {
        if (!['pending', 'changes_requested'].includes(record.status)) return false;
        if (active.has(record.taskId)) return false;
        return taskSpec(record).dependsOn.every((dep) => approved.has(dep));
      }).slice(0, slots);

      for (const candidate of candidates) {
        const promise = executeTask({ config, db, runId, record: candidate })
          .catch((error) => {
            db.updateTask(runId, candidate.taskId, {
              status: 'failed', phase: 'exception', pid: null, lastError: String(error), finishedAt: new Date().toISOString()
            });
            db.addEvent(runId, candidate.taskId, 'TASK_EXCEPTION', { error: String(error) });
          })
          .finally(() => active.delete(candidate.taskId));
        active.set(candidate.taskId, promise);
      }

      if (active.size === 0) {
        const blockedByGraph = db.listTasks(runId).filter((task) => !['approved', 'failed', 'blocked'].includes(task.status));
        if (blockedByGraph.length > 0) {
          db.updateRun(runId, { status: 'needs_attention', error: 'No runnable tasks remain; inspect dependency and task states.' });
          return;
        }
      } else {
        await Promise.race(active.values());
      }
    }

    await integrateRun({ config, db, runId });
  } catch (error) {
    db.updateRun(runId, { status: 'failed', error: String(error), finishedAt: new Date().toISOString() });
    db.addEvent(runId, null, 'RUN_FAILED', { error: String(error) });
    throw error;
  } finally {
    await Promise.allSettled(active.values());
    run = db.getRun(runId);
    if (run.status === 'done') db.addEvent(runId, null, 'RUN_COMPLETED');
  }
}

async function executeTask(input: {
  config: RunnerConfig;
  db: StateDatabase;
  runId: string;
  record: TaskRecord;
}): Promise<void> {
  const { config, db, runId } = input;
  let record = db.getTask(runId, input.record.taskId);
  const task = taskSpec(record);
  const run = db.getRun(runId);
  const runDir = join(config.stateDir, 'runs', runId);
  // Worker：Lead manifest 的 task.adapter 优先，否则用 plan 时固化的角色快照（回退当前 config）
  const workerProfile = resolveRoleWithSnapshot('worker', config, run.rolesJson);
  const adapterName: AdapterName = task.adapter ?? workerProfile.cli;
  const adapter = createAdapter(adapterName, config, task.adapter ? undefined : workerProfile.model);
  const worktreeInfo = await ensureTaskWorktree({ config, db, runId, record, task, manifest: parseManifest(run.manifestJson) });
  record = db.getTask(runId, task.id);
  const attempts = record.attempts + 1;
  db.updateTask(runId, task.id, { status: 'running', phase: 'worker', attempts, pid: null });
  db.addEvent(runId, task.id, 'WORKER_STARTED', {
    attempts,
    adapter: adapterName,
    model: task.adapter ? undefined : workerProfile.model
  });

  const outputPath = join(runDir, 'results', `${task.id}-worker-${attempts}.json`);
  const logPath = join(runDir, 'logs', `${task.id}-worker-${attempts}.log`);
  let lastHeartbeatWrite = 0;
  const worker = await adapter.run<WorkerResult>({
    role: 'worker', cwd: worktreeInfo.path,
    prompt: workerPrompt({ task, startSha: worktreeInfo.startSha, runId, priorFeedback: record.lastError }),
    schema: WORKER_SCHEMA, logPath, outputPath, timeoutMs: config.taskTimeoutMs, staleAfterMs: config.staleAfterMs,
    onPid: (pid) => db.updateTask(runId, task.id, { pid }),
    onHeartbeat: () => {
      if (Date.now() - lastHeartbeatWrite > 3000) {
        lastHeartbeatWrite = Date.now();
        db.updateTask(runId, task.id, { phase: 'worker-active' });
      }
    }
  });
  db.updateTask(runId, task.id, { pid: null });
  if (worker.exitCode !== 0 || !worker.output) {
    await retryOrFail({ config, db, runId, taskId: task.id, attempts, error: `Worker exited ${worker.exitCode}${worker.timedOut ? ' after timeout' : ''}${worker.stalled ? ' after becoming stale' : ''}` });
    return;
  }
  const workerResult = validateWorkerResult(worker.output);
  if (workerResult.status === 'blocked') {
    db.updateTask(runId, task.id, { status: 'blocked', phase: 'worker', lastError: workerResult.blockedReason ?? workerResult.summary, finishedAt: new Date().toISOString() });
    db.addEvent(runId, task.id, 'WORKER_BLOCKED', workerResult);
    return;
  }
  if (workerResult.status === 'failed') {
    await retryOrFail({ config, db, runId, taskId: task.id, attempts, error: workerResult.summary });
    return;
  }

  db.updateTask(runId, task.id, { status: 'verifying', phase: 'mechanical-verification' });
  const verification = await verifyTaskWorktree({
    worktree: worktreeInfo.path, task, startSha: worktreeInfo.startSha, config,
    logPath: join(runDir, 'logs', `${task.id}-verification-${attempts}.log`)
  });
  if (!verification.ok) {
    await retryOrFail({ config, db, runId, taskId: task.id, attempts, error: verification.error ?? 'Verification failed' });
    return;
  }

  await stageAll(worktreeInfo.path);
  db.updateTask(runId, task.id, { status: 'reviewing', phase: 'reviewer' });
  db.addEvent(runId, task.id, 'REVIEW_STARTED', { changedFiles: verification.changedFiles });
  const reviewCycle = record.reviewCycles + 1;
  const reviewOutput = join(runDir, 'reviews', `${task.id}-review-${reviewCycle}.json`);
  const reviewHeadBefore = await currentHead(worktreeInfo.path);
  const reviewStatusBefore = (await git(worktreeInfo.path, ['status', '--porcelain=v1', '-z'])).stdout;
  // Reviewer 独立解析角色 profile（plan 快照优先），不再复用 Worker 的 adapter 实例
  const reviewerProfile = resolveRoleWithSnapshot('reviewer', config, run.rolesJson);
  const reviewerAdapter = createAdapter(reviewerProfile.cli, config, reviewerProfile.model);
  const reviewRun = await reviewerAdapter.run<ReviewResult>({
    role: 'reviewer', cwd: worktreeInfo.path,
    prompt: reviewerPrompt({ task, startSha: worktreeInfo.startSha, workerResult }),
    schema: REVIEW_SCHEMA,
    logPath: join(runDir, 'logs', `${task.id}-review-${reviewCycle}.log`),
    outputPath: reviewOutput,
    timeoutMs: config.taskTimeoutMs, staleAfterMs: config.staleAfterMs,
    onPid: (pid) => db.updateTask(runId, task.id, { pid })
  });
  db.updateTask(runId, task.id, { pid: null });
  const reviewHeadAfter = await currentHead(worktreeInfo.path);
  const reviewStatusAfter = (await git(worktreeInfo.path, ['status', '--porcelain=v1', '-z'])).stdout;
  if (reviewHeadAfter !== reviewHeadBefore || reviewStatusAfter !== reviewStatusBefore) {
    await unstageAll(worktreeInfo.path);
    await retryOrFail({ config, db, runId, taskId: task.id, attempts, error: 'Reviewer modified Git state or files; review must be read-only.' });
    return;
  }
  if (reviewRun.exitCode !== 0 || !reviewRun.output) {
    await unstageAll(worktreeInfo.path);
    await retryOrFail({ config, db, runId, taskId: task.id, attempts, error: `Reviewer exited ${reviewRun.exitCode}` });
    return;
  }
  const review = validateReviewResult(reviewRun.output);
  db.updateTask(runId, task.id, { reviewCycles: reviewCycle, reviewJson: JSON.stringify(review) });
  if (review.decision === 'changes_requested') {
    await unstageAll(worktreeInfo.path);
    if (reviewCycle >= config.maxReviewCycles) {
      db.updateTask(runId, task.id, { status: 'failed', phase: 'review', lastError: reviewFeedback(review), finishedAt: new Date().toISOString() });
      db.addEvent(runId, task.id, 'REVIEW_LIMIT_REACHED', review);
    } else {
      db.updateTask(runId, task.id, { status: 'changes_requested', phase: 'review', lastError: reviewFeedback(review) });
      db.addEvent(runId, task.id, 'CHANGES_REQUESTED', review);
    }
    return;
  }

  const commitSha = await commit(worktreeInfo.path, `[${task.id}] ${task.title}`);
  db.updateTask(runId, task.id, {
    status: 'approved', phase: 'done', commitSha, lastError: null, finishedAt: new Date().toISOString()
  });
  db.addEvent(runId, task.id, 'TASK_APPROVED', { commitSha, review, workerResult });
}

async function retryOrFail(input: {
  config: RunnerConfig;
  db: StateDatabase;
  runId: string;
  taskId: string;
  attempts: number;
  error: string;
}): Promise<void> {
  if (input.attempts >= input.config.maxWorkerAttempts) {
    input.db.updateTask(input.runId, input.taskId, {
      status: 'failed', phase: 'retry-limit', lastError: input.error, finishedAt: new Date().toISOString(), pid: null
    });
    input.db.addEvent(input.runId, input.taskId, 'WORKER_RETRY_LIMIT_REACHED', { error: input.error });
  } else {
    input.db.updateTask(input.runId, input.taskId, {
      status: 'changes_requested', phase: 'retry', lastError: input.error, pid: null
    });
    input.db.addEvent(input.runId, input.taskId, 'WORKER_RETRY_SCHEDULED', { error: input.error });
  }
}

async function ensureTaskWorktree(input: {
  config: RunnerConfig;
  db: StateDatabase;
  runId: string;
  record: TaskRecord;
  task: TaskSpec;
  manifest: RunManifest;
}): Promise<{ path: string; startSha: string }> {
  if (input.record.worktree && input.record.startSha && existsSync(input.record.worktree)) {
    return { path: input.record.worktree, startSha: input.record.startSha };
  }
  const run = input.db.getRun(input.runId);
  const repoName = safeSegment(basename(input.config.repoRoot));
  const path = join(input.config.worktreesDir, repoName, safeSegment(input.runId), input.task.id);
  const branch = `${input.config.branchPrefix}/${safeSegment(input.runId)}/${input.task.id}`;
  await createWorktree({ repoRoot: input.config.repoRoot, path, branch, baseSha: run.baseSha });
  const ancestorIds = collectAncestors(input.task.id, input.manifest.tasks);
  const ordered = topologicalTasks(input.manifest.tasks).filter((task) => ancestorIds.has(task.id));
  for (const dep of ordered) {
    const depRecord = input.db.getTask(input.runId, dep.id);
    if (!depRecord.commitSha) throw new Error(`Dependency ${dep.id} has no approved commit`);
    const result = await cherryPick(path, depRecord.commitSha);
    if (result.code !== 0) {
      await abortCherryPick(path);
      throw new Error(`Failed to inject dependency ${dep.id} into ${input.task.id}: ${result.stderr}`);
    }
  }
  const startSha = await currentHead(path);
  input.db.updateTask(input.runId, input.task.id, { worktree: path, branch, startSha });
  input.db.addEvent(input.runId, input.task.id, 'WORKTREE_CREATED', { path, branch, startSha });
  return { path, startSha };
}

function collectAncestors(taskId: string, tasks: TaskSpec[]): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const result = new Set<string>();
  const visit = (id: string): void => {
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!result.has(dep)) { result.add(dep); visit(dep); }
    }
  };
  visit(taskId);
  return result;
}

async function integrateRun(input: {
  config: RunnerConfig;
  db: StateDatabase;
  runId: string;
}): Promise<void> {
  const { config, db, runId } = input;
  const run = db.getRun(runId);
  const manifest = parseManifest(run.manifestJson);
  db.updateRun(runId, { status: 'integrating' });
  db.addEvent(runId, null, 'INTEGRATION_STARTED');
  const repoName = safeSegment(basename(config.repoRoot));
  const worktree = join(config.worktreesDir, repoName, safeSegment(runId), 'integration');
  const branch = `${config.branchPrefix}/${safeSegment(runId)}/integration`;
  await createWorktree({ repoRoot: config.repoRoot, path: worktree, branch, baseSha: run.baseSha });
  db.updateRun(runId, { integrationBranch: branch, integrationWorktree: worktree });
  const runDir = join(config.stateDir, 'runs', runId);
  const integratorProfile = resolveRoleWithSnapshot('integrator', config, run.rolesJson);
  const adapter = createAdapter(integratorProfile.cli, config, integratorProfile.model);

  for (const task of topologicalTasks(manifest.tasks)) {
    const record = db.getTask(runId, task.id);
    if (!record.commitSha) throw new Error(`Approved task ${task.id} has no commit`);
    const picked = await cherryPick(worktree, record.commitSha);
    if (picked.code === 0) continue;
    const conflicts = await conflictedFiles(worktree);
    if (conflicts.length === 0) throw new Error(`Cherry-pick failed for ${task.id}: ${picked.stderr}`);
    const conflictResult = await adapter.run<IntegrationResult>({
      role: 'integrator', cwd: worktree,
      prompt: integrationPrompt({ manifest, integrationAllowedPaths: config.integration.allowedPaths, mode: 'resolve_conflict', conflictFiles: conflicts }),
      schema: INTEGRATION_SCHEMA,
      logPath: join(runDir, 'logs', `integration-conflict-${task.id}.log`),
      outputPath: join(runDir, 'results', `integration-conflict-${task.id}.json`),
      timeoutMs: config.taskTimeoutMs, staleAfterMs: config.staleAfterMs
    });
    if (conflictResult.exitCode !== 0 || !conflictResult.output) {
      await abortCherryPick(worktree);
      throw new Error(`Integrator failed to resolve conflict for ${task.id}`);
    }
    const conflictReport = validateIntegrationResult(conflictResult.output);
    if (conflictReport.status !== 'completed') {
      await abortCherryPick(worktree);
      throw new Error(conflictReport.blockedReason ?? conflictReport.summary);
    }
    const conflictChanges = await changedFiles(worktree);
    const conflictPolicy = checkPaths(conflictChanges, conflicts, []);
    if (!conflictPolicy.ok) {
      await abortCherryPick(worktree);
      throw new Error(`Conflict resolver modified unrelated files: ${conflictPolicy.invalid.join(', ')}`);
    }
    await stageAll(worktree);
    const unresolved = await conflictedFiles(worktree);
    if (unresolved.length > 0) {
      await abortCherryPick(worktree);
      throw new Error(`Unresolved integration conflicts: ${unresolved.join(', ')}`);
    }
    await git(worktree, ['cherry-pick', '--continue']);
  }

  await runGlobalVerification({ worktree, config, logPath: join(runDir, 'logs', 'integration-verification.log') });
  if (config.integration.runAgentAfterCherryPick) {
    const integrationRun = await adapter.run<IntegrationResult>({
      role: 'integrator', cwd: worktree,
      prompt: integrationPrompt({ manifest, integrationAllowedPaths: config.integration.allowedPaths, mode: 'finalize' }),
      schema: INTEGRATION_SCHEMA,
      logPath: join(runDir, 'logs', 'integrator.log'),
      outputPath: join(runDir, 'results', 'integrator.json'),
      timeoutMs: config.taskTimeoutMs, staleAfterMs: config.staleAfterMs
    });
    if (integrationRun.exitCode !== 0 || !integrationRun.output) throw new Error('Integrator finalization failed');
    const integrationResult = validateIntegrationResult(integrationRun.output);
    if (integrationResult.status !== 'completed') throw new Error(integrationResult.blockedReason ?? integrationResult.summary);
    const files = await changedFiles(worktree);
    if (files.length > 0) {
      const policy = checkPaths(files, config.integration.allowedPaths, []);
      if (!policy.ok) throw new Error(`Integrator modified paths outside policy: ${policy.invalid.join(', ')}`);
      await runGlobalVerification({ worktree, config, logPath: join(runDir, 'logs', 'integration-verification-after-docs.log') });
      await stageAll(worktree);
      await commit(worktree, '[integration] update architecture and progress documentation');
    }
  }
  const integrationCommit = await currentHead(worktree);
  db.updateRun(runId, { status: 'done', integrationCommit, error: null, finishedAt: new Date().toISOString() });
  db.addEvent(runId, null, 'INTEGRATION_COMPLETED', { branch, worktree, integrationCommit });
  writeFileSync(join(runDir, 'summary.txt'), `Run ${runId} completed\nBranch: ${branch}\nCommit: ${integrationCommit}\n`, 'utf8');
}
