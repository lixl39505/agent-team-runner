// Mechanical verification gate: run each verification command in the
// worktree (argv, allowlisted), then assert diff scope against the task's
// path policy and that HEAD did not move unexpectedly.
//
// R5-01 (stage-first, `staged: true`): the task gate stages the delivery
// BEFORE running commands, measures the diff as index-vs-base and pins the
// index tree (`write-tree`). The commit step must later prove it carries
// exactly that tree, so content racing in after the gate can never ride the
// delivery commit unverified.
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
  writeTree,
  currentHead,
  hasStagedChanges,
} from '../../core/git.ts';
import { isPathAllowed, matchAny, ATEAM_INTERNAL_PATTERNS } from '../../core/path-policy.ts';
import type { TaskRecord } from '../../core/types.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface VerificationCommandResult {
  command: string;
  ok: boolean;
  exitCode: number;
  output: string;
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
    const dirty = await worktreeDirtyFiles(worktreePath);
    if (dirty.length > 0) {
      violations.push(`(worktree not clean before verification: ${dirty.join(', ')})`);
    }
    if (await hasStagedChanges(worktreePath)) {
      violations.push('(index has staged changes before verification)');
    }
  }

  // R5-01: pin the index tree the gate verifies — the commit step must
  // prove it carries exactly this tree
  const treeSha = opts.staged ? await writeTree(worktreePath) : undefined;

  if (violations.length === 0) {
    for (const command of task.spec.verificationCommands ?? []) {
      const res = await runCommand(command, { cwd: worktreePath, allowlist, timeoutMs: opts.timeoutMs });
      commands.push({ command, ok: res.ok, exitCode: res.exitCode, output: res.stdout + res.stderr });
      if (!res.ok) break;
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
