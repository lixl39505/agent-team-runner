import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const control = vi.hoisted(() => ({ synced: [], verified: [] }));
vi.mock('../src/core/files.ts', () => ({
  syncSkills: (repo) => {
    control.synced.push(repo);
    return ['skill-a', 'skill-b'];
  }
}));
vi.mock('../src/core/git.ts', () => ({
  ensureGitRepo: async (repo) => { control.verified.push(repo); }
}));

const { runCli } = await import('../src/cli.ts');

async function capture(args) {
  const output = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value = '') => output.push(String(value)));
  try {
    await runCli(args);
    return output;
  } finally {
    log.mockRestore();
  }
}

test('init and skills commands resolve repositories and reject malformed input', async () => {
  control.synced = [];
  control.verified = [];
  assert.deepEqual(await capture(['init', '/tmp/init-repo']), ['Synced 2 host skill files.']);
  assert.deepEqual(await capture(['init']), ['Synced 2 host skill files.']);
  assert.deepEqual(await capture(['skills', 'sync', '--repo', '/tmp/skills-repo']), ['skill-a\nskill-b']);
  assert.deepEqual(await capture(['skills', 'sync']), ['skill-a\nskill-b']);
  assert.equal(control.verified.length, 2);
  assert.equal(control.synced.length, 4);
  await assert.rejects(runCli(['skills', 'copy']), /Usage:/);
  await assert.rejects(runCli(['skills', 'sync', '--repo']), /requires a value/);
});
