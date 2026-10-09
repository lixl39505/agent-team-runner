// Reclaim state machine (ADR 0001 临时资源回收): close panes → remove the
// Herdr worktree workspace → confirm the branch is free → delete the task
// branch → finalize. Every step is audited and safely retryable — retries
// confirm postconditions against the authoritative state (resource already
// gone, branch already deleted) and record success instead of failing
// forever (review 01 #11). Only ATeam-provenanced resources are touched.

import { latestCleanupSteps, recordCleanupStep } from '../store/cleanup.ts';
import { getResource, getResourceForRun, listActiveResources, markResourceState } from '../store/resources.ts';
import { updateTask, listTasks, getTask } from '../store/tasks.ts';
import { getRun } from '../store/runs.ts';
import { listExecutions, updateExecution } from '../store/executions.ts';
import { hasPassingFinalVerification, type FinalVerificationExpectation } from '../store/verifications.ts';
import { addEvent } from '../store/events.ts';
import { branchExists, worktreeBranches, deleteBranchIfFree, currentHead } from '../core/git.ts';
import { existsSync } from 'node:fs';
import { HerdrError } from '../herdr/types.ts';
import { LeaseLostError } from '../core/errors.ts';
import type { CleanupStep, TaskRecord } from '../core/types.ts';
import { closePaneSafe, type RunnerEnv } from './executions.ts';

/** R5-04: heartbeat cadence while an irreversible Herdr/Git operation runs —
 * well inside the 30s lease staleness window. */
const LEASE_HEARTBEAT_MS = 10_000;

/**
 * R5-04: run one irreversible operation while heartbeating the fence, so a
 * Herdr/Git call that outlives the lease keeps renewing it — and if another
 * writer takes over ANYWAY, the loss is raised when the operation returns:
 * the step records nothing and the new owner re-runs it idempotently.
 * R6-06: the loss is raised when the operation RETURNS OR THROWS — a failed
 * operation must not launder a lost lease into "my failure to record".
 */
async function fencedOperation<T>(ensureLease: (() => void) | undefined, op: () => Promise<T>): Promise<T> {
  if (!ensureLease) return op();
  let lost: Error | null = null;
  const timer = setInterval(() => {
    if (lost) return;
    try {
      ensureLease();
    } catch (err) {
      lost = err instanceof Error ? err : new Error(String(err));
    }
  }, LEASE_HEARTBEAT_MS);
  try {
    const result = await op();
    if (lost) throw lost;
    return result;
  } catch (err) {
    if (lost) throw lost; // R6-06: the fence loss wins over the op's own error
    throw err;
  } finally {
    clearInterval(timer);
  }
}

async function runStep(
  env: RunnerEnv,
  task: TaskRecord,
  step: CleanupStep,
  exec: () => Promise<void>,
  extra: { branch?: string | null; worktreePath?: string | null; workspaceId?: string | null } = {},
  ensureLease?: () => void,
): Promise<boolean> {
  const { db, runId } = env;
  const latest = latestCleanupSteps(db, runId, task.taskId).get(step);
  if (latest?.status === 'ok') return true;
  try {
    await fencedOperation(ensureLease, exec);
    // R5-04: the fence must still be ours after the operation too — the
    // audit/status writes below are the step's conclusion and a stale writer
    // must not record one
    ensureLease?.();
    recordCleanupStep(db, {
      runId, taskId: task.taskId, step, status: 'ok',
      branch: task.branch, worktreePath: task.worktreePath, workspaceId: task.workspaceId,
      finalCommit: task.integrationCommit, ...extra,
    });
    addEvent(db, runId, 'CLEANUP_STEP_OK', { taskId: task.taskId, payload: { step } });
    return true;
  } catch (err) {
    // R5-04: a lost fence aborts BEFORE any audit write — the new owner
    // re-runs the step against the authoritative state instead of inheriting
    // a conclusion written by a dispossessed process
    if (err instanceof LeaseLostError) throw err;
    // R6-06: the FAILURE conclusion is audited too — re-prove the fence
    // before recording it, or a dispossessed writer and the new owner could
    // leave contradictory cleanup verdicts behind
    try {
      ensureLease?.();
    } catch (fenceErr) {
      throw fenceErr instanceof Error ? fenceErr : new Error(String(fenceErr));
    }
    recordCleanupStep(db, {
      runId, taskId: task.taskId, step, status: 'failed',
      branch: task.branch, worktreePath: task.worktreePath, workspaceId: task.workspaceId,
      detail: { error: String(err) }, ...extra,
    });
    addEvent(db, runId, 'CLEANUP_STEP_FAILED', { taskId: task.taskId, payload: { step, error: String(err) } });
    return false;
  }
}

