import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import { StateDatabase } from '../src/core/db.ts';

async function run(args) {
  const stdout = [];
  const stderr = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value = '') => stdout.push(String(value)));
  const error = vi.spyOn(console, 'error').mockImplementation((value = '') => stderr.push(String(value)));
  try {
    await runCli(args);
    return { status: 0, stdout: `${stdout.join('\n')}\n`, stderr: stderr.join('\n') };
  } catch (failure) {
    console.error(failure instanceof Error ? failure.message : String(failure));
    return { status: 1, stdout: `${stdout.join('\n')}\n`, stderr: stderr.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

test('runCli executes help, repository setup, and command validation in process', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'agent-team-cli-source-'));
  assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);
  try {
    assert.match((await run(['help'])).stdout, /Commands:/);
    const initialized = await run(['init', repository]);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /Initialized:/);

    const listed = await run(['list', '--repo', repository]);
    assert.equal(listed.status, 0, listed.stderr);

    const invalid = await run(['skills', 'unknown', '--repo', repository]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage: agent-team skills sync/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('runCli lists runs and stops an in-process status watch', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'agent-team-cli-watch-'));
  assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);
  mkdirSync(join(repository, '.agent-team'), { recursive: true });
  writeFileSync(join(repository, '.agent-team', 'config.json'), JSON.stringify({ version: 3, workspace: {}, retry: {}, status: {} }));
  const db = new StateDatabase(join(repository, '.agent-team', 'state.sqlite'));
  db.createRun({ id: 'watched', repoRoot: repository, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'claude' });
  db.close();
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  let cleared = false;
  try {
    await runCli(['list', '--repo', repository]);
    const watching = runCli(['status', '--watch', '--repo', repository]);
    process.emit('SIGTERM');
    await watching;
    cleared = write.mock.calls.some(([value]) => value === '\x1Bc');
  } finally {
    log.mockRestore();
    write.mockRestore();
    rmSync(repository, { recursive: true, force: true });
  }
  assert.equal(cleared, true);
});
