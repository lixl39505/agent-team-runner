// Mechanical verification gate: run each verification command (argv,
// allowlisted), then assert diff scope against the task's path policy and
// that HEAD did not move unexpectedly.
//
// R5-01 (stage-first, `staged: true`): the task gate stages the delivery
// BEFORE running commands, measures the diff as index-vs-base and pins the
// index tree (`write-tree`). The commit step must later prove it carries
// exactly that tree, so content racing in after the gate can never ride the
// delivery commit unverified.
//
// R6-04 (stage-first): the commands run in a DETACHED, disposable worktree
// checked out from the pinned index tree — never in the mutable task
// worktree, where a worker could keep writing content the index never held.
// What the commands verify IS the tree the commit will carry.
//
// R6-03 (stage-first): the FULL index is judged, not just the change set —
// any `.ateam/**` entry a worker force-staged behind `stageAll`'s pathspec
// is a violation, and the index is restored to HEAD so the pinned tree (and
// the delivery commit) can never contain it.
//
// R5-03 (`requireClean: true`): the final gate verifies the COMMITTED
// delivery only — the integration tree must be clean (no staged, unstaged
// or untracked delivery files) before and after the commands, so a PASS
// describes exactly what the delivery commits contain.

import { runCommand } from '../../core/shell.ts';
import {
  worktreeChangedFiles,
  stagedChangedFiles,
  worktreeDirtyFiles,
  worktreeTrackedDirtyFiles,
  stagedInternalFiles,
  unstageInternalFiles,
  committedInternalFiles,
  changedFiles,
  createGateWorktree,
  removeGateWorktree,
  writeTree,
  currentHead,
  hasStagedChanges,
} from '../../core/git.ts';
import { isPathAllowed, matchAny, pathsOutsideScopes, ATEAM_INTERNAL_PATTERNS, type DeliveryScope } from '../../core/path-policy.ts';
import type { TaskRecord } from '../../core/types.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface VerificationCommandResult {
  command: string;
  ok: boolean;
  exitCode: number;
  output: string;
}

/**
 * R7-06: ledger callbacks for the disposable gate checkout. `register`
 * persists the path before git registers the worktree; `release` closes the
 * row when the checkout was removed — a `removed: false` release leaves the
 * row active for the reconcile/clean reclaim sweep instead of dropping the
 * litter silently.
 */
export interface GateLedger {
  register: (path: string) => void;
  release: (path: string, removed: boolean) => void;
}

export interface VerificationOutcome {
  ok: boolean;
  commands: VerificationCommandResult[];
  violations: string[];
  diffFiles: string[];
  headBefore: string;
  headAfter: string;
  /** R5-01: the pinned index tree (staged mode) the commit must carry. */
  treeSha?: string;
  logPath: string | null;
}

/**
 * R7-02: what a verification command changed in the gate checkout, or null
 * when it still IS the pinned tree — HEAD unmoved, index equal to the pinned
 * tree, no tracked content modified. Untracked output files a command
 * legitimately emits are not drift.
 */
async function gateDrift(gatePath: string, pinnedTree: string, gateHead: string): Promise<string | null> {
  const headNow = await currentHead(gatePath).catch(() => null);
  const treeNow = await writeTree(gatePath).catch(() => null);
  if (headNow === null || treeNow === null) return 'the gate checkout became unreadable';
  if (headNow !== gateHead) return `HEAD moved (${gateHead.slice(0, 7)} -> ${headNow.slice(0, 7)})`;
  if (treeNow !== pinnedTree) return 'the index no longer matches the pinned tree';
  const tracked = await worktreeTrackedDirtyFiles(gatePath);
  if (tracked.length > 0) return `tracked content modified (${tracked.join(', ')})`;
  return null;
}

