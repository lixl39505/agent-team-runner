// Execution lifecycle: worktree workspace creation, pane/agent startup,
// brief injection and prompt dispatch. prompt_sent_at is set ONLY here and
// is the single guard against re-prompting a recoverable execution.

import type { SqliteDb } from '../store/db.ts';
import { insertExecution, updateExecution, listExecutions, type ExecutionPatch } from '../store/executions.ts';
import { insertResource, listActiveResources } from '../store/resources.ts';
import { updateTask, getTask, type TaskPatch } from '../store/tasks.ts';
import { addEvent } from '../store/events.ts';
import { agentName, newExecutionId, nowIso, taskBranch } from '../store/ids.ts';
import type { AteamHome } from '../config.ts';
import { resolveAgentEntry, type AgentEntry, type AteamConfig } from '../config.ts';
import type { HerdrRuntimeClient } from '../herdr/client.ts';
import { HerdrError } from '../herdr/types.ts';
import { agentStartArgs } from '../herdr/agent-args.ts';
import { buildRolePrompt } from '../results/prompts.ts';
import { resultPathFor, sha256Hex } from '../results/files.ts';
import { resolveSkills, writeBrief } from './briefs.ts';
import { cherryPick, revParse } from '../core/git.ts';
import { topologicalTasks } from '../core/contract.ts';
import type { AgentKind, ExecutionContract, ExecutionRecord, ExecutionRole, TaskRecord } from '../core/types.ts';

export interface RunnerEnv {
  home: AteamHome;
  db: SqliteDb;
  client: HerdrRuntimeClient;
  config: AteamConfig;
  runId: string;
  contract: ExecutionContract;
}

const MAX_PROMPT_CHARS = 8000;

/** Pick a reviewer entry whose kind differs from the worker's (ADR: 跨模型复核). */
export function resolveReviewerEntry(config: AteamConfig, workerKind: AgentKind): AgentEntry {
  const preferred = config.agents[config.roles.reviewer];
  if (preferred && preferred.kind !== workerKind) return preferred;
  for (const entry of Object.values(config.agents)) {
    if (entry.kind !== workerKind) return entry;
  }
  throw new HerdrError(
    'herdr_error',
    `no agent with kind != ${workerKind} available for cross-model review`,
  );
}

function roleSeq(role: ExecutionRole, attemptNo: number, cycleNo: number): number {
  return role === 'reviewer' ? cycleNo : attemptNo;
}

/** Allocate a unique Herdr agent name, backing off on collisions. */
async function allocateAgent(env: RunnerEnv, taskId: string, role: ExecutionRole, attemptNo: number, cycleNo: number): Promise<string> {
  for (let salt = 0; salt < 5; salt++) {
    const candidate = salt === 0
      ? agentName(env.runId, taskId, role, roleSeq(role, attemptNo, cycleNo))
      : agentName(env.runId, taskId, role, roleSeq(role, attemptNo, cycleNo) * 10 + salt);
    const taken = listExecutions(env.db, env.runId).some((e) => e.agentName === candidate);
    if (!taken) return candidate;
  }
  throw new HerdrError('herdr_error', `cannot allocate unique agent name for ${taskId}/${role}`);
}

async function closePaneSafe(client: HerdrRuntimeClient, paneId: string | null): Promise<void> {
  if (!paneId) return;
  try {
    await client.closePane(paneId);
  } catch (err) {
    if (!(err instanceof HerdrError && err.code === 'not_found')) throw err;
  }
}

export { closePaneSafe };

/** Create (once) and return the task's worktree workspace mapping. */
export async function ensureTaskWorktree(env: RunnerEnv, task: TaskRecord): Promise<TaskRecord> {
  if (task.branch && task.worktreePath && task.workspaceId) return task;
  const branch = taskBranch(env.runId, task.taskId);
  const sourceWorkspaceId = await findSourceWorkspaceId(env);
  const handle = await env.client.createWorktreeWorkspace({
    sourceWorkspaceId,
    branch,
    label: `${env.runId}/${task.taskId}`,
    focus: false,
  });
  insertResource(env.db, {
    runId: env.runId, taskId: task.taskId, kind: 'workspace', herdrId: handle.workspace.workspaceId,
    branch, path: handle.worktree.path,
  });
  insertResource(env.db, {
    runId: env.runId, taskId: task.taskId, kind: 'pane', herdrId: handle.rootPane.paneId,
  });
  // inject dependency commits so this worktree builds on integrated deps
  for (const depId of task.spec.dependsOn ?? []) {
    const dep = getTask(env.db, env.runId, depId);
    if (dep?.commitSha) {
      const res = await cherryPick(handle.worktree.path, dep.commitSha);
      if (!res.ok) throw new Error(`dependency ${depId} cherry-pick into ${task.taskId} worktree conflicted unexpectedly`);
    }
  }
  const patch: TaskPatch = { branch, worktreePath: handle.worktree.path, workspaceId: handle.workspace.workspaceId };
  updateTask(env.db, env.runId, task.taskId, patch);
  return getTask(env.db, env.runId, task.taskId)!;
}

/** The workspace whose repo the run is bound to: a previous task workspace,
 * else the Runner's own Herdr workspace, else an explicit override. */
async function findSourceWorkspaceId(env: RunnerEnv): Promise<string> {
  const resources = listActiveResources(env.db, env.runId).filter((r) => r.kind === 'workspace');
  const first = resources[0];
  if (first) return first.herdrId;
  const herdrWorkspace = process.env.HERDR_WORKSPACE_ID ?? process.env.ATEAM_SOURCE_WORKSPACE_ID;
  if (herdrWorkspace) return herdrWorkspace;
  throw new HerdrError(
    'herdr_error',
    'no source workspace for worktree creation — start the Runner inside a Herdr workspace (HERDR_WORKSPACE_ID) or set ATEAM_SOURCE_WORKSPACE_ID',
  );
}

