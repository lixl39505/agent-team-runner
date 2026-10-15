// R7-05: the conclusion half of the integration final gate. A gate PASS
// proves `headBefore === headAfter` INSIDE the gate; a HEAD read afterwards
// may already be a different, never-verified commit. The conclusion
// therefore binds the record to the gate's own headAfter, re-confirms the
// live HEAD against it, and proves the delivery chain (every integrated
// task commit is still contained in the verified HEAD).

import { currentHead, isAncestor } from '../../core/git.ts';
import type { VerificationOutcome } from './verify.ts';

export interface FinalGateConclusion {
  ok: boolean;
  /** The HEAD the verdict binds to — the gate's own headAfter, never a
   * later read. Null only when the gate itself produced no HEAD. */
  headSha: string | null;
  violations: string[];
}

export async function concludeFinalGate(opts: {
  worktreePath: string;
  outcome: VerificationOutcome;
  /** task -> the integration commit each cherry-pick delivered (the R3-04
   * bindings the record must still cover). */
  integratedCommits: Record<string, string>;
}): Promise<FinalGateConclusion> {
  const violations = [...opts.outcome.violations];
  const headSha = opts.outcome.headAfter;
  // re-confirm the live HEAD AFTER the gate — a commit landing between the
  // gate's last read and this conclusion voids the PASS instead of
  // inheriting it (the record binds to the verified sha either way, so a
  // racing writer is visible in the audit)
  const live = await currentHead(opts.worktreePath).catch(() => null);
  if (live !== headSha) {
    violations.push(
      `(integration HEAD moved after the gate ran: the gate verified ${headSha.slice(0, 7)}, current HEAD is ${live ? live.slice(0, 7) : 'unreadable'})`,
    );
    return { ok: false, headSha, violations };
  }
  // the verified HEAD must still CONTAIN every delivered task commit — a
  // PASS bound to a HEAD that dropped a delivery must not authorize
  // reclaiming resources for content the tree no longer carries
  let ok = opts.outcome.ok;
  for (const [taskId, sha] of Object.entries(opts.integratedCommits)) {
    if (!(await isAncestor(opts.worktreePath, sha, headSha).catch(() => false))) {
      violations.push(`(integration HEAD does not contain the delivered commit of ${taskId} (${sha.slice(0, 7)}))`);
      ok = false;
    }
  }
  return { ok, headSha, violations };
}
