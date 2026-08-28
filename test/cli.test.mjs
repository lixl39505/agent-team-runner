import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliCommand } from './fixtures/run-cli.mjs';

function temporaryGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-cli-'));
  const initialized = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  return repo;
}

test('CLI exposes foreground run only', async () => {
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const help = await runCliCommand(args);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /run <run-id>/);
    assert.doesNotMatch(help.stdout, /--detach|stop <run-id>/);
  }

  const detached = await runCliCommand(['run', 'demo', '--detach']);
  assert.notEqual(detached.status, 0);
  assert.match(detached.stderr, /Unknown run option: --detach/);

  const stopped = await runCliCommand(['stop', 'demo']);
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /Unknown command: stop/);
});

test('CLI initializes repositories and mirrors skills', async () => {
  const repo = temporaryGitRepo();
  try {
    const initialized = await runCliCommand(['init', repo]);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /Initialized: .*config\.yml/);
    assert.match(initialized.stdout, /Synced 8 host skill files/);
    assert.equal(existsSync(join(repo, '.agent-team', 'config.yml')), true);
    assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /\.agent-team\/state\.sqlite/);

    const synced = await runCliCommand(['skills', 'sync', '--repo', repo]);
    assert.equal(synced.status, 0, synced.stderr);
    assert.equal(synced.stdout.trim().split('\n').length, 8);
    assert.equal(existsSync(join(repo, '.claude', 'skills', 'team-lead', 'SKILL.md')), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI initializes the current repository when no path is supplied', async () => {
  const repo = temporaryGitRepo();
  try {
    const initialized = await runCliCommand(['init'], { cwd: repo });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(existsSync(join(repo, '.agent-team', 'config.yml')), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI handles list, status, and argument errors without opening a backend', async () => {
  const repo = temporaryGitRepo();
  try {
    assert.equal((await runCliCommand(['init', repo])).status, 0);
    const listed = await runCliCommand(['list', '--repo', repo]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout, '');

    const status = await runCliCommand(['status', '--repo', repo]);
    assert.notEqual(status.status, 0);
    assert.match(status.stderr, /No runs found/);

    for (const args of [
      ['skills', 'wrong', '--repo', repo],
      ['skills', 'sync', '--repo'],
      ['run'],
      ['plan'],
      ['help', '-c']
    ]) {
      const result = await runCliCommand(args);
      assert.notEqual(result.status, 0, args.join(' '));
    }
    assert.match((await runCliCommand(['skills', 'wrong', '--repo', repo])).stderr, /Usage: agent-team skills sync/);
    assert.match((await runCliCommand(['skills', 'sync', '--repo'])).stderr, /--repo requires a value/);
    assert.match((await runCliCommand(['run'])).stderr, /Usage: agent-team run/);
    assert.match((await runCliCommand(['plan'])).stderr, /Usage: agent-team plan/);
    assert.match((await runCliCommand(['help', '-c'])).stderr, /-c requires a value/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
