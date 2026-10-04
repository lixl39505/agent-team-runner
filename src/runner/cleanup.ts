// Reclaim state machine (ADR 0001 临时资源回收): close panes → remove the
// Herdr worktree workspace → confirm the branch is free → delete the task
// branch → finalize. Every step is audited and safely retryable — retries
// confirm postconditions against the authoritative state (resource already
// gone, branch already deleted) and record success instead of failing
// forever (review 01 #11). Only ATeam-provenanced resources are touched.

import { latestCleanupSteps, recordCleanupStep } from '../store/cleanup.ts';
import { listActiveResources, markResourceState } from '../store/resources.ts';
import { updateTask } from '../store/tasks.ts';
import { getRun } from '../store/runs.ts';
import { listExecutions, updateExecution } from '../store/executions.ts';
import { hasPassingFinalVerification } from '../store/verifications.ts';
import { addEvent } from '../store/events.ts';
import { branchExists, worktreeBranches, deleteBranchIfFree } from '../core/git.ts';
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
 * (`ateam/<runId>/…`). Review 02 R2-04: cleanup reads repoRoot from the
 * CURRENT contract; if a revision ever moved the binding, same-named
 * branches in the new repo must not be mistaken for this run's resources.
 * The runId-scoped prefix is the provenance proof (branches are minted by
 * taskBranch()/integrationBranch() with exactly this shape).
 */
function assertRunBranch(runId: string, branch: string): void {
  if (!branch.startsWith(`ateam/${runId}/`)) {
    throw new Error(`branch ${branch} is not a resource of run ${runId}; refusing to clean it`);
  }
}

/**
 * Reclaim one task's temp resources in the fixed order. Resumes from the
 * first non-ok step; returns the outcome when the task fully settled.
 */
export async function cleanupTaskResources(env: RunnerEnv, task: TaskRecord, opts: CleanupOptions = {}): Promise<CleanupOutcome> {
  const { db, runId, client, contract } = env;

  // cleanup eligibility (review 01 #2, tightened by review 02 R2-03/R2-14):
  // a final mechanical verification must be persisted BOTH as the run flag
  // AND as a passing verification record before temp resources are claimed
  // back. Without it only an explicit operator discard may proceed.
  const run = getRun(db, runId);
  const verified = !!run?.finalVerified && hasPassingFinalVerification(db, runId);
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
      await closePaneSafe(client, exec.paneId);
      updateExecution(db, exec.id, { paneState: 'closed_success' });
    }
  });
  if (!closePanes) return null;

  const removeWorktree = await runStep(env, task, 'remove_worktree', async () => {
    if (!task.workspaceId) return;
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
      markResourceState(db, res.kind, res.herdrId, 'reclaimed');
    }
  }

  const verifyFree = await runStep(env, task, 'verify_branch_free', async () => {
    if (!task.branch) return;
    assertRunBranch(runId, task.branch); // R2-04 provenance gate
    if (!(await branchExists(contract.project.repoRoot, task.branch))) return; // already deleted
    const held = await worktreeBranches(contract.project.repoRoot);
    if (held.has(task.branch)) {
      throw new Error(`branch ${task.branch} still held by a worktree`);
    }
  });
  if (!verifyFree) return null;

  const deleteBranch = await runStep(env, task, 'delete_branch', async () => {
    if (!task.branch) return;
    assertRunBranch(runId, task.branch); // R2-04 provenance gate (defense in depth)
    const deleted = await deleteBranchIfFree(contract.project.repoRoot, task.branch);
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