export interface CleanupOptions {
  /**
   * Explicit operator override (`clean --discard-work`, review 02 R2-03):
   * DESTROY unverified delivery resources as an audited discard — the task
   * ends `discarded`, never `reclaimed`, so an unverified resource is never
   * counted as a normal reclamation. The Runner's own cleanup path never
   * sets this (ADR: 终验与提交持久化后才可回收).
   */
  discardUnverified?: boolean;
  /**
   * R4-05: fence renewal between irreversible steps (token-CAS heartbeat).
   * Called before EVERY cleanup step; throwing aborts the reclamation
   * mid-sweep so a dispossessed writer never keeps destroying.
   */
  ensureLease?: () => void;
}

/**
 * A reclamation ends `reclaimed` (verified delivery), `discarded` (audited
 * operator override), or null (not eligible / a step failed — retry later).
 */
export type CleanupOutcome = 'reclaimed' | 'discarded' | null;

/**
 * A cleanup may only ever touch the branch THIS run created
 * (`ateam/<runId>/…`). Review 02 R2-04 / review 03 R3-02: git operations run
 * against the run row's IMMUTABLE repo binding — never against a contract
 * revision, whose latest submitted version may be a rejected candidate that
 * moved the binding. The runId-scoped prefix is the provenance proof
 * (branches are minted by taskBranch()/integrationBranch() with exactly
 * this shape).
 */
function assertRunBranch(runId: string, branch: string): void {
  if (!branch.startsWith(`ateam/${runId}/`)) {
    throw new Error(`branch ${branch} is not a resource of run ${runId}; refusing to clean it`);
  }
}

/**
 * R3-07: did THIS execution conclude successfully? The execution row reads
 * `completed` for ANY consumed result — including a worker `failed` or a
 * reviewer `changes_requested` verdict — so the role result payload's own
 * status is the closing criterion, not the row's lifecycle status.
 */
function executionConcludedSuccessfully(exec: { status: string; resultDigest: string | null; result: unknown }): boolean {
  if (exec.status !== 'completed' || !exec.resultDigest) return false;
  const status = (exec.result as { status?: string } | null | undefined)?.status;
  return status === 'completed' || status === 'approved';
}

/**
 * Does the persisted final PASS still describe the CURRENT delivery
 * (review 03 R3-04)? It must carry the accepted contract revision, match the
 * live integration HEAD, and cover exactly the task integration commits on
 * the ledger. A stale conclusion does NOT authorize reclamation — the engine
 * re-runs the final gate instead.
 */
export async function finalPassMatchesDelivery(env: RunnerEnv): Promise<boolean> {
  const run = getRun(env.db, env.runId);
  if (!run?.finalVerified) return false;
  const expected: FinalVerificationExpectation = { contractRevision: run.acceptedRevision };
  const integratedCommits: Record<string, string> = {};
  for (const t of listTasks(env.db, env.runId)) {
    if (['integrated', 'reclaimed'].includes(t.status) && t.integrationCommit) {
      integratedCommits[t.taskId] = t.integrationCommit;
    }
  }
  expected.integratedCommits = integratedCommits;
  // the HEAD check applies while the integration worktree still exists;
  // once reclaimed, revision + task set are the remaining bindings
  if (run.integrationPath) {
    if (!existsSync(run.integrationPath)) {
      // R4-06: a MISSING integration tree cannot prove the delivered HEAD.
      // While integrated tasks still await reclamation the old PASS must not
      // authorize destroying their worktrees — recover/re-verify the tree
      // first. After every task is reclaimed the persisted final commit set
      // is the remaining binding and the check below suffices.
      const pending = listTasks(env.db, env.runId).some((t) => t.status === 'integrated');
      if (pending) return false;
    } else {
      const head = await currentHead(run.integrationPath).catch(() => null);
      if (!head) return false; // an unreadable tree is not a verified tree
      expected.headSha = head;
    }
  }
  return hasPassingFinalVerification(env.db, env.runId, expected);
}

