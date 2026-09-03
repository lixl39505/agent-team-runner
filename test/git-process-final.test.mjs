import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  abortCherryPick,
  changedFiles,
  cherryPick,
  commit,
  conflictedFiles,
  continueCherryPick,
  createWorktree,
  currentHead,
  ensureGitRepo,
  execFile,
  git,
  isClean,
  revParse,
  stageAll,
  unstageAll
} from '../src/core/git.ts';

async function tempRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-git-final-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'test']);
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'base']);
  return { root, baseSha: await currentHead(root) };
}

test('createWorktree preserves an existing worktree and attaches an existing branch', async (t) => {
  const { root, baseSha } = await tempRepo(t);
  const branch = 'agent-team/existing';
  const path = join(root, 'worktrees', 'existing');
  await git(root, ['branch', branch, baseSha]);

  await createWorktree({ repoRoot: root, path, branch, baseSha });
  assert.equal((await git(path, ['branch', '--show-current'])).stdout.trim(), branch);
  assert.equal(await currentHead(path), baseSha);

  writeFileSync(join(path, 'left-behind.txt'), 'keep me\n');
  await createWorktree({ repoRoot: root, path, branch, baseSha });
  assert.deepEqual(await changedFiles(path), ['left-behind.txt']);
});

test('changedFiles handles porcelain v1 ordinary, rename, copy, and NUL-delimited paths', async (t) => {
  const { root } = await tempRepo(t);
  for (const file of ['deleted.txt', 'rename-from.txt', 'copy-from.txt']) {
    writeFileSync(join(root, file), `${file}\n`);
  }
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'tracked files']);
  await git(root, ['config', 'status.renames', 'copies']);
  await git(root, ['config', 'diff.renames', 'copies']);

  writeFileSync(join(root, 'tracked.txt'), 'modified\n');
  await git(root, ['rm', '-q', 'deleted.txt']);
  writeFileSync(join(root, 'staged.txt'), 'staged\n');
  await git(root, ['add', 'staged.txt']);
  await git(root, ['mv', 'rename-from.txt', 'rename-to.txt']);
  writeFileSync(join(root, 'copy-from.txt'), 'copy-from changed\n');
  writeFileSync(join(root, 'copy-to.txt'), 'copy-from.txt\n');
  await git(root, ['add', 'copy-to.txt']);
  mkdirSync(join(root, 'untracked'), { recursive: true });
  writeFileSync(join(root, 'untracked', 'nested file.txt'), 'new\n');

  assert.deepEqual(await changedFiles(root), [
    'copy-from.txt',
    'copy-to.txt',
    'deleted.txt',
    'rename-from.txt',
    'rename-to.txt',
    'staged.txt',
    'tracked.txt',
    'untracked/nested file.txt'
  ]);
  // rename/copy 条目两端都记录：目标（实际写入位置）+ 源（被删除/移动的原位置）。
  assert.deepEqual(await changedFilesFromPorcelain('C  copy-to.txt\0copy-from.txt\0'), ['copy-from.txt', 'copy-to.txt']);
});

