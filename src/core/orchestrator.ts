import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  IntegrationResult,
  ReviewResult,
  RunManifest,
  RunnerConfig,
  TaskRecord,
  TaskSpec,
  WorkerResult
} from './types.js';
import type { AgentBackend, AgentEvent } from '../agent/types.js';
import { StateDatabase } from './db.js';
import { buildBackends, disposeBackends, resolveAgentWithSnapshot, resolveTaskAgent } from '../agent/registry.js';
import { runAgent } from '../agent/supervise.js';
import { integratorPolicy, readOnlyPolicy, workerPolicy } from './policy.js';
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
  resetWorktree,
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

  // 后端进程池：整个 run 共享（codex app-server / opencode serve 常驻复用）
  const backends = buildBackends(config);
  // 信号兜底：detached 的后端子进程（app-server 等）不会随父进程退出，显式清理
  const onSignal = (): void => {
    disposeBackends(backends);
    process.exit(0);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
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
        const promise = executeTask({ config, db, runId, backends, record: candidate })
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

    await integrateRun({ config, db, runId, backends });
  } catch (error) {
    db.updateRun(runId, { status: 'failed', error: String(error), finishedAt: new Date().toISOString() });
    db.addEvent(runId, null, 'RUN_FAILED', { error: String(error) });
    throw error;
  } finally {
    await Promise.allSettled(active.values());
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    disposeBackends(backends);
    run = db.getRun(runId);
    if (run.status === 'done') db.addEvent(runId, null, 'RUN_COMPLETED');
  }
}

