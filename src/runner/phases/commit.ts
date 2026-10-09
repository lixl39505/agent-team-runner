// R5-01: the commit half of the stage-first verification gate. The gate
// (src/runner/phases/verify.ts) staged the delivery and pinned the index
// tree before running its commands; this step commits and proves the commit
// carries EXACTLY that tree, so content racing in between the gate and the
// commit (a concurrent `git add`) cannot ride the delivery unverified.

import { commit, commitTree, currentHead, hasStagedChanges } from '../../core/git.ts';

/**
 * Commit the staged delivery; returns the commit sha, or null when the
 * committed tree diverged from `verifiedTree` — the caller must route the
 * task back through the worker gate instead of handing the commit to review.
 * A null `verifiedTree` (gate ran without stage-first pinning) skips the
 * proof and returns the sha.
 */
export async function commitVerifiedTree(
  worktreePath: string,
  verifiedTree: string | null | undefined,
  message: string,
): Promise<string | null> {
  // crash-safe commit: if the task commit already landed (crash after
  // commit, before the status write) there is nothing staged — reuse HEAD
  const sha = (await hasStagedChanges(worktreePath))
    ? await commit(worktreePath, message)
    : await currentHead(worktreePath);
  if (verifiedTree === null || verifiedTree === undefined) return sha;
  const tree = await commitTree(worktreePath, sha);
  return tree === verifiedTree ? sha : null;
}