/**
 * R4-03/R5-02: herdr reuses short workspace ids after server restarts — a
 * ledger row (or run field) only proves this run ONCE held the id. Before a
 * FORCE removal the identity must be PROVEN, never assumed: an ACTIVE,
 * ATeam-provenanced ledger row in THIS run of the CALLER'S OWN GENERATION AND
 * an authoritative snapshot that maps the id to a workspace whose worktree
 * path, branch AND repo root are all present and exactly equal to the
 * ledgered/binding values. Any missing field or mismatch = no proof =
 * refuse, fail-closed. Absent from the snapshot = already gone (the
 * postcondition holds); an unreachable snapshot = refuse.
 *
 * R6-01: the generation binding is exact, not "not some other task" — within
 * one run insertResource follows a REUSED id to its newest identity, so a
 * task deletion requires the row to be ledgered to THAT task (never null =
 * the integration) and to the task's own worktree binding, and an
 * integration deletion requires a task-less row matching the run's
 * integration binding. A row of the wrong generation is a refusal even when
 * its path/branch happen to match the live snapshot.
 */
export async function assertRemovableWorkspace(
  env: RunnerEnv,
  workspaceId: string,
  opts: { taskId?: string | null } = {},
): Promise<void> {
  const { db, runId, client } = env;
  const mine = getResourceForRun(db, runId, 'workspace', workspaceId);
  if (!mine || !mine.provenance || mine.state !== 'active') {
    // R5-02: no active provenanced row in this run = no identity evidence.
    // "Some other run holds it" and "nobody holds it" are BOTH refusals —
    // force-removing an id this run cannot prove is never acceptable.
    const other = getResource(db, 'workspace', workspaceId);
    throw new Error(
      other && other.runId !== runId
        ? `workspace ${workspaceId} is ledgered to run ${other.runId}; refusing to remove it for run ${runId}`
        : `no active provenanced ledger row for workspace ${workspaceId} in run ${runId}; refusing to force-remove an identity this run cannot prove`,
    );
  }
  // R6-01: bind the ledger row to the caller's generation and derive the
  // path/branch the row must carry from that same binding
  let expectedPath: string | null | undefined;
  let expectedBranch: string | null | undefined;
  if (opts.taskId) {
    if (mine.taskId !== opts.taskId) {
      throw new Error(
        mine.taskId === null
          ? `workspace ${workspaceId} is ledgered to the run integration, not task ${opts.taskId}; refusing to remove it as a task workspace`
          : `workspace ${workspaceId} is ledgered to task ${mine.taskId}, not ${opts.taskId}; refusing to remove it`,
      );
    }
    const task = getTask(db, runId, opts.taskId);
    if (!task) throw new Error(`task ${opts.taskId} has no ledger row; refusing to remove workspace ${workspaceId} for it`);
    expectedPath = task.worktreePath;
    expectedBranch = task.branch;
  } else {
    if (mine.taskId !== null) {
      throw new Error(`workspace ${workspaceId} is ledgered to task ${mine.taskId}; refusing to remove it as the run integration workspace`);
    }
    const run = getRun(db, runId);
    expectedPath = run?.integrationPath;
    expectedBranch = run?.integrationBranch;
  }
  const snap = await client.snapshot().catch(() => null);
  if (!snap) {
    throw new Error(`herdr snapshot unavailable; cannot confirm workspace ${workspaceId} identity before removal (retry when the runtime is reachable)`);
  }
  const live = snap.workspaces.find((w) => w.workspaceId === workspaceId);
  if (!live) return; // already removed — the postcondition holds
  const repoRoot = getRun(db, runId)?.repoRoot;
  const mismatches: string[] = [];
  if (!expectedPath) mismatches.push('no worktree path bound for this generation');
  else if (mine.path !== expectedPath) mismatches.push(`ledger path ${mine.path ?? '-'} != bound ${expectedPath}`);
  if (!expectedBranch) mismatches.push('no branch bound for this generation');
  else if (mine.branch !== expectedBranch) mismatches.push(`ledger branch ${mine.branch ?? '-'} != bound ${expectedBranch}`);
  if (!live.worktree?.path || !live.worktree?.branch) {
    mismatches.push('live snapshot provides no worktree path/branch');
  } else {
    if (!expectedPath || live.worktree.path !== expectedPath) mismatches.push(`path ${live.worktree.path} != bound ${expectedPath ?? '-'}`);
    if (!expectedBranch || live.worktree.branch !== expectedBranch) mismatches.push(`branch ${live.worktree.branch} != bound ${expectedBranch ?? '-'}`);
  }
  if (!repoRoot) mismatches.push('run row has no repo binding');
  else if (!live.worktree?.repoRoot) mismatches.push('live snapshot provides no repo root');
  else if (live.worktree.repoRoot !== repoRoot) mismatches.push(`repo root ${live.worktree.repoRoot} != run binding ${repoRoot}`);
  if (mismatches.length > 0) {
    throw new Error(`workspace ${workspaceId} identity cannot be proven (${mismatches.join('; ')}); refusing to force-remove a workspace this run cannot prove provenance for`);
  }
}

