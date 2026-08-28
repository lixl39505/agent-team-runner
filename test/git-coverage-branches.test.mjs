import { test } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { changedFiles, ensureGitRepo, execFile, git, resetWorktree } from '../src/core/git.ts';

async function withFakeGit(mode, run) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-fake-git-'));
  const executable = join(directory, 'git');
  writeFileSync(executable, `#!${process.execPath}
if (process.env.AGENT_TEAM_FAKE_GIT_MODE === 'rename-without-source') process.stdout.write('R  lone-path\\0');
`);
  chmodSync(executable, 0o755);
  const previousPath = process.env.PATH;
  const previousMode = process.env.AGENT_TEAM_FAKE_GIT_MODE;
  process.env.PATH = `${directory}${delimiter}${previousPath ?? ''}`;
  process.env.AGENT_TEAM_FAKE_GIT_MODE = mode;
  try {
    await run();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMode === undefined) delete process.env.AGENT_TEAM_FAKE_GIT_MODE;
    else process.env.AGENT_TEAM_FAKE_GIT_MODE = previousMode;
    rmSync(directory, { recursive: true, force: true });
  }
}

test('Git helpers cover fallback output, signal exits, and fake Git edge cases', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-git-coverage-'));
  try {
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'changed.txt'), 'base\n');
    await git(repo, ['add', 'changed.txt']);
    await git(repo, ['commit', '-q', '-m', 'base']);
    writeFileSync(join(repo, 'changed.txt'), 'changed\n');
    await assert.rejects(git(repo, ['diff', '--exit-code']), /diff --git/);

    const signalExit = await execFile(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], repo);
    assert.equal(signalExit.code, 1);

    await withFakeGit('empty', async () => {
      await assert.rejects(ensureGitRepo(repo), new RegExp(`${repo} is not a Git repository`));

      const worktree = join(repo, 'integration');
      writeFileSync(worktree, 'left behind\n');
      await resetWorktree({ repoRoot: repo, path: worktree, branch: 'integration', baseSha: 'base' });
      assert.equal(existsSync(worktree), false);
    });

    await withFakeGit('rename-without-source', async () => {
      assert.deepEqual(await changedFiles(repo), ['lone-path']);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
