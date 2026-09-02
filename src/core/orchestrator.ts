import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  BackendId,
  ContractBlockReport,
  IntegrationResult,
  ReviewResult,
  ResolvedSkill,
  RunManifest,
  RunnerConfig,
  TaskRecord,
  TaskSpec,
  WorkerResult
} from './types.js';
import type { AgentBackend, AgentEvent } from '../agent/types.js';
import type { ApprovalHandler, UserInputHandler } from '../agent/approval.js';
import { StateDatabase } from './db.js';
import { buildBackends, disposeBackends, type BackendPool, resolveAgentWithSnapshot, resolveTaskAgent } from '../agent/registry.js';
import { executionInfo, runTrackedAgent, type AgentEventSink } from './agent-execution.js';
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

function taskSkills(record: TaskRecord): readonly ResolvedSkill[] {
  return JSON.parse(record.resolvedSkillsJson ?? '[]') as ResolvedSkill[];
}

function parseManifest(json: string | null): RunManifest {
  if (!json) throw new Error('Run has no manifest');
  return JSON.parse(json) as RunManifest;
}

export async function runOrchestrator(input: {
  config: RunnerConfig;
  db: StateDatabase;
  runId: string;
  requestApproval?: ApprovalHandler;
  requestUserInput?: UserInputHandler;
  onAgentEvent?: AgentEventSink;
  /** Optional outer-service hook for worker requests to change the execution contract. */
  reportContractBlock?: (report: ContractBlockReport) => void | Promise<void>;
  signal?: AbortSignal | undefined;
  /** Test seam: production creates its own managed backend pool. */
  backends?: Record<BackendId, AgentBackend> | BackendPool | undefined;
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
  const backends = input.backends ?? buildBackends(config);
  // Child backends own process groups, so release them explicitly on terminal interruption.
  const active = new Map<string, Promise<void>>();
  const interruptedTasks = new Set<string>();
  let interrupted = false;
  let interruptionMessage = 'Interrupted by user; run again to resume.';
  const interruptRun = (message: string, setExitCode: boolean): void => {
    if (interrupted) return;
    interrupted = true;
    interruptionMessage = message;
    if (setExitCode) process.exitCode = 130;
    for (const taskId of active.keys()) interruptedTasks.add(taskId);
    db.addEvent(runId, null, 'RUN_INTERRUPTED');
    db.updateRun(runId, { status: 'running', error: message });
    disposeBackends(backends);
  };
  const onSignal = (): void => { interruptRun('Interrupted by user; run again to resume.', true); };
  const onAbort = (): void => { interruptRun('Interrupted by daemon; run again to resume.', false); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.once('SIGHUP', onSignal);
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  try {
    while (true) {
      if (interrupted) return;
      const tasks = db.listTasks(runId);
      const approved = new Set(tasks.filter((task) => task.status === 'approved').map((task) => task.taskId));
      const terminalProblem = tasks.find((task) => ['blocked', 'blocked_on_contract', 'failed'].includes(task.status));
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
        const promise = executeTask({
          config, db, runId, backends, record: candidate,
            signal: input.signal,
            ...(input.requestApproval ? { requestApproval: input.requestApproval } : {}),
            ...(input.requestUserInput ? { requestUserInput: input.requestUserInput } : {}),
            ...(input.onAgentEvent ? { onAgentEvent: input.onAgentEvent } : {}),
            ...(input.reportContractBlock ? { reportContractBlock: input.reportContractBlock } : {})
        })
          .catch((error) => {
            db.updateTask(runId, candidate.taskId, {
              status: 'failed', phase: 'exception', lastError: String(error), finishedAt: new Date().toISOString()
            });
            db.addEvent(runId, candidate.taskId, 'TASK_EXCEPTION', { error: String(error) });
          })
          .finally(() => active.delete(candidate.taskId));
        active.set(candidate.taskId, promise);
      }

      if (active.size === 0) {
        const blockedByGraph = db.listTasks(runId).filter((task) => !['approved', 'failed', 'blocked', 'blocked_on_contract'].includes(task.status));
        if (blockedByGraph.length > 0) {
          db.updateRun(runId, { status: 'needs_attention', error: 'No runnable tasks remain; inspect dependency and task states.' });
          return;
        }
      } else {
        await Promise.race(active.values());
      }
    }

    if (interrupted) return;
    await integrateRun({
      config, db, runId, backends,
      isInterrupted: () => interrupted,
      signal: input.signal,
      ...(input.requestApproval ? { requestApproval: input.requestApproval } : {}),
      ...(input.requestUserInput ? { requestUserInput: input.requestUserInput } : {}),
      ...(input.onAgentEvent ? { onAgentEvent: input.onAgentEvent } : {})
    });
  } catch (error) {
    if (interrupted) return;
    db.updateRun(runId, { status: 'failed', error: String(error), finishedAt: new Date().toISOString() });
    db.addEvent(runId, null, 'RUN_FAILED', { error: String(error) });
    throw error;
  } finally {
    await Promise.allSettled(active.values());
    if (interrupted) {
      for (const taskId of interruptedTasks) {
        const task = db.getTask(runId, taskId);
        if (task.status === 'approved') continue;
        db.updateTask(runId, taskId, {
          status: 'changes_requested', phase: 'interrupted',
          attempts: Math.max(0, task.attempts - 1),
          lastError: `${interruptionMessage.replace('; run again to resume.', '')}; the next run will discard this attempt and start a clean session.`, finishedAt: null
        });
      }
    }
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    process.off('SIGHUP', onSignal);
    input.signal?.removeEventListener('abort', onAbort);
    disposeBackends(backends);
    run = db.getRun(runId);
    if (run.status === 'done') db.addEvent(runId, null, 'RUN_COMPLETED');
  }
}

async function executeTask(input: {
  config: RunnerConfig;
  db: StateDatabase;
  runId: string;
  backends: Record<BackendId, AgentBackend> | BackendPool;
  record: TaskRecord;
  requestApproval?: ApprovalHandler;
  requestUserInput?: UserInputHandler;
  onAgentEvent?: AgentEventSink;
  reportContractBlock?: (report: ContractBlockReport) => void | Promise<void>;
  signal?: AbortSignal | undefined;
}): Promise<void> {
  const { config, db, runId, backends } = input;
  let record = db.getTask(runId, input.record.taskId);
  const task = taskSpec(record);
  const run = db.getRun(runId);
  const runDir = join(config.workspace.stateDir, 'runs', runId);
  // Worker：任务的 task.agent 优先（连带 model），否则用创建运行时固化的角色快照（回退当前 config）。
  const workerBinding = resolveTaskAgent(task, config, run.rolesJson);
  const worktreeInfo = await ensureTaskWorktree({ config, db, runId, record, task, manifest: parseManifest(run.manifestJson) });
  record = db.getTask(runId, task.id);
  const attempts = record.attempts + 1;
  db.updateTask(runId, task.id, { status: 'running', phase: 'worker', attempts });
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
  const workerExecution = executionInfo(runId, `${task.id}-worker-${attempts}`, 'worker', workerBinding.backend, logPath, workerBinding.model, task.id);
  const worker = await runTrackedAgent<WorkerResult>({
    db,
    execution: workerExecution,
    signal: input.signal,
    ...(input.onAgentEvent ? { onAgentEvent: input.onAgentEvent } : {}),
    backend: await getBackend(backends, workerBinding),
    spec: {
      role: 'worker', cwd: worktreeInfo.path,
      label: `${runId} ${task.id} worker`,
      taskId: task.id,
      prompt: workerPrompt({ task, startSha: worktreeInfo.startSha, runId, worktreePath: worktreeInfo.path, priorFeedback: record.lastError, retry, skills: taskSkills(record) }),
      schema: WORKER_SCHEMA,
      ...(workerBinding.model !== undefined ? { model: workerBinding.model } : {}),
      ...(workerBinding.maxTurns !== undefined ? { maxTurns: workerBinding.maxTurns } : {}),
      access: 'workspace-write',
      requestApproval: input.requestApproval,
      requestUserInput: input.requestUserInput,
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
  if (workerResult.status === 'blocked_on_contract') {
    const finishedAt = new Date().toISOString();
    db.updateTask(runId, task.id, { status: 'blocked_on_contract', phase: 'worker', lastError: workerResult.contractBlock!.message, finishedAt });
    db.addEvent(runId, task.id, 'WORKER_BLOCKED_ON_CONTRACT', workerResult);
    if (input.reportContractBlock) {
      try {
        await input.reportContractBlock({
          run,
          task: db.getTask(runId, task.id),
          agentExecution: db.getAgentExecution(runId, workerExecution.agentId),
          reason: workerResult.contractBlock!
        });
      } catch (error) {
        db.addEvent(runId, task.id, 'WORKER_CONTRACT_BLOCK_REPORT_FAILED', { error: String(error) });
      }
    }
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
  const candidateDiff = (await git(worktreeInfo.path, ['diff', '--cached', '--binary'])).stdout;
  // Reviewer 独立解析角色绑定（运行快照优先），不复用 Worker 的会话。
  const reviewerBinding = resolveAgentWithSnapshot('reviewer', config, run.rolesJson);
  const reviewLogPath = join(runDir, 'logs', `${task.id}-review-${reviewCycle}.log`);
  const reviewRun = await runTrackedAgent<ReviewResult>({
    db,
    execution: executionInfo(runId, `${task.id}-reviewer-${reviewCycle}`, 'reviewer', reviewerBinding.backend, reviewLogPath, reviewerBinding.model, task.id),
    signal: input.signal,
    ...(input.onAgentEvent ? { onAgentEvent: input.onAgentEvent } : {}),
    backend: await getBackend(backends, reviewerBinding),
    spec: {
      role: 'reviewer', cwd: worktreeInfo.path,
      label: `${runId} ${task.id} reviewer`,
      taskId: task.id,
      prompt: reviewerPrompt({
        task,
        startSha: worktreeInfo.startSha,
        worktreePath: worktreeInfo.path,
        workerResult,
        candidateDiff,
        candidateFiles: verification.changedFiles,
        skills: taskSkills(record)
      }),
      schema: REVIEW_SCHEMA,
      ...(reviewerBinding.model !== undefined ? { model: reviewerBinding.model } : {}),
      ...(reviewerBinding.maxTurns !== undefined ? { maxTurns: reviewerBinding.maxTurns } : {}),
      access: 'read-only',
      requestApproval: input.requestApproval,
      requestUserInput: input.requestUserInput,
      timeoutMs: config.taskTimeoutMs, staleAfterMs: config.staleAfterMs
    },
    logPath: reviewLogPath,
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
    if (reviewCycle >= config.retry.maxReviewCycles) {
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
  if (input.attempts >= input.config.retry.maxWorkerAttempts) {
    input.db.updateTask(input.runId, input.taskId, {
      status: 'failed', phase: 'retry-limit', lastError: input.error, finishedAt: new Date().toISOString()
    });
    input.db.addEvent(input.runId, input.taskId, 'WORKER_RETRY_LIMIT_REACHED', { error: input.error });
  } else {
    input.db.updateTask(input.runId, input.taskId, {
      status: 'changes_requested', phase: 'retry', lastError: input.error
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
    if (input.record.phase === 'interrupted' || input.record.phase === 'recovered') {
      if (!input.record.branch) throw new Error(`Interrupted task ${input.task.id} has no worktree branch`);
      await resetWorktree({
        repoRoot: input.config.workspace.repoRoot,
        path: input.record.worktree,
        branch: input.record.branch,
        baseSha: input.record.startSha
      });
      input.db.addEvent(input.runId, input.task.id, 'INTERRUPTED_WORKTREE_RESET', {
        path: input.record.worktree,
        startSha: input.record.startSha
      });
    }
    return { path: input.record.worktree, startSha: input.record.startSha };
  }
  const run = input.db.getRun(input.runId);
  const repoName = safeSegment(basename(input.config.workspace.repoRoot));
  const path = join(input.config.workspace.worktreesDir, repoName, safeSegment(input.runId), input.task.id);
  const branch = `${input.config.workspace.branchPrefix}/${safeSegment(input.runId)}/${input.task.id}`;
  await createWorktree({ repoRoot: input.config.workspace.repoRoot, path, branch, baseSha: run.baseSha });
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
  backends: Record<BackendId, AgentBackend> | BackendPool;
  requestApproval?: ApprovalHandler;
  requestUserInput?: UserInputHandler;
  onAgentEvent?: AgentEventSink;
  isInterrupted: () => boolean;
  signal?: AbortSignal | undefined;
}): Promise<void> {
  const { config, db, runId } = input;
  const run = db.getRun(runId);
  const manifest = parseManifest(run.manifestJson);
  db.updateRun(runId, { status: 'integrating' });
  db.addEvent(runId, null, 'INTEGRATION_STARTED');
  const repoName = safeSegment(basename(config.workspace.repoRoot));
  const worktree = join(config.workspace.worktreesDir, repoName, safeSegment(runId), 'integration');
  const contractBranch = typeof run.executionContractJson === 'string'
    ? (JSON.parse(run.executionContractJson) as { target?: { integrationBranch?: string } }).target?.integrationBranch
    : undefined;
  const branch = contractBranch ?? `${config.workspace.branchPrefix}/${safeSegment(runId)}/integration`;
  await resetWorktree({ repoRoot: config.workspace.repoRoot, path: worktree, branch, baseSha: run.baseSha });
  db.updateRun(runId, { integrationBranch: branch, integrationWorktree: worktree });
  const runDir = join(config.workspace.stateDir, 'runs', runId);

  for (const task of topologicalTasks(manifest.tasks)) {
    if (input.isInterrupted()) return;
    const record = db.getTask(runId, task.id);
    if (!record.commitSha) throw new Error(`Approved task ${task.id} has no commit`);
    const picked = await cherryPick(worktree, record.commitSha);
    if (picked.code === 0) continue;
    const conflicts = await conflictedFiles(worktree);
    if (conflicts.length === 0) throw new Error(`Cherry-pick failed for ${task.id}: ${picked.stderr}`);
    const integratorBinding = resolveAgentWithSnapshot('integrator', config, run.rolesJson);
    const integratorBackend = await getBackend(input.backends, integratorBinding);
    const conflictLogPath = join(runDir, 'logs', `integration-conflict-${task.id}.log`);
    const conflictResult = await runTrackedAgent<IntegrationResult>({
      db,
      execution: executionInfo(runId, `integrator-conflict-${task.id}`, 'integrator', integratorBinding.backend, conflictLogPath, integratorBinding.model, task.id),
      signal: input.signal,
      ...(input.onAgentEvent ? { onAgentEvent: input.onAgentEvent } : {}),
      backend: integratorBackend,
      spec: {
        role: 'integrator', cwd: worktree,
        label: `${runId} integrator conflict ${task.id}`,
        taskId: task.id,
        prompt: integrationPrompt({ manifest, worktreePath: worktree, conflictFiles: conflicts, skills: taskSkills(record) }),
        schema: INTEGRATION_SCHEMA,
        ...(integratorBinding.model !== undefined ? { model: integratorBinding.model } : {}),
        ...(integratorBinding.maxTurns !== undefined ? { maxTurns: integratorBinding.maxTurns } : {}),
        access: 'workspace-write',
        requestApproval: input.requestApproval,
        requestUserInput: input.requestUserInput,
        timeoutMs: config.taskTimeoutMs, staleAfterMs: config.staleAfterMs
      },
      logPath: conflictLogPath,
      outputPath: join(runDir, 'results', `integration-conflict-${task.id}.json`)
    });
    if (input.isInterrupted()) return;
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
  if (input.isInterrupted()) return;
  const integrationCommit = await currentHead(worktree);
  db.updateRun(runId, { status: 'done', integrationCommit, error: null, finishedAt: new Date().toISOString() });
  db.addEvent(runId, null, 'INTEGRATION_COMPLETED', { branch, worktree, integrationCommit });
  writeFileSync(join(runDir, 'summary.txt'), `Run ${runId} completed\nBranch: ${branch}\nCommit: ${integrationCommit}\n`, 'utf8');
}

async function getBackend(
  backends: Record<BackendId, AgentBackend> | BackendPool,
  binding: import('./types.js').AgentBinding
): Promise<AgentBackend> {
  if (typeof (backends as Partial<BackendPool>).get === 'function') return await (backends as BackendPool).get(binding);
  return (backends as Record<BackendId, AgentBackend>)[binding.backend]!;
}
