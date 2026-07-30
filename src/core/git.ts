import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(cwd: string, args: string[], allowFailure = false): Promise<ExecResult> {
  const result = await execFile('git', args, cwd);
  if (!allowFailure && result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  return result;
}

export async function execFile(program: string, args: string[], cwd: string): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function ensureGitRepo(repoRoot: string): Promise<void> {
  const result = await git(repoRoot, ['rev-parse', '--show-toplevel']);
  if (!result.stdout.trim()) throw new Error(`${repoRoot} is not a Git repository`);
}

export async function revParse(repoRoot: string, ref: string): Promise<string> {
  return (await git(repoRoot, ['rev-parse', ref])).stdout.trim();
}

export async function currentHead(worktree: string): Promise<string> {
  return revParse(worktree, 'HEAD');
}

export async function createWorktree(input: {
  repoRoot: string;
  path: string;
  branch: string;
  baseSha: string;
}): Promise<void> {
  if (existsSync(input.path)) return;
  mkdirSync(dirname(input.path), { recursive: true });
  const branchExists = (await git(input.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${input.branch}`], true)).code === 0;
  if (branchExists) {
    await git(input.repoRoot, ['worktree', 'add', input.path, input.branch]);
  } else {
    await git(input.repoRoot, ['worktree', 'add', '-b', input.branch, input.path, input.baseSha]);
  }
}

export async function changedFiles(worktree: string): Promise<string[]> {
  const result = await git(worktree, ['status', '--porcelain=v1', '-z']);
  if (!result.stdout) return [];
  const entries = result.stdout.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes('R') || status.includes('C')) {
      const next = entries[index + 1];
      if (next) { files.push(next); index += 1; }
      else files.push(path);
    } else {
      files.push(path);
    }
  }
  return [...new Set(files)].sort();
}

export async function stageAll(worktree: string): Promise<void> {
  await git(worktree, ['add', '-A']);
}

export async function unstageAll(worktree: string): Promise<void> {
  await git(worktree, ['reset']);
}

export async function commit(worktree: string, message: string): Promise<string> {
  await git(worktree, ['commit', '-m', message]);
  return currentHead(worktree);
}

export async function isClean(worktree: string): Promise<boolean> {
  return (await changedFiles(worktree)).length === 0;
}

export async function cherryPick(worktree: string, commitSha: string): Promise<ExecResult> {
  return git(worktree, ['cherry-pick', commitSha], true);
}

export async function conflictedFiles(worktree: string): Promise<string[]> {
  const result = await git(worktree, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return result.stdout.split('\0').filter(Boolean);
}

export async function continueCherryPick(worktree: string): Promise<void> {
  await git(worktree, ['add', '-A']);
  await git(worktree, ['cherry-pick', '--continue']);
}

export async function abortCherryPick(worktree: string): Promise<void> {
  await git(worktree, ['cherry-pick', '--abort'], true);
}