export interface StartExecutionInput {
  role: ExecutionRole;
  task: TaskRecord;
  attemptNo: number;
  cycleNo: number;
  entry: AgentEntry;
  retry?: { lastWorkerSummary?: string; lastReview?: unknown };
  /** Override for integrator runs in the shared integration worktree. */
  targetWorktree?: { path: string; rootPaneId: string };
  notes?: string;
}

export async function startExecution(env: RunnerEnv, input: StartExecutionInput) {
  const { task } = input;
  const worktreePath = input.targetWorktree?.path ?? (await ensureTaskWorktree(env, task)).worktreePath!;
  const attemptNo = input.attemptNo;
  const cycleNo = input.cycleNo;
  const executionId = newExecutionId(env.runId, task.taskId, input.role, attemptNo, cycleNo);
  const name = await allocateAgent(env, task.taskId, input.role, attemptNo, cycleNo);
  const resultPath = resultPathFor(env.home.root, env.runId, task.taskId, input.role, attemptNo, cycleNo);
  const startSha = await revParse(worktreePath, 'HEAD');
  const skills = await resolveSkills(env.contract.project.repoRoot, task.spec.implementationSkills);

  if (!input.targetWorktree && task.startSha === null) {
    updateTask(env.db, env.runId, task.taskId, { startSha });
  }

  await writeBrief({
    role: input.role,
    runId: env.runId,
    contract: env.contract,
    task: task.spec,
    startSha,
    worktreePath,
    resultPath,
    retry: input.retry,
    notes: input.notes,
    skills,
  });

  // Dispatch protocol (review 01 #12): the execution row — including the
  // prompt digest — is persisted BEFORE any Herdr call, so a crash leaves a
  // resumable `starting` record instead of an invisible half-dispatch.
  const prompt = buildRolePrompt({
    role: input.role,
    runId: env.runId,
    taskId: task.taskId,
    attemptNo,
    cycleNo,
    worktreePath,
    resultPath,
  });
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt for ${executionId} exceeds ${MAX_PROMPT_CHARS} chars — brief overflow`);
  }
  insertExecution(env.db, {
    id: executionId,
    runId: env.runId,
    taskId: task.taskId,
    role: input.role,
    attemptNo,
    cycleNo,
    agentName: name,
    agentKind: input.entry.kind,
    model: input.entry.model ?? null,
    status: 'starting',
    promptSentAt: null,
    promptDigest: sha256Hex(prompt),
    resultPath,
    nativeSessionRef: null,
    paneId: null,
    tabId: null,
    workspaceId: null,
    paneState: 'open',
    lastAgentState: null,
    startedAt: nowIso(),
    finishedAt: null,
  });

  const rootPaneId = input.targetWorktree?.rootPaneId ?? findRootPaneId(env, task.taskId);
  // split panes live on the execution row only — pane resources are reserved
  // for workspace ROOT panes (the stable split source)
  const pane = await env.client.splitPane({ paneId: rootPaneId, direction: 'right', label: `${task.taskId}:${input.role}` });
  updateExecution(env.db, executionId, { paneId: pane.paneId, tabId: pane.tabId, workspaceId: pane.workspaceId });

  await env.client.startAgent({
    name,
    kind: input.entry.kind,
    paneId: pane.paneId,
    args: agentStartArgs(input.entry),
  });

  await env.client.promptAgent({ target: name, text: prompt, wait: false, until: [], timeoutMs: 5000 });
  updateExecution(env.db, executionId, { promptSentAt: nowIso(), status: 'running' });
  addEvent(env.db, env.runId, 'EXECUTION_PROMPTED', {
    taskId: task.taskId,
    executionId,
    payload: { role: input.role, attemptNo, cycleNo, agentName: name, agentKind: input.entry.kind },
  });
  return getExecutionRow(env, executionId);
}

/** Rebuild the deterministic role prompt for an execution whose dispatch was
 * interrupted (status 'starting'). Returns null when the inputs no longer
 * reproduce the persisted prompt digest — that needs a human, not a guess. */
export function rebuildRolePrompt(
  env: RunnerEnv,
  exec: ExecutionRecord,
  worktreePath: string,
): string | null {
  const prompt = buildRolePrompt({
    role: exec.role,
    runId: env.runId,
    taskId: exec.taskId,
    attemptNo: exec.attemptNo,
    cycleNo: exec.cycleNo,
    worktreePath,
    resultPath: exec.resultPath ?? '',
  });
  if (exec.promptDigest && sha256Hex(prompt) !== exec.promptDigest) return null;
  return prompt;
}

function getExecutionRow(env: RunnerEnv, executionId: string) {
  const row = listExecutions(env.db, env.runId).find((e) => e.id === executionId);
  if (!row) throw new Error(`execution vanished: ${executionId}`);
  return row;
}

/** The workspace root pane of a task — newest registration wins (older
 * registrations may belong to worktrees lost to a Herdr restart). */
export function findRootPaneId(env: RunnerEnv, taskId: string): string {
  const panes = listActiveResources(env.db, env.runId).filter((r) => r.kind === 'pane' && r.taskId === taskId);
  const root = panes.at(-1);
  if (!root) throw new HerdrError('not_found', `no root pane recorded for task ${taskId}`);
  return root.herdrId;
}

export function nextAttemptNumber(task: TaskRecord): number {
  return task.attempts + 1;
}
