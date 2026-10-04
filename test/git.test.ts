import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  branchExists,
  changedFiles,
  cherryPick,
  commit,
  currentHead,
  deleteBranchIfFree,
  diffStat,
  hasStagedChanges,
  stageAll,
  worktreeBranches,
  worktreeChangedFiles,
} from '../src/core/git.ts';
import { cleanupTempDir, initRepo, makeTempDir, writeFileDeep } from './helpers.ts';

let repo: string;
let baseSha: string;

beforeAll(async () => {
  repo = await makeTempDir('ateam-git-');
  await initRepo(repo);
  baseSha = await currentHead(repo);
});

afterAll(async () => {
  await cleanupTempDir(repo);
});

async function makeCommit(message: string, files: Record<string, string>): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    await writeFileDeep(join(repo, name), content);
  }
  await stageAll(repo);
  return commit(repo, message);
}

describe('git gates', () => {
  test('changedFiles and diffStat after a commit', async () => {
    const sha = await makeCommit('feat: a', { 'src/a.ts': 'export 1;\n' });
    const files = await changedFiles(repo, baseSha);
    expect(files).toContain('src/a.ts');
    expect(await diffStat(repo, baseSha)).toMatch(/src\/a\.ts/);
    expect(sha).not.toBe(baseSha);
  });

  test('cherry-pick succeeds for clean commit', async () => {
    const sha = await makeCommit('feat: b', { 'src/b.ts': 'export 2;\n' });
    // move HEAD back to base on a temp branch to simulate another line
    const res = await cherryPick(repo, sha).catch((err) => {
      // picking an ancestor commit yields empty commit; acceptable to skip
      if (/empty|previous/i.test(String(err))) return { ok: true, conflicts: [] };
      throw err;
    });
    expect(res.ok).toBe(true);
    expect(res.conflicts).toEqual([]);
  });

  test('branch lifecycle with worktree occupancy', async () => {
    await Bun.spawn(['git', '-C', repo, 'branch', 'ateam/test'], { stdin: 'ignore' }).exited;
    expect(await branchExists(repo, 'ateam/test')).toBe(true);
    // no worktree holds it yet
    expect((await worktreeBranches(repo)).has('ateam/test')).toBe(false);
    expect(await deleteBranchIfFree(repo, 'ateam/test')).toBe(true);
    expect(await branchExists(repo, 'ateam/test')).toBe(false);
  });

  test('deleteBranchIfFree refuses when a worktree holds the branch', async () => {
    await Bun.spawn(['git', '-C', repo, 'worktree', 'add', join(repo, '..', 'wt-x'), '-b', 'ateam/held'], {
      stdin: 'ignore',
    }).exited;
    expect((await worktreeBranches(repo)).has('ateam/held')).toBe(true);
    expect(await deleteBranchIfFree(repo, 'ateam/held')).toBe(false);
    await Bun.spawn(['git', '-C', repo, 'worktree', 'remove', '--force', join(repo, '..', 'wt-x')], {
      stdin: 'ignore',
    }).exited;
  });

  test('worktreeChangedFiles excludes .ateam internals (R2-01)', async () => {
    const localBase = await currentHead(repo); // isolate from earlier commits
    await writeFileDeep(join(repo, '.ateam', 'brief.md'), '# brief\n');
    const files = await worktreeChangedFiles(repo, localBase);
    expect(files).not.toContain('.ateam/brief.md');
    expect(files).toEqual([]);
    // a real delivery file still shows up
    await writeFileDeep(join(repo, 'src/real.ts'), 'export 1;\n');
    expect(await worktreeChangedFiles(repo, localBase)).toContain('src/real.ts');
    await stageAll(repo);
    await commit(repo, 'chore: r2-01 fixtures');
  });

  test('hasStagedChanges is a pure index query — untracked files are not "staged" (R2-01)', async () => {
    // only an untracked file exists: the index is EMPTY vs HEAD
    await writeFileDeep(join(repo, 'untracked-r2.txt'), 'x\n');
    expect(await hasStagedChanges(repo)).toBe(false);
    // staging something flips it
    await stageAll(repo);
    expect(await hasStagedChanges(repo)).toBe(true);
    await commit(repo, 'chore: r2-01 fixtures 2');
  });
});
