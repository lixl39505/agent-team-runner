// R7-01: the commit half of the INTEGRATOR's conflict resolution. Unlike the
// worker path, the integrator commits in the shared integration worktree
// AFTER a task gate ran — so this entry point re-runs the delivery boundary
// itself: the FULL index is judged (internal paths a force-`git add` parked
// behind stageAll's pathspec) and the staged change set must lie within the
// delivery scopes the contract hands out. A violation refuses the commit —
// nothing rides into the integration branch unjudged.

import { stageAll, stagedChangedFiles, stagedInternalFiles, hasStagedChanges, commit, currentHead } from '../../core/git.ts';
import { pathsOutsideScopes, type DeliveryScope } from '../../core/path-policy.ts';

export interface IntegrationCommitGate {
  ok: boolean;
  /** The integration commit sha on success; null when the commit was refused. */
  sha: string | null;
  violations: string[];
}

/**
 * Stage the conflict resolution and commit it ONLY once the full index
 * passes the same delivery boundary the worker gate enforces. Crash-safe
 * like the engine's original path: when nothing is staged (the resolution
 * reverted the conflict) HEAD is reused instead of creating an empty commit.
 */
export async function commitIntegrationResolution(opts: {
  worktreePath: string;
  /** The integration baseline the staged change set is measured against;
   * null (no baseline recorded) skips the scope judgment. */
  baseSha: string | null;
  message: string;
  /** Every task's path policy — a staged file must be allowed by at least one. */
  scopes: ReadonlyArray<DeliveryScope>;
}): Promise<IntegrationCommitGate> {
  await stageAll(opts.worktreePath);
  const violations: string[] = [];
  const smuggled = await stagedInternalFiles(opts.worktreePath);
  if (smuggled.length > 0) {
    violations.push(`(runner-internal .ateam content staged into the integration index: ${smuggled.join(', ')})`);
  }
  if (opts.baseSha) {
    const staged = await stagedChangedFiles(opts.worktreePath, opts.baseSha);
    const outside = pathsOutsideScopes(opts.scopes, staged);
    if (outside.length > 0) {
      violations.push(`(integration content outside every task's path policy: ${outside.join(', ')})`);
    }
  }
  if (violations.length > 0) return { ok: false, sha: null, violations };
  const sha = (await hasStagedChanges(opts.worktreePath))
    ? await commit(opts.worktreePath, opts.message)
    : await currentHead(opts.worktreePath);
  return { ok: true, sha, violations };
}
