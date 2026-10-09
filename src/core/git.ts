// Minimal git plumbing used by the delivery gates. All operations are
// anchored to an explicit repo/worktree path — never to process cwd.

import { runArgv, type CommandResult } from './shell.ts';
import { matchAny, ATEAM_INTERNAL_PATTERNS } from './path-policy.ts';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

async function git(repoRoot: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return runArgv(['git', '-C', repoRoot, ...args], { timeoutMs });
}

async function gitOk(repoRoot: string, args: string[], timeoutMs?: number): Promise<string> {
  const res = await git(repoRoot, args, timeoutMs);
  if (!res.ok) {
    throw new Error(`git ${args[0]} failed (${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout.trim();
}

/** Raw stdout (only the outer newline stripped) — porcelain formats need their leading columns. */
async function gitRaw(repoRoot: string, args: string[], timeoutMs?: number): Promise<string> {
  const res = await git(repoRoot, args, timeoutMs);
  if (!res.ok) {
    throw new Error(`git ${args[0]} failed (${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

export async function revParse(repoRoot: string, ref: string): Promise<string> {
  return gitOk(repoRoot, ['rev-parse', ref]);
}

export async function currentHead(repoRoot: string): Promise<string> {
  return revParse(repoRoot, 'HEAD');
}

export async function isRepo(path: string): Promise<boolean> {
  const res = await git(path, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout.trim() === 'true';
}

/** Files changed between two refs. R6-02: `--no-renames` — rename detection
 * would report only a rename's TARGET, hiding the deleted source from the
 * path gate; without it a worker could `git mv` a file out of its scope. */
export async function changedFiles(repoRoot: string, fromSha: string, toSha = 'HEAD'): Promise<string[]> {
  const out = await gitOk(repoRoot, ['diff', '--name-only', '--no-renames', fromSha, toSha]);
  return out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * R5-01: the delivery change set of a STAGE-FIRST gate — the index vs the
 * base sha, i.e. exactly the content a subsequent commit will carry. Files
 * edited (but not re-staged) after `stageAll` are invisible here, which is
 * the point: the gate verifies the tree the commit will contain.
 * R6-02: `--no-renames` so a staged rename's deleted source path is listed
 * too and the path gate judges both ends.
 */
export async function stagedChangedFiles(repoRoot: string, fromSha: string): Promise<string[]> {
  const out = await gitOk(repoRoot, ['diff', '--cached', '--name-only', '--no-renames', fromSha]);
  return out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/** R5-01: the index as a tree sha — the immutable content pin a stage-first
 * gate hands to the commit step. */
export async function writeTree(repoRoot: string): Promise<string> {
  return gitOk(repoRoot, ['write-tree']);
}

/** R5-01: the tree an existing commit points at (`<sha>^{tree}`). */
export async function commitTree(repoRoot: string, sha: string): Promise<string> {
  return revParse(repoRoot, `${sha}^{tree}`);
}

/**
 * R5-03: every path that makes a worktree "not clean" — any status entry
 * (staged, unstaged or untracked) outside runner-internal `.ateam/**`
 * bookkeeping. The final gate requires this set to be empty before and
 * after the verification commands, so the PASS describes exactly the
 * committed delivery. R6-02: a rename entry contributes BOTH its source and
 * its target — the source is a deletion the path gate must see.
 */
export async function worktreeDirtyFiles(repoRoot: string): Promise<string[]> {
  const status = await gitRaw(repoRoot, ['status', '--porcelain', '-uall']);
  const files: string[] = [];
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    for (const p of porcelainPaths(line)) {
      if (!matchAny(ATEAM_INTERNAL_PATTERNS, p)) files.push(p);
    }
  }
  return files;
}

/** R6-02: the paths a `status --porcelain` line touches — one, or both ends
 * of a rename (`R  old -> new`). */
function porcelainPaths(line: string): string[] {
  const rest = line.slice(3).trim();
  const arrow = rest.indexOf(' -> ');
  if (arrow >= 0) {
    return [rest.slice(0, arrow).trim(), rest.slice(arrow + 4).trim()].filter((p) => p.length > 0);
  }
  const p = rest;
  return p.length > 0 ? [p] : [];
}

/**
 * Worktree-level DELIVERY change set vs a base sha: committed diffs PLUS
 * staged/modified/untracked files (workers edit without committing — the
 * runner commits only after verification passes). Runner-internal
 * `.ateam/**` bookkeeping is excluded (review 02 R2-01): the brief is an
 * untracked internal file, and counting it made "no delivery changes"
 * look like a valid delivery. R6-02: rename sources are included — both the
 * status parsing above and `--no-renames` on the diff.
 */
export async function worktreeChangedFiles(repoRoot: string, fromSha: string): Promise<string[]> {
  const status = await gitRaw(repoRoot, ['status', '--porcelain', '-uall']);
  const diff = await gitOk(repoRoot, ['diff', '--name-only', '--no-renames', fromSha]);
  const files = new Set<string>();
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    for (const p of porcelainPaths(line)) files.add(p);
  }
  for (const line of diff.split('\n')) {
    const t = line.trim();
    if (t) files.add(t);
  }
  return [...files].filter((f) => !matchAny(ATEAM_INTERNAL_PATTERNS, f));
}

export async function diffStat(repoRoot: string, fromSha: string, toSha = 'HEAD'): Promise<string> {
  return gitOk(repoRoot, ['diff', '--stat', fromSha, toSha]);
}

export async function stageAll(repoRoot: string): Promise<void> {
  // .ateam/** is runner bookkeeping — never part of a delivery commit
  await gitOk(repoRoot, ['add', '-A', '--', '.', ':!.ateam']);
}

/**
 * R6-03: index entries under runner-internal `.ateam/**` that DIFFER from
 * HEAD — content a worker force-staged behind `stageAll`'s pathspec. The
 * pathspec only constrains what `git add` adds; it never unstages anything.
 * Measured as a staged diff vs HEAD so a base repo that legitimately tracks
 * `.ateam` (unchanged in the index) is not a false positive.
 */
export async function stagedInternalFiles(repoRoot: string): Promise<string[]> {
  const out = await gitOk(repoRoot, ['diff', '--cached', '--name-only', '--no-renames', 'HEAD', '--', ATEAM_INTERNAL_PATTERNS[0]!]);
  return out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/** R6-03: restore the index's `.ateam/**` entries to HEAD — a forced add
 * disappears, a forced modification/deletion reverts. The worktree copy is
 * untouched; only the delivery index is cleaned. */
export async function unstageInternalFiles(repoRoot: string): Promise<void> {
  await gitOk(repoRoot, ['reset', '-q', '--', ATEAM_INTERNAL_PATTERNS[0]!]);
}

/**
 * R6-04: materialize a pinned index tree as a DETACHED, disposable worktree
 * so the verification commands read exactly the content the delivery commit
 * will carry — never the mutable task worktree a worker may still be
 * writing to. The checkout hangs off a throwaway commit (dangling once the
 * worktree is removed), placed as a SIBLING of `anchorPath` so worktrees
 * never nest. Returns the worktree path.
 */
export async function createGateWorktree(anchorPath: string, treeSha: string): Promise<string> {
  const head = await git(anchorPath, ['rev-parse', '--verify', 'HEAD']);
  const sha = head.ok
    ? await gitOk(anchorPath, ['commit-tree', treeSha, '-p', head.stdout.trim(), '-m', 'ateam: verification gate tree'])
    : await gitOk(anchorPath, ['commit-tree', treeSha, '-m', 'ateam: verification gate tree']);
  const path = await mkdtemp(join(dirname(anchorPath), `${basename(anchorPath)}.gate-`));
  try {
    await gitOk(anchorPath, ['worktree', 'add', '--detach', path, sha]);
  } catch (err) {
    await rm(path, { recursive: true, force: true });
    throw err;
  }
  return path;
}

/** R6-04: drop a gate worktree — the checkout is disposable and its content
 * was either verified or refused, never delivered. */
export async function removeGateWorktree(anchorPath: string, path: string): Promise<void> {
  const res = await git(anchorPath, ['worktree', 'remove', '--force', path]);
  if (!res.ok) {
    // a remove that failed (locked admin area, already half-gone) must not
    // leave a registered worktree behind — prune what the filesystem lost
    await rm(path, { recursive: true, force: true });
    await gitOk(anchorPath, ['worktree', 'prune']);
  }
}

export async function commit(repoRoot: string, message: string): Promise<string> {
  await gitOk(repoRoot, ['commit', '-m', message, '--no-verify']);
  return currentHead(repoRoot);
}

/** Commits between base and HEAD (inclusive count). */
export async function countCommits(repoRoot: string, baseSha: string): Promise<number> {
  const out = await gitOk(repoRoot, ['rev-list', '--count', `${baseSha}..HEAD`]);
  return Number(out.trim()) || 0;
}

/**
 * Squash everything since baseSha into one commit (delivery invariant: one
 * commit per task attempt chain, so integration cherry-picks a single sha).
 * Returns the (possibly unchanged) HEAD.
 */
export async function squashSince(repoRoot: string, baseSha: string, message: string): Promise<string> {
  const commits = await countCommits(repoRoot, baseSha);
  if (commits <= 1) return currentHead(repoRoot);
  await gitOk(repoRoot, ['reset', '--soft', baseSha]);
  const staged = await hasStagedChanges(repoRoot);
  if (!staged) {
    // nothing to commit (e.g. only .ateam churn); restore branch pointer
    await gitOk(repoRoot, ['reset', '--hard', 'ORIG_HEAD']);
    return currentHead(repoRoot);
  }
  return commit(repoRoot, message);
}

/**
 * Pure index query (review 02 R2-01): `status --porcelain` also lists
 * unstaged and untracked paths, so runner-internal `.ateam` churn made an
 * EMPTY index look staged and derailed the crash-replay commit decision.
 * `diff --cached --quiet` exits 1 iff the index differs from HEAD.
 */
export async function hasStagedChanges(repoRoot: string): Promise<boolean> {
  const res = await git(repoRoot, ['diff', '--cached', '--quiet']);
  if (res.exitCode === 0) return false;
  if (res.exitCode === 1) return true;
  throw new Error(`git diff --cached --quiet failed (${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
}

export interface CherryPickResult {
  ok: boolean;
  conflicts: string[];
}

/** Cherry-pick one commit; conflict list is empty on success. */
export async function cherryPick(repoRoot: string, sha: string): Promise<CherryPickResult> {
  const res = await git(repoRoot, ['cherry-pick', sha]);
  if (res.ok) return { ok: true, conflicts: [] };
  const out = (await git(repoRoot, ['diff', '--name-only', '--diff-filter=U'])).stdout;
  const conflicts = out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (conflicts.length === 0) {
    throw new Error(`cherry-pick ${sha} failed without conflict markers: ${res.stderr.trim()}`);
  }
  return { ok: false, conflicts };
}

export async function cherryPickAbort(repoRoot: string): Promise<void> {
  await git(repoRoot, ['cherry-pick', '--abort']);
}

export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const res = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return res.ok;
}

/** Branches currently checked out in any worktree of the repo. */
export async function worktreeBranches(repoRoot: string): Promise<Set<string>> {
  const out = await gitOk(repoRoot, ['worktree', 'list', '--porcelain']);
  const branches = new Set<string>();
  for (const line of out.split('\n')) {
    if (line.startsWith('branch ')) {
      branches.add(line.slice('branch '.length).trim().replace(/^refs\/heads\//, ''));
    }
  }
  return branches;
}

/** Delete a branch only after confirming no worktree holds it. A branch
 * that no longer exists satisfies the postcondition — retries after a
 * crash mid-cleanup succeed instead of failing forever (review 01 #11). */
export async function deleteBranchIfFree(repoRoot: string, branch: string): Promise<boolean> {
  const held = await worktreeBranches(repoRoot);
  if (held.has(branch)) return false;
  if (!(await branchExists(repoRoot, branch))) return true;
  const res = await git(repoRoot, ['branch', '-D', branch]);
  return res.ok;
}
