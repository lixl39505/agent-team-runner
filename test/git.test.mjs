import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorktree, resetWorktree, currentHead, changedFiles, git } from '../dist/core/git.js';

async function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-git-'));
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'test']);
  writeFileSync(join(repoRoot, 'a.txt'), 'base\n', 'utf8');
  writeFileSync(join(repoRoot, '.gitignore'), 'ignored/\n', 'utf8');
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  return { repoRoot, baseSha: await currentHead(repoRoot) };
}

test('resetWorktree discards dirty state and recreates from baseSha', async () => {
  const { repoRoot, baseSha } = await tempRepo();
  const path = join(repoRoot, 'wt');
  const branch = 'agent-team/test/integration';
  await createWorktree({ repoRoot, path, branch, baseSha });
  // 模拟上次集成失败：worktree 里留下脏文件，分支上有额外提交
  writeFileSync(join(path, 'a.txt'), 'dirty\n', 'utf8');
  writeFileSync(join(path, 'leftover.txt'), 'junk\n', 'utf8');
  mkdirSync(join(path, 'ignored'));
  writeFileSync(join(path, 'ignored', 'cache.txt'), 'stale\n', 'utf8');
  await git(path, ['add', '-A']);
  await git(path, ['commit', '-q', '-m', 'partial integration']);

  await resetWorktree({ repoRoot, path, branch, baseSha });

  assert.ok(existsSync(path));
  assert.equal(await currentHead(path), baseSha);
  assert.deepEqual(await changedFiles(path), []);
  assert.equal(existsSync(join(path, 'ignored', 'cache.txt')), false, 'ignored files from the interrupted attempt are discarded');
  // 幂等：重复 reset 不报错、状态不变
  await resetWorktree({ repoRoot, path, branch, baseSha });
  assert.equal(await currentHead(path), baseSha);
});

test('runner Git operations never execute repository hooks', async () => {
  const { repoRoot } = await tempRepo();
  const sentinel = join(repoRoot, 'hook-ran');
  const hook = join(repoRoot, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\ntouch "${sentinel}"\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(repoRoot, 'a.txt'), 'changed\n');
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'safe commit']);
  assert.equal(existsSync(sentinel), false);
});

test('runner Git operations preserve configured global commit identity', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-git-identity-'));
  const globalConfig = join(repoRoot, 'global.gitconfig');
  writeFileSync(globalConfig, '[user]\n\tname = Global Test User\n\temail = global@example.com\n');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    await git(repoRoot, ['init', '-q']);
    writeFileSync(join(repoRoot, 'a.txt'), 'base\n');
    await git(repoRoot, ['add', '-A']);
    await git(repoRoot, ['commit', '-q', '-m', 'global identity']);
    const author = await git(repoRoot, ['log', '-1', '--format=%an <%ae>']);
    assert.equal(author.stdout.trim(), 'Global Test User <global@example.com>');
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});
