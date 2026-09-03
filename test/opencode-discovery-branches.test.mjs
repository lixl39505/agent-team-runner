import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { OpenCodeBackend } from '../src/agent/opencode/sdk.ts';

class FakeStream extends EventEmitter {
  setEncoding(encoding) { this.encoding = encoding; }
  destroy() {}
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.kills = [];
  }

  kill(signal) { this.kills.push(signal); return true; }
}

function backend(spawn, options = {}) {
  return new OpenCodeBackend({ command: 'fake-opencode', spawn, ...options });
}

test('OpenCode discovery handles spawn, output, exit, error, and timeout', async (t) => {
  const unavailable = await backend(() => { throw new Error('missing'); }).discover();
  assert.deepEqual(unavailable, {
    backend: 'opencode', installed: false, detail: 'failed to spawn fake-opencode'
  });

  const installedChild = new FakeChild();
  const installed = backend(() => installedChild).discover();
  installedChild.stdout.emit('data', Buffer.from('1.2.3\n'));
  installedChild.emit('close', 0);
  assert.deepEqual(await installed, { backend: 'opencode', installed: true, version: '1.2.3' });

  const exitedChild = new FakeChild();
  const exited = backend(() => exitedChild).discover();
  exitedChild.stdout.emit('data', Buffer.from('broken\n'));
  exitedChild.emit('close', 2);
  assert.deepEqual(await exited, {
    backend: 'opencode', installed: false, version: 'broken', detail: 'exit 2'
  });

  const errorChild = new FakeChild();
  const errored = backend(() => errorChild).discover();
  errorChild.emit('error', new Error('ENOENT'));
  assert.deepEqual(await errored, {
    backend: 'opencode', installed: false, detail: 'failed to spawn fake-opencode'
  });

  vi.useFakeTimers();
  const timeoutChild = new FakeChild();
  const timedOut = backend(() => timeoutChild).discover();
  vi.advanceTimersByTime(10_000);
  vi.useRealTimers();
  assert.deepEqual(await timedOut, {
    backend: 'opencode', installed: false, detail: 'version probe timed out'
  });
  assert.deepEqual(timeoutChild.kills, ['SIGKILL']);
});

test('OpenCode server launch handles output, exit, error, and timeout without a process', async (t) => {
  await assert.rejects(
    backend(() => { throw new Error('spawn blocked'); }).launchServer(),
    /spawn blocked/
  );

  const calls = [];
  const listeningChild = new FakeChild();
  const listeningBackend = backend((...args) => {
    calls.push(args);
    return listeningChild;
  }, { hostname: 'localhost', port: 4567, platform: 'win32' });
  const client = listeningBackend.launchServer();
  listeningChild.stdout.emit('data', 'booting\nopencode server listening on http://localhost:4567\n');
  assert.ok(await client);
  assert.deepEqual(calls[0].slice(0, 2), [
    'fake-opencode', ['serve', '--hostname=localhost', '--port=4567']
  ]);
  assert.equal(calls[0][2].detached, undefined); // 不再以 detached 启动
  assert.equal(listeningChild.stdout.encoding, 'utf8');
  assert.equal(listeningChild.stderr.encoding, 'utf8');

  const exitedChild = new FakeChild();
  const exited = backend(() => exitedChild).launchServer();
  exitedChild.stderr.emit('data', 'bad configuration');
  exitedChild.emit('exit', 7);
  await assert.rejects(exited, /opencode serve exited with 7: bad configuration/);

  const errorChild = new FakeChild();
  const errored = backend(() => errorChild).launchServer();
  errorChild.emit('error', new Error('ENOENT'));
  await assert.rejects(errored, /ENOENT/);

  vi.useFakeTimers();
  const timeoutChild = new FakeChild();
  const timedOut = backend(() => timeoutChild).launchServer();
  timeoutChild.stdout.emit('data', 'still booting');
  vi.advanceTimersByTime(15_000);
  vi.useRealTimers();
  await assert.rejects(timedOut, /opencode serve did not start within 15s; output: still booting/);
});