/**
 * Reclaim one task's temp resources in the fixed order. Resumes from the
 * first non-ok step; returns the outcome when the task fully settled.
 */
export async function cleanupTaskResources(env: RunnerEnv, task: TaskRecord, opts: CleanupOptions = {}): Promise<CleanupOutcome> {
  const { db, runId, client } = env;

  // cleanup eligibility (review 01 #2, tightened by review 02 R2-03/R2-14,
  // then review 03 R3-04): the persisted final PASS must exist AND still
  // describe the current delivery — accepted revision, live integration
  // HEAD, exactly the ledgered task commits. Without it only an explicit
  // operator discard may proceed.
  const run = getRun(db, runId);
  if (!run) return null;
  // R3-02: the repo binding is the run row's, not a revision's
  const repoRoot = run.repoRoot;
  const verified = await finalPassMatchesDelivery(env);
  let discarded = false;
  if (!verified) {
    if (!opts.discardUnverified) return null;
    discarded = true;
    addEvent(db, runId, 'RECONCILE_DECISION', {
      taskId: task.taskId,
      payload: { reason: 'cleanup_unverified_discard', source: 'clean', finalCommit: task.integrationCommit },
    });
  }

  // R4-05/R5-04: every step is preceded by a fence renewal, every operation
  // is heartbeated while it runs, and every audit write re-checks the fence —
  // a long sweep of Herdr/Git calls must abort the moment another writer
  // holds the lease
  const fencedStep = (
    step: CleanupStep,
    exec: () => Promise<void>,
    extra: { branch?: string | null; worktreePath?: string | null; workspaceId?: string | null } = {},
  ): Promise<boolean> => {
    opts.ensureLease?.();
    return runStep(env, task, step, exec, extra, opts.ensureLease);
  };

  const closePanes = await fencedStep('close_pane', async () => {
    for (const exec of listExecutions(db, runId)) {
      if (exec.taskId !== task.taskId || !exec.paneId) continue;
      if (!['open', 'retained'].includes(exec.paneState)) continue;
      // R3-07 (R2-11 completion): close eligibility follows the EXECUTION's
      // outcome, not just the task's integration. Only a successfully
      // concluded execution (worker completed / reviewer approved /
      // integrator completed) may be closed as a success; failed, blocked
      // and result-less panes stay for attach — the workspace removal below
      // retires them, audited as gone.
      if (!executionConcludedSuccessfully(exec)) continue;
      await closePaneSafe(client, exec.paneId);
      updateExecution(db, exec.id, { paneState: 'closed_success' });
    }
  });
  if (!closePanes) return null;

  const removeWorktree = await fencedStep('remove_worktree', async () => {
    if (!task.workspaceId) return;
    // R3-02/R4-03: ledger provenance AND the live Herdr mapping must both
    // describe THIS task's workspace before a force removal — a workspace
    // ledgered to another run is never a candidate, and herdr reuses short
    // ids after restarts, so a ledger row alone proves only that this run
    // ONCE held the id.
    await assertRemovableWorkspace(env, task.workspaceId, { taskId: task.taskId });
    try {
      await client.removeWorktree({ workspaceId: task.workspaceId, force: true });
    } catch (err) {
      // already removed (crash after the API succeeded) — postcondition holds
      if (!(err instanceof HerdrError && err.code === 'not_found')) throw err;
    }
  });
  if (!removeWorktree) return null;
  // R5-04: these writes conclude the worktree's reclamation — the fence must
  // be current, not the one a long removal left behind
  opts.ensureLease?.();
  for (const res of listActiveResources(db, runId)) {
    if (res.taskId === task.taskId || res.herdrId === task.workspaceId) {
      markResourceState(db, runId, res.kind, res.herdrId, 'reclaimed');
    }
  }
  // R3-07/R5-policy: removing the workspace retires its whole pane tree —
  // that is the ADR's own reclamation order (close success panes → remove
  // workspace). The attach-retention rule for failed/blocked panes governs
  // the run's LIVE phases; at reclamation the leftover non-success panes are
  // retired explicitly: `gone`, never a success close, one audit event each,
  // so the ledger shows exactly which attach surfaces the removal destroyed.
  for (const exec of listExecutions(db, runId)) {
    if (exec.taskId !== task.taskId) continue;
    if (!['open', 'retained'].includes(exec.paneState)) continue;
    if (exec.workspaceId && exec.workspaceId !== task.workspaceId) continue;
    updateExecution(db, exec.id, { paneState: 'gone' });
    addEvent(db, runId, 'RECONCILE_DECISION', {
      executionId: exec.id,
      payload: {
        reason: 'pane_retired_by_workspace_removal',
        workspaceId: task.workspaceId,
        concludedSuccessfully: executionConcludedSuccessfully(exec),
      },
    });
  }

  const verifyFree = await fencedStep('verify_branch_free', async () => {
    if (!task.branch) return;
    assertRunBranch(runId, task.branch); // R2-04 provenance gate
    if (!(await branchExists(repoRoot, task.branch))) return; // already deleted
    const held = await worktreeBranches(repoRoot);
    if (held.has(task.branch)) {
      throw new Error(`branch ${task.branch} still held by a worktree`);
    }
  });
  if (!verifyFree) return null;

  const deleteBranch = await fencedStep('delete_branch', async () => {
    if (!task.branch) return;
    assertRunBranch(runId, task.branch); // R2-04 provenance gate (defense in depth)
    const deleted = await deleteBranchIfFree(repoRoot, task.branch);
    if (!deleted) throw new Error(`branch ${task.branch} could not be deleted (occupied?)`);
  });
  if (!deleteBranch) return null;

  const finalized = await fencedStep('finalize', async () => {
    // R2-03: an unverified destruction settles as `discarded` — a resource
    // destroyed without final verification is never counted as reclaimed
    // R5-05: settling the task also retires any dead dispatch intent — a
    // settled task will never start the follow-up, and run-finalization
    // decisions read the intent as live work
    updateTask(db, runId, task.taskId, { status: discarded ? 'discarded' : 'reclaimed', pendingDispatch: null });
  });
  if (!finalized) return null;
  return discarded ? 'discarded' : 'reclaimed';
}
