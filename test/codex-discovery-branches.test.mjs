import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexBackend } from '../src/agent/codex/app-server.ts';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); };
  return child;
}

function backendWithSpawn(spawn) {
  return new CodexBackend({ command: 'fake-codex', spawn });
}

test('Codex discovery reports synchronous spawn failures without starting a CLI', async () => {
  const result = await backendWithSpawn(() => { throw new Error('unavailable'); }).discover();
  assert.deepEqual(result, { backend: 'codex', installed: false, detail: 'failed to spawn fake-codex' });
});

test('Codex discovery reports asynchronous spawn errors', async () => {
  const child = fakeChild();
  const result = backendWithSpawn(() => child).discover();
  child.emit('error', new Error('ENOENT'));
  assert.deepEqual(await result, { backend: 'codex', installed: false, detail: 'failed to spawn fake-codex' });
});

test('Codex discovery kills a version probe that times out', async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let timer;
  global.setTimeout = (callback, delay, ...args) => {
    assert.equal(delay, 10_000);
    timer = { callback, args };
    return timer;
  };
  global.clearTimeout = () => {};

  try {
    const child = fakeChild();
    const result = backendWithSpawn(() => child).discover();
    timer.callback(...timer.args);
    assert.deepEqual(await result, { backend: 'codex', installed: false, detail: 'version probe timed out' });
    assert.deepEqual(child.kills, ['SIGKILL']);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('Codex discovery returns deterministic trimmed stdout after a successful close', async () => {
  const child = fakeChild();
  const result = backendWithSpawn((command, args, options) => {
    assert.equal(command, 'fake-codex');
    assert.deepEqual(args, ['--version']);
    assert.deepEqual(options, { stdio: ['ignore', 'pipe', 'ignore'] });
    return child;
  }).discover();
  child.stdout.emit('data', Buffer.from(' codex 1.2'));
  child.stdout.emit('data', Buffer.from('.3 \n'));
  child.emit('close', 0);
  assert.deepEqual(await result, { backend: 'codex', installed: true, version: 'codex 1.2.3' });
});

test('Codex discovery preserves stdout and reports nonzero closes', async () => {
  const child = fakeChild();
  const result = backendWithSpawn(() => child).discover();
  child.stdout.emit('data', Buffer.from('codex 1.2.3\n'));
  child.emit('close', 2);
  assert.deepEqual(await result, { backend: 'codex', installed: false, version: 'codex 1.2.3', detail: 'exit 2' });
});
