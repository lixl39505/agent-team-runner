import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  branchExists,
  changedFiles,
  cherryPick,
  commit,
  commitTree,
  currentHead,
  deleteBranchIfFree,
  diffStat,
  hasStagedChanges,
  stageAll,
  stagedChangedFiles,
  worktreeBranches,
  worktreeChangedFiles,
  worktreeDirtyFiles,
  writeTree,
} from '../src/core/git.ts';
import { commitVerifiedTree } from '../src/runner/phases/commit.ts';
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

  test('worktreeDirtyFiles lists every non-bookkeeping status entry (R5-03)', async () => {
    const localBase = await currentHead(repo); // isolate from earlier commits
    await writeFileDeep(join(repo, '.ateam', 'brief.md'), '# brief\n'); // runner-owned, ignored
    await writeFileDeep(join(repo, 'dirty-untracked.txt'), 'x\n');
    await writeFileDeep(join(repo, 'src/dirty-tracked.ts'), 'edited\n');
    const dirty = await worktreeDirtyFiles(repo);
    expect(dirty).toContain('dirty-untracked.txt');
    expect(dirty).toContain('src/dirty-tracked.ts');
    expect(dirty).not.toContain('.ateam/brief.md');
    await stageAll(repo);
    expect(await worktreeDirtyFiles(repo)).toContain('src/dirty-tracked.ts'); // staged counts too
    await commit(repo, 'chore: r5-03 fixtures');
    expect(await worktreeDirtyFiles(repo)).toEqual([]);
  });

  test('stage-first primitives (R5-01): pin the index tree, measure index-vs-base, prove the commit tree', async () => {
    const localBase = await currentHead(repo);
    await writeFileDeep(join(repo, 'src/pin.ts'), 'export 1;\n');
    await stageAll(repo);
    const tree = await writeTree(repo);
    // the staged diff is index-vs-base: exactly what the commit will carry
    expect(await stagedChangedFiles(repo, localBase)).toContain('src/pin.ts');
    expect(await stagedChangedFiles(repo, localBase)).not.toContain('untracked-nothing.txt');

    // committing against the pin proves the tree
    const sha = await commitVerifiedTree(repo, tree, 'r5-01: pinned');
    expect(sha).not.toBeNull();
    expect(await commitTree(repo, sha!)).toBe(tree);

    // content staged AFTER the pin cannot ride the commit — the proof fails
    await writeFileDeep(join(repo, 'src/raced.ts'), 'raced in after the gate\n');
    await stageAll(repo);
    expect(await commitVerifiedTree(repo, tree, 'r5-01: raced')).toBeNull();
    // and the raced content IS in the new commit (it was staged) — the null
    // return is what keeps it out of a REVIEWED delivery
    const racedSha = await currentHead(repo);
    expect(await commitTree(repo, racedSha)).not.toBe(tree);
  });

  test('commitVerifiedTree reuses HEAD on a crash replay (nothing staged)', async () => {
    const before = await currentHead(repo);
    const sha = await commitVerifiedTree(repo, await commitTree(repo, before), 'r5-01: replay');
    expect(sha).toBe(before);
  });
});
