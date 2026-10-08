// Reclaim state machine (ADR 0001 临时资源回收): close panes → remove the
// Herdr worktree workspace → confirm the branch is free → delete the task
// branch → finalize. Every step is audited and safely retryable — retries
// confirm postconditions against the authoritative state (resource already
// gone, branch already deleted) and record success instead of failing
// forever (review 01 #11). Only ATeam-provenanced resources are touched.

import { latestCleanupSteps, recordCleanupStep } from '../store/cleanup.ts';
import { getResource, getResourceForRun, listActiveResources, markResourceState } from '../store/resources.ts';
import { updateTask, listTasks } from '../store/tasks.ts';
import { getRun } from '../store/runs.ts';
import { listExecutions, updateExecution } from '../store/executions.ts';
import { hasPassingFinalVerification, type FinalVerificationExpectation } from '../store/verifications.ts';
import { addEvent } from '../store/events.ts';
import { branchExists, worktreeBranches, deleteBranchIfFree, currentHead } from '../core/git.ts';
import { existsSync } from 'node:fs';
import { HerdrError } from '../herdr/types.ts';
import type { CleanupStep, TaskRecord } from '../core/types.ts';
import { closePaneSafe, type RunnerEnv } from './executions.ts';

async function runStep(
  env: RunnerEnv,
  task: TaskRecord,
  step: CleanupStep,
  exec: () => Promise<void>,
  extra: { branch?: string | null; worktreePath?: string | null; workspaceId?: string | null } = {},
): Promise<boolean> {
  const { db, runId } = env;
  const latest = latestCleanupSteps(db, runId, task.taskId).get(step);
  if (latest?.status === 'ok') return true;
  try {
    await exec();
    recordCleanupStep(db, {
      runId, taskId: task.taskId, step, status: 'ok',
      branch: task.branch, worktreePath: task.worktreePath, workspaceId: task.workspaceId,
      finalCommit: task.integrationCommit, ...extra,
    });
    addEvent(db, runId, 'CLEANUP_STEP_OK', { taskId: task.taskId, payload: { step } });
    return true;
  } catch (err) {
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
  if (run.integrationPath && existsSync(run.integrationPath)) {
    const head = await currentHead(run.integrationPath).catch(() => null);
    if (!head) return false; // an unreadable tree is not a verified tree
    expected.headSha = head;
  }
  return hasPassingFinalVerification(env.db, env.runId, expected);
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

  const closePanes = await runStep(env, task, 'close_pane', async () => {
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

  const removeWorktree = await runStep(env, task, 'remove_worktree', async () => {
    if (!task.workspaceId) return;
    // R3-02: a workspace ledgered to ANOTHER run (and not to this one) is
    // never a removal candidate, whatever a candidate contract revision
    // pointed at. herdr reuses small ids after restarts, so "another run's
    // row" alone is not damning — this run must hold its own.
    const mine = getResourceForRun(db, runId, 'workspace', task.workspaceId);
    if (!mine) {
      const other = getResource(db, 'workspace', task.workspaceId);
      if (other && other.runId !== runId) {
        throw new Error(`workspace ${task.workspaceId} is ledgered to run ${other.runId}; refusing to remove it for run ${runId}`);
      }
    }
    try {
      await client.removeWorktree({ workspaceId: task.workspaceId, force: true });
    } catch (err) {
      // already removed (crash after the API succeeded) — postcondition holds
      if (!(err instanceof HerdrError && err.code === 'not_found')) throw err;
    }
  });
  if (!removeWorktree) return null;
  for (const res of listActiveResources(db, runId)) {
    if (res.taskId === task.taskId || res.herdrId === task.workspaceId) {
      markResourceState(db, runId, res.kind, res.herdrId, 'reclaimed');
    }
  }
  // R3-07: removing the workspace retires its whole pane tree. Panes kept
  // for attach above are now gone with it — recorded as `gone`, never as a
  // success close, so the audit distinguishes surrender-by-reclamation from
  // an earned `closed_success`.
  for (const exec of listExecutions(db, runId)) {
    if (exec.taskId !== task.taskId) continue;
    if (!['open', 'retained'].includes(exec.paneState)) continue;
    if (exec.workspaceId && exec.workspaceId !== task.workspaceId) continue;
    updateExecution(db, exec.id, { paneState: 'gone' });
  }

  const verifyFree = await runStep(env, task, 'verify_branch_free', async () => {
    if (!task.branch) return;
    assertRunBranch(runId, task.branch); // R2-04 provenance gate
    if (!(await branchExists(repoRoot, task.branch))) return; // already deleted
    const held = await worktreeBranches(repoRoot);
    if (held.has(task.branch)) {
      throw new Error(`branch ${task.branch} still held by a worktree`);
    }
  });
  if (!verifyFree) return null;

  const deleteBranch = await runStep(env, task, 'delete_branch', async () => {
    if (!task.branch) return;
    assertRunBranch(runId, task.branch); // R2-04 provenance gate (defense in depth)
    const deleted = await deleteBranchIfFree(repoRoot, task.branch);
    if (!deleted) throw new Error(`branch ${task.branch} could not be deleted (occupied?)`);
  });
  if (!deleteBranch) return null;

  const finalized = await runStep(env, task, 'finalize', async () => {
    // R2-03: an unverified destruction settles as `discarded` — a resource
    // destroyed without final verification is never counted as reclaimed
    updateTask(db, runId, task.taskId, { status: discarded ? 'discarded' : 'reclaimed' });
  });
  if (!finalized) return null;
  return discarded ? 'discarded' : 'reclaimed';
}
