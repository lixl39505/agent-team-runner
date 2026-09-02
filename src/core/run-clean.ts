import { StateDatabase } from './db.js';
import { git } from './git.js';

export interface CleanRunResult {
  removedWorktrees: string[];
  removedBranches: string[];
}

/**
 * Terminal cleanup for a finished or abandoned run: removes its worktrees and
 * branches from the project repository and marks the run cancelled (non-replayable).
 * Only successful removals are reported; missing entries are tolerated.
 */
export async function cleanRunArtifacts(db: StateDatabase, runId: string): Promise<CleanRunResult> {
  const run = db.getRun(runId);
  const tasks = db.listTasks(runId);
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];

  const removeWorktree = async (path: string): Promise<void> => {
    const result = await git(run.repoRoot, ['worktree', 'remove', '--force', path], true);
    if (result.code === 0) removedWorktrees.push(path);
  };
  const removeBranch = async (branch: string): Promise<void> => {
    const result = await git(run.repoRoot, ['branch', '-D', branch], true);
    if (result.code === 0) removedBranches.push(branch);
  };

  for (const task of tasks) {
    if (task.worktree !== null) await removeWorktree(task.worktree);
    if (task.branch !== null) await removeBranch(task.branch);
  }
  if (run.integrationWorktree !== null) await removeWorktree(run.integrationWorktree);
  if (run.integrationBranch !== null) await removeBranch(run.integrationBranch);

  if (run.status !== 'cancelled') {
    db.updateRun(runId, {
      status: 'cancelled',
      error: 'Cleaned by agent-team clean; worktrees and branches were removed.',
      finishedAt: new Date().toISOString()
    });
    db.addEvent(runId, null, 'RUN_CANCELLED', { cleaned: true });
  }
  return { removedWorktrees, removedBranches };
}
