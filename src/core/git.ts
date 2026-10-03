// Minimal git plumbing used by the delivery gates. All operations are
// anchored to an explicit repo/worktree path — never to process cwd.

import { runArgv, type CommandResult } from './shell.ts';

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

/** Files changed between two refs (name-only, no renames splitting). */
export async function changedFiles(repoRoot: string, fromSha: string, toSha = 'HEAD'): Promise<string[]> {
  const out = await gitOk(repoRoot, ['diff', '--name-only', fromSha, toSha]);
  return out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * Worktree-level change set vs a base sha: committed diffs PLUS staged/
 * modified/untracked files (workers edit without committing — the runner
 * commits only after verification passes).
 */
export async function worktreeChangedFiles(repoRoot: string, fromSha: string): Promise<string[]> {
  const status = await gitRaw(repoRoot, ['status', '--porcelain', '-uall']);
  const diff = await gitOk(repoRoot, ['diff', '--name-only', fromSha]);
  const files = new Set<string>();
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) p = p.split(' -> ').pop()!.trim();
    if (p) files.add(p);
  }
  for (const line of diff.split('\n')) {
    const t = line.trim();
    if (t) files.add(t);
  }
  return [...files];
}

export async function diffStat(repoRoot: string, fromSha: string, toSha = 'HEAD'): Promise<string> {
  return gitOk(repoRoot, ['diff', '--stat', fromSha, toSha]);
}

export async function stageAll(repoRoot: string): Promise<void> {
  // .ateam/** is runner bookkeeping — never part of a delivery commit
  await gitOk(repoRoot, ['add', '-A', '--', '.', ':!.ateam']);
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

export async function hasStagedChanges(repoRoot: string): Promise<boolean> {
  const out = await gitOk(repoRoot, ['status', '--porcelain']);
  return out.length > 0;
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

/** Delete a branch only after confirming no worktree holds it. */
export async function deleteBranchIfFree(repoRoot: string, branch: string): Promise<boolean> {
  const held = await worktreeBranches(repoRoot);
  if (held.has(branch)) return false;
  const res = await git(repoRoot, ['branch', '-D', branch]);
  return res.ok;
}
