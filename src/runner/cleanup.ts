// Reclaim state machine (ADR 0001 临时资源回收): close panes → remove the
// Herdr worktree workspace → confirm the branch is free → delete the task
// branch → finalize. Every step is audited and safely retryable; only
// ATeam-provenanced resources are ever touched.

import { latestCleanupSteps, recordCleanupStep } from '../store/cleanup.ts';
import { listActiveResources, markResourceState } from '../store/resources.ts';
import { updateTask } from '../store/tasks.ts';
import { listExecutions, updateExecution } from '../store/executions.ts';
import { addEvent } from '../store/events.ts';
import { worktreeBranches, deleteBranchIfFree } from '../core/git.ts';
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

/**
 * Reclaim one task's temp resources in the fixed order. Resumes from the
 * first non-ok step; returns true when the task is fully reclaimed.
 */
export async function cleanupTaskResources(env: RunnerEnv, task: TaskRecord): Promise<boolean> {
  const { db, runId, client, contract } = env;

  const closePanes = await runStep(env, task, 'close_pane', async () => {
    for (const exec of listExecutions(db, runId)) {
      if (exec.taskId !== task.taskId || !exec.paneId) continue;
      if (!['open', 'retained'].includes(exec.paneState)) continue;
      await closePaneSafe(client, exec.paneId);
      updateExecution(db, exec.id, { paneState: 'closed_success' });
    }
  });
  if (!closePanes) return false;

  const removeWorktree = await runStep(env, task, 'remove_worktree', async () => {
    if (!task.workspaceId) return;
    await client.removeWorktree({ workspaceId: task.workspaceId, force: true });
  });
  if (!removeWorktree) return false;
  for (const res of listActiveResources(db, runId)) {
    if (res.taskId === task.taskId || res.herdrId === task.workspaceId) {
      markResourceState(db, res.kind, res.herdrId, 'reclaimed');
    }
  }

  const verifyFree = await runStep(env, task, 'verify_branch_free', async () => {
    if (!task.branch) return;
    const held = await worktreeBranches(contract.project.repoRoot);
    if (held.has(task.branch)) {
      throw new Error(`branch ${task.branch} still held by a worktree`);
    }
  });
  if (!verifyFree) return false;

  const deleteBranch = await runStep(env, task, 'delete_branch', async () => {
    if (!task.branch) return;
    const deleted = await deleteBranchIfFree(contract.project.repoRoot, task.branch);
    if (!deleted) throw new Error(`branch ${task.branch} could not be deleted (occupied?)`);
  });
  if (!deleteBranch) return false;

  return runStep(env, task, 'finalize', async () => {
    updateTask(db, runId, task.taskId, { status: 'reclaimed' });
  });
}
