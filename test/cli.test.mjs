import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function cli(args) {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
}

test('CLI exposes foreground run only', () => {
  const help = cli(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /run <run-id>/);
  assert.doesNotMatch(help.stdout, /--detach|stop <run-id>/);

  const detached = cli(['run', 'demo', '--detach']);
  assert.notEqual(detached.status, 0);
  assert.match(detached.stderr, /Unknown run option: --detach/);

  const stopped = cli(['stop', 'demo']);
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /Unknown command: stop/);
});