/** Run the full mechanical gate for a task inside its worktree. */
export async function verifyTaskWork(
  opts: {
    worktreePath: string;
    task: TaskRecord;
    allowlist: readonly string[];
    baseSha: string;
    /** R5-01: stage-first mode — the diff is index-vs-base and the index
     * tree is pinned for the commit step. */
    staged?: boolean;
    /** R5-03: final-gate mode — the tree must be clean before and after. */
    requireClean?: boolean;
    /** R7-01: final-gate mode — every path in the COMMITTED delivery must be
     * allowed by at least one of these policies, and committed runner-internal
     * content is a violation, never a filtered non-entity. */
    scopePolicies?: ReadonlyArray<DeliveryScope>;
    /** R7-06: ledger the disposable gate checkout so a crash mid-gate (or a
     * failed cleanup) leaves a reclaimable row, never unregistered litter. */
    gateLedger?: GateLedger;
    timeoutMs?: number;
    logDir?: string;
  },
): Promise<VerificationOutcome> {
  const { worktreePath, task, allowlist } = opts;
  const headBefore = await currentHead(worktreePath);
  const commands: VerificationCommandResult[] = [];
  const violations: string[] = [];

  // R5-03: refuse a dirty tree up front — the commands would otherwise run
  // against content no delivery commit carries
  if (opts.requireClean) {
    // R7-01: the final gate judges the FULL committed delivery — internal
    // paths that rode an integration commit are a violation (the worktree
    // filters below must not quietly drop them), and every committed path
    // must belong to a task's policy
    const internal = await committedInternalFiles(worktreePath, opts.baseSha);
    if (internal.length > 0) {
      violations.push(`(delivery commits carry runner-internal .ateam content: ${internal.join(', ')})`);
    }
    if (opts.scopePolicies) {
      const committed = await changedFiles(worktreePath, opts.baseSha, 'HEAD');
      const outside = pathsOutsideScopes(opts.scopePolicies, committed);
      if (outside.length > 0) {
        violations.push(`(delivery commits touch paths outside every task's path policy: ${outside.join(', ')})`);
      }
    }
    const dirty = await worktreeDirtyFiles(worktreePath);
    if (dirty.length > 0) {
      violations.push(`(worktree not clean before verification: ${dirty.join(', ')})`);
    }
    if (await hasStagedChanges(worktreePath)) {
      violations.push('(index has staged changes before verification)');
    }
  }

  // R6-03: judge the FULL index before pinning it — `.ateam/**` content a
  // worker force-staged never enters the gate (and never the commit); the
  // index is restored to HEAD instead of the entry being quietly filtered
  // out of the change set below
  if (opts.staged) {
    const smuggled = await stagedInternalFiles(worktreePath);
    if (smuggled.length > 0) {
      violations.push(`(runner-internal .ateam content staged into the index: ${smuggled.join(', ')})`);
      await unstageInternalFiles(worktreePath);
    }
  }

  // R5-01: pin the index tree the gate verifies — the commit step must
  // prove it carries exactly this tree
  const treeSha = opts.staged ? await writeTree(worktreePath) : undefined;

  // R6-04: the commands read an isolated checkout of the PINNED tree, so a
  // worker editing the (mutable) task worktree after stageAll cannot make
  // the gate test content the delivery commit will never contain. Failure
  // to materialize it is fail-closed: the gate refuses rather than falling
  // back to the racy worktree.
  let gatePath: string | null = null;
  let gateHead: string | null = null;
  if (opts.staged && violations.length === 0) {
    try {
      gatePath = await createGateWorktree(worktreePath, treeSha!, opts.gateLedger?.register);
      gateHead = await currentHead(gatePath);
    } catch (err) {
      // a row `register` already wrote stays active on purpose — the reclaim
      // sweep clears a never-materialized checkout idempotently
      violations.push(`(could not materialize an isolated verification tree: ${String(err).slice(0, 200)})`);
    }
  }
  const commandCwd = gatePath ?? worktreePath;

  try {
    if (violations.length === 0) {
      for (const command of task.spec.verificationCommands ?? []) {
        const res = await runCommand(command, { cwd: commandCwd, allowlist, timeoutMs: opts.timeoutMs });
        commands.push({ command, ok: res.ok, exitCode: res.exitCode, output: res.stdout + res.stderr });
        if (!res.ok) break;
        // R7-02: the gate checkout must still BE the pinned tree after every
        // command — one that rewrites tracked content (then asserts the
        // rewrite) verified content the delivery commit will never carry
        if (gatePath && gateHead !== null) {
          const drift = await gateDrift(gatePath, treeSha!, gateHead);
          if (drift !== null) {
            violations.push(`(verification commands mutated the isolated verification tree: ${drift})`);
            break;
          }
        }
      }
    }
  } finally {
    if (gatePath) {
      // R7-06: a failed cleanup is no longer silent litter — the ledger row
      // stays active and the reconcile/clean sweep retries the removal
      let removed = true;
      try {
        await removeGateWorktree(worktreePath, gatePath);
      } catch {
        removed = false;
      }
      opts.gateLedger?.release(gatePath, removed);
    }
  }

  const diffFiles = (
    opts.staged
      ? await stagedChangedFiles(worktreePath, opts.baseSha)
      : await worktreeChangedFiles(worktreePath, opts.baseSha)
  ).filter((f) => !matchAny(ATEAM_INTERNAL_PATTERNS, f));
  for (const file of diffFiles) {
    // .ateam/** is runner-owned bookkeeping, never a policy violation
    if (matchAny(ATEAM_INTERNAL_PATTERNS, file)) continue;
    if (!isPathAllowed({ allowedPaths: task.spec.allowedPaths, blockedPaths: task.spec.blockedPaths }, file)) {
      violations.push(file);
    }
  }
  if (diffFiles.length === 0 && !(task.spec.allowNoChanges ?? false)) {
    violations.push('(no changes produced by worker)');
  }

  // R5-01: the index must be unchanged since the pin — content staged into
  // it mid-gate (a concurrent writer) was never verified
  if (opts.staged) {
    const treeAfter = await writeTree(worktreePath);
    if (treeAfter !== treeSha) {
      violations.push('(git index changed during verification — concurrent writer staged content the gate did not verify)');
    }
  }
  // R5-03: the tree must still be clean afterwards — a command that emits
  // non-ignored files makes the verified world differ from the delivery
  if (opts.requireClean) {
    const dirtyAfter = await worktreeDirtyFiles(worktreePath);
    if (dirtyAfter.length > 0) {
      violations.push(`(worktree dirty after verification: ${dirtyAfter.join(', ')})`);
    }
  }

  const headAfter = await currentHead(worktreePath);
  const ok = commands.every((c) => c.ok) && violations.length === 0 && headAfter === headBefore;

  let logPath: string | null = null;
  if (opts.logDir) {
    logPath = join(opts.logDir, `${task.taskId}-a${task.attempts}.log`);
    await mkdir(dirname(logPath), { recursive: true });
    const body = [
      ...commands.map((c) => `$ ${c.command}\nexit=${c.exitCode}\n${c.output}`),
      `diff files:\n${diffFiles.join('\n')}`,
      violations.length > 0 ? `violations:\n${violations.join('\n')}` : 'violations: none',
      `head ${headBefore} -> ${headAfter}`,
      treeSha ? `tree ${treeSha}` : null,
    ].filter((l): l is string => l !== null).join('\n\n');
    await writeFile(logPath, body, 'utf8');
  }

  return { ok, commands, violations, diffFiles, headBefore, headAfter, treeSha, logPath };
}