test('Git helpers stage, unstage, commit, parse refs, and report command failures', async (t) => {
  const { root, baseSha } = await tempRepo(t);
  await ensureGitRepo(root);
  assert.equal(await revParse(root, 'HEAD'), baseSha);
  const nonRepository = mkdtempSync(join(tmpdir(), 'agent-team-not-a-repository-'));
  onTestFinished(() => rmSync(nonRepository, { recursive: true, force: true }));
  await assert.rejects(ensureGitRepo(nonRepository), /git rev-parse/);

  const command = await execFile(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err')"], root);
  assert.deepEqual(command, { code: 0, stdout: 'out', stderr: 'err' });
  const failed = await git(root, ['rev-parse', '--verify', 'does-not-exist'], true);
  assert.notEqual(failed.code, 0);
  await assert.rejects(git(root, ['rev-parse', '--verify', 'does-not-exist']), /failed/);

  writeFileSync(join(root, 'tracked.txt'), 'ready\n');
  assert.equal(await isClean(root), false);
  await stageAll(root);
  assert.equal((await git(root, ['diff', '--cached', '--name-only'])).stdout.trim(), 'tracked.txt');
  await unstageAll(root);
  assert.equal((await git(root, ['diff', '--cached', '--name-only'])).stdout, '');
  await stageAll(root);
  const sha = await commit(root, 'helper commit');
  assert.equal(sha, await currentHead(root));
  assert.notEqual(sha, baseSha);
  assert.equal(await isClean(root), true);
});

test('cherry-pick helpers list conflicts, abort, and continue a resolved pick', async (t) => {
  const { root } = await tempRepo(t);
  writeFileSync(join(root, 'conflict.txt'), 'base\n');
  await git(root, ['add', 'conflict.txt']);
  await git(root, ['commit', '-q', '-m', 'conflict base']);
  await git(root, ['checkout', '-q', '-b', 'topic']);
  writeFileSync(join(root, 'conflict.txt'), 'topic\n');
  await git(root, ['add', 'conflict.txt']);
  await git(root, ['commit', '-q', '-m', 'topic change']);
  const topicSha = await currentHead(root);

  await git(root, ['checkout', '-q', 'main']);
  writeFileSync(join(root, 'conflict.txt'), 'main\n');
  await git(root, ['add', 'conflict.txt']);
  await git(root, ['commit', '-q', '-m', 'main change']);
  const mainSha = await currentHead(root);

  assert.notEqual((await cherryPick(root, topicSha)).code, 0);
  assert.deepEqual(await conflictedFiles(root), ['conflict.txt']);
  await abortCherryPick(root);
  assert.equal(await currentHead(root), mainSha);

  assert.notEqual((await cherryPick(root, topicSha)).code, 0);
  writeFileSync(join(root, 'conflict.txt'), 'resolved\n');
  await continueCherryPick(root);
  assert.equal((await git(root, ['show', 'HEAD:conflict.txt'])).stdout, 'resolved\n');
  assert.equal(await conflictedFiles(root).then((files) => files.length), 0);
});

let processTreeModuleId = 0;
let gitParserModuleId = 0;

async function changedFilesFromPorcelain(stdout) {
  const source = readFileSync(new URL('../src/core/git.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function changedFiles');
  const end = source.indexOf('export async function stageAll');
  assert.ok(start >= 0 && end > start, 'changedFiles must remain a standalone helper');
  const parser = source.slice(start, end)
    .replace('export async function changedFiles(worktree: string): Promise<string[]> {', 'export async function changedFiles(worktree) {')
    .replace('const files: string[] = [];', 'const files = [];')
    .replace('entries[index]!', 'entries[index]');
  const module = `const git = async () => ({ stdout: ${JSON.stringify(stdout)} });\n${parser}`;
  return (await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(module)}#${gitParserModuleId++}`)).changedFiles('ignored');
}

async function loadWindowsProcessTree(spawnImplementation) {
  const source = readFileSync(new URL('../src/agent/process-tree.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ spawn, type ChildProcess \} from 'node:child_process';/);
  globalThis.__agentTeamProcessTreeSpawn = spawnImplementation;
  const patched = source
    .replace("import { spawn, type ChildProcess } from 'node:child_process';", 'const spawn = globalThis.__agentTeamProcessTreeSpawn;')
    .replace("export function killProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {", 'export function killProcessTree(child, signal) {')
    .replace("process.platform === 'win32'", 'true');
  try {
    return await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(patched)}#${processTreeModuleId++}`);
  } finally {
    delete globalThis.__agentTeamProcessTreeSpawn;
  }
}

test('Windows process-tree path invokes taskkill and falls back when taskkill cannot run', async () => {
  let taskkillError;
  const calls = [];
  const killer = {
    once(event, listener) {
      assert.equal(event, 'error');
      taskkillError = listener;
    },
    unref() { calls.push('unref'); }
  };
  const { killProcessTree } = await loadWindowsProcessTree((program, args, options) => {
    calls.push([program, args, options]);
    return killer;
  });
  const childSignals = [];
  killProcessTree({ pid: 4321, kill: (signal) => childSignals.push(signal) }, 'SIGTERM');
  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '4321', '/T', '/F'], { stdio: 'ignore', windowsHide: true }], 'unref']);
  assert.deepEqual(childSignals, []);
  taskkillError();
  assert.deepEqual(childSignals, ['SIGTERM']);

  const throwingSpawn = await loadWindowsProcessTree(() => { throw new Error('taskkill missing'); });
  const fallbackSignals = [];
  throwingSpawn.killProcessTree({ pid: 99, kill: (signal) => fallbackSignals.push(signal) }, 'SIGKILL');
  assert.deepEqual(fallbackSignals, ['SIGKILL']);

  const ignoredKillError = await loadWindowsProcessTree(() => { throw new Error('taskkill missing'); });
  assert.doesNotThrow(() => ignoredKillError.killProcessTree({ pid: 100, kill: () => { throw new Error('already exited'); } }, 'SIGTERM'));
});
