import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import spawn from 'cross-spawn';
import { gitIsolationEnv } from './process-env.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(cwd: string, args: string[], allowFailure = false): Promise<ExecResult> {
  const safeArgs = args[0] === 'diff'
    ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)]
    : args;
  const result = await execFile('git', safeArgs, cwd);
  if (!allowFailure && result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  return result;
}

export async function execFile(program: string, args: string[], cwd: string): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: { ...process.env, ...gitIsolationEnv() }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
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

// 集成 worktree 是一次性的：无论上次集成停在什么状态（脏文件/冲突/cherry-pick 中断），
// 都强制清掉 worktree 与分支、从 baseSha 重建，保证 integrateRun 可以安全重跑。
export async function resetWorktree(input: {
  repoRoot: string;
  path: string;
  branch: string;
  baseSha: string;
}): Promise<void> {
  if (existsSync(input.path)) {
    await git(input.repoRoot, ['worktree', 'remove', '--force', input.path], true);
    if (existsSync(input.path)) rmSync(input.path, { recursive: true, force: true });
  }
  await git(input.repoRoot, ['worktree', 'prune', input.path], true);
  await git(input.repoRoot, ['branch', '-D', input.branch], true);
  mkdirSync(dirname(input.path), { recursive: true });
  await git(input.repoRoot, ['worktree', 'add', '-b', input.branch, input.path, input.baseSha]);
}

export async function changedFiles(worktree: string): Promise<string[]> {
  // -uall：未跟踪目录展开为具体文件（默认会把整个未跟踪目录折叠成 "src/" 一条，
  // 无法与任务级 allowedPaths 的文件/glob 匹配）
  const result = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!result.stdout) return [];
  const entries = result.stdout.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes('R') || status.includes('C')) {
      // -z 格式下 rename/copy 记录为「XY 目标\0源\0」：目标（新写入位置）在本条目内，
      // 下一条目是源路径。两端都必须进入路径策略——只看目标会让 worker 把 blockedPaths
      // 中的文件改名/复制到允许路径后蒙混过关，只看源则看不到实际写入位置。
      const sourcePath = entries[index + 1];
      if (sourcePath !== undefined) {
        files.push(sourcePath);
        index += 1;
      }
      files.push(path);
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