async function executeTask(input: {
  config: RunnerConfig;
  db: StateDatabase;
  runId: string;
  backends: Record<string, AgentBackend>;
  record: TaskRecord;
}): Promise<void> {
  const { config, db, runId, backends } = input;
  let record = db.getTask(runId, input.record.taskId);
  const task = taskSpec(record);
  const run = db.getRun(runId);
  const runDir = join(config.stateDir, 'runs', runId);
  // Worker：Lead manifest 的 task.agent 优先（连带 model），否则用 plan 时固化的角色快照（回退当前 config）
  const workerBinding = resolveTaskAgent(task, config, run.rolesJson);
  const worktreeInfo = await ensureTaskWorktree({ config, db, runId, record, task, manifest: parseManifest(run.manifestJson) });
  record = db.getTask(runId, task.id);
  const attempts = record.attempts + 1;
  db.updateTask(runId, task.id, { status: 'running', phase: 'worker', attempts, pid: null });
  db.addEvent(runId, task.id, 'WORKER_STARTED', {
    attempts,
    agent: workerBinding.agent,
    backend: workerBinding.backend,
    model: workerBinding.model
  });

  const outputPath = join(runDir, 'results', `${task.id}-worker-${attempts}.json`);
  const logPath = join(runDir, 'logs', `${task.id}-worker-${attempts}.log`);
  // 厚重试上下文：worktree 是记忆载体——重试时把 diff、reviewer 原文、上次 summary 注入 prompt，
  // 会话本身保持全新（避免上下文腐烂与跨任务污染）
  const retry = record.attempts > 0 || record.reviewCycles > 0
    ? {
        diff: await collectWorktreeDiff(worktreeInfo.path),
        review: record.reviewJson ?? undefined,
        previousSummary: readPreviousSummary(runDir, task.id, attempts - 1)
      }
    : undefined;
  let lastHeartbeatWrite = 0;
  const onEvent = (event: AgentEvent): void => {
    if (Date.now() - lastHeartbeatWrite > 3000) {
      lastHeartbeatWrite = Date.now();
      db.updateTask(runId, task.id, { phase: 'worker-active' });
    }
  };
  const worker = await runAgent<WorkerResult>({
    backend: backends[workerBinding.backend]!,
    spec: {
      role: 'worker', cwd: worktreeInfo.path,
      prompt: workerPrompt({ task, startSha: worktreeInfo.startSha, runId, worktreePath: worktreeInfo.path, priorFeedback: record.lastError, retry }),
      schema: WORKER_SCHEMA,
      ...(workerBinding.model !== undefined ? { model: workerBinding.model } : {}),
      ...(workerBinding.maxTurns !== undefined ? { maxTurns: workerBinding.maxTurns } : {}),
      policy: workerPolicy(task, config),
      timeoutMs: config.taskTimeoutMs, staleAfterMs: config.staleAfterMs,
      onEvent
    },
    logPath, outputPath
  });
  if (!worker.ok || !worker.output) {
    await retryOrFail({ config, db, runId, taskId: task.id, attempts, error: `Worker failed: ${worker.error ?? 'no structured output'}${worker.timedOut ? ' (timeout)' : ''}${worker.stalled ? ' (stalled)' : ''}` });
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
  // Reviewer 独立解析角色绑定（plan 快照优先），不复用 Worker 的会话
  const reviewerBinding = resolveAgentWithSnapshot('reviewer', config, run.rolesJson);
  const reviewRun = await runAgent<ReviewResult>({
    backend: backends[reviewerBinding.backend]!,
    spec: {
      role: 'reviewer', cwd: worktreeInfo.path,
      prompt: reviewerPrompt({ task, startSha: worktreeInfo.startSha, worktreePath: worktreeInfo.path, workerResult }),
      schema: REVIEW_SCHEMA,
      ...(reviewerBinding.model !== undefined ? { model: reviewerBinding.model } : {}),
      ...(reviewerBinding.maxTurns !== undefined ? { maxTurns: reviewerBinding.maxTurns } : {}),
      policy: readOnlyPolicy(),
      timeoutMs: config.taskTimeoutMs, staleAfterMs: config.staleAfterMs
    },
    logPath: join(runDir, 'logs', `${task.id}-review-${reviewCycle}.log`),
    outputPath: reviewOutput
  });
  const reviewHeadAfter = await currentHead(worktreeInfo.path);
  const reviewStatusAfter = (await git(worktreeInfo.path, ['status', '--porcelain=v1', '-z'])).stdout;
  if (reviewHeadAfter !== reviewHeadBefore || reviewStatusAfter !== reviewStatusBefore) {
    await unstageAll(worktreeInfo.path);
    await retryOrFail({ config, db, runId, taskId: task.id, attempts, error: 'Reviewer modified Git state or files; review must be read-only.' });
    return;
  }
  if (!reviewRun.ok || !reviewRun.output) {
    await unstageAll(worktreeInfo.path);
    await retryOrFail({ config, db, runId, taskId: task.id, attempts, error: `Reviewer failed: ${reviewRun.error ?? 'no structured output'}` });
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

/** 收集 worktree 当前未提交改动（status + 未跟踪文件清单 + diff），供厚重试上下文注入 */
async function collectWorktreeDiff(worktree: string): Promise<string> {
  try {
    const status = await git(worktree, ['status', '--porcelain=v1']);
    const diff = await git(worktree, ['diff']);
    const untracked = status.stdout.split('\n').filter((line) => line.startsWith('??')).map((line) => line.slice(3));
    return [
      `# git status (porcelain)\n${status.stdout.trim()}`,
      untracked.length > 0 ? `# untracked files\n${untracked.join('\n')}` : '',
      `# git diff\n${diff.stdout.trim()}`
    ].filter(Boolean).join('\n\n');
  } catch {
    return '';
  }
}

/** 读取上一次 worker 结果的 summary（文件缺失或损坏时静默省略） */
function readPreviousSummary(runDir: string, taskId: string, previousAttempt: number): string | undefined {
  if (previousAttempt < 1) return undefined;
  const path = join(runDir, 'results', `${taskId}-worker-${previousAttempt}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { summary?: unknown };
    return typeof parsed.summary === 'string' ? parsed.summary : undefined;
  } catch {
    return undefined;
  }
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
  backends: Record<string, AgentBackend>;
}): Promise<void> {
  const { config, db, runId } = input;
  const run = db.getRun(runId);
  const manifest = parseManifest(run.manifestJson);
  db.updateRun(runId, { status: 'integrating' });
  db.addEvent(runId, null, 'INTEGRATION_STARTED');
  const repoName = safeSegment(basename(config.repoRoot));
  const worktree = join(config.worktreesDir, repoName, safeSegment(runId), 'integration');
  const branch = `${config.branchPrefix}/${safeSegment(runId)}/integration`;
  await resetWorktree({ repoRoot: config.repoRoot, path: worktree, branch, baseSha: run.baseSha });
  db.updateRun(runId, { integrationBranch: branch, integrationWorktree: worktree });
  const runDir = join(config.stateDir, 'runs', runId);
  const integratorBinding = resolveAgentWithSnapshot('integrator', config, run.rolesJson);
  const integratorBackend = input.backends[integratorBinding.backend]!;

  for (const task of topologicalTasks(manifest.tasks)) {
    const record = db.getTask(runId, task.id);
    if (!record.commitSha) throw new Error(`Approved task ${task.id} has no commit`);
    const picked = await cherryPick(worktree, record.commitSha);
    if (picked.code === 0) continue;
    const conflicts = await conflictedFiles(worktree);
    if (conflicts.length === 0) throw new Error(`Cherry-pick failed for ${task.id}: ${picked.stderr}`);
    const conflictResult = await runAgent<IntegrationResult>({
      backend: integratorBackend,
      spec: {
        role: 'integrator', cwd: worktree,
        prompt: integrationPrompt({ manifest, integrationAllowedPaths: config.integration.allowedPaths, mode: 'resolve_conflict', worktreePath: worktree, conflictFiles: conflicts }),
        schema: INTEGRATION_SCHEMA,
        ...(integratorBinding.model !== undefined ? { model: integratorBinding.model } : {}),
        ...(integratorBinding.maxTurns !== undefined ? { maxTurns: integratorBinding.maxTurns } : {}),
        policy: integratorPolicy('resolve_conflict', config, conflicts),
        timeoutMs: config.taskTimeoutMs, staleAfterMs: config.staleAfterMs
      },
      logPath: join(runDir, 'logs', `integration-conflict-${task.id}.log`),
      outputPath: join(runDir, 'results', `integration-conflict-${task.id}.json`)
    });
    if (!conflictResult.ok || !conflictResult.output) {
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
    const integrationRun = await runAgent<IntegrationResult>({
      backend: integratorBackend,
      spec: {
        role: 'integrator', cwd: worktree,
        prompt: integrationPrompt({ manifest, integrationAllowedPaths: config.integration.allowedPaths, mode: 'finalize', worktreePath: worktree }),
        schema: INTEGRATION_SCHEMA,
        ...(integratorBinding.model !== undefined ? { model: integratorBinding.model } : {}),
        ...(integratorBinding.maxTurns !== undefined ? { maxTurns: integratorBinding.maxTurns } : {}),
        policy: integratorPolicy('finalize', config),
        timeoutMs: config.taskTimeoutMs, staleAfterMs: config.staleAfterMs
      },
      logPath: join(runDir, 'logs', 'integrator.log'),
      outputPath: join(runDir, 'results', 'integrator.json')
    });
    if (!integrationRun.ok || !integrationRun.output) throw new Error(`Integrator finalization failed: ${integrationRun.error ?? 'no structured output'}`);
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
