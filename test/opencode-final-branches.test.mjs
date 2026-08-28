import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { OpenCodeBackend } from '../src/agent/opencode/sdk.ts';

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
  }

  setEncoding(encoding) { this.encoding = encoding; }
  destroy() { this.destroyed = true; }
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

function spec(overrides = {}) {
  return {
    role: 'worker',
    cwd: '/workspace',
    prompt: 'Return JSON',
    schema: { type: 'object' },
    access: 'workspace-write',
    timeoutMs: 1_000,
    staleAfterMs: 1_000,
    ...overrides
  };
}

async function open(response) {
  const backend = new OpenCodeBackend();
  const calls = { aborts: [] };
  const client = {
    session: {
      async create() { return { data: { id: 'session-1' } }; },
      async prompt() { return response; },
      async abort(request) { calls.aborts.push(request); }
    }
  };
  backend.ensureClient = async () => client;
  backend.ensureSubscribed = async () => {};
  backend.questionClient = { question: {} };
  return { backend, calls, session: await backend.openSession(spec()) };
}

test('OpenCode platform seams, getters, and discovery stay local', async (t) => {
  const defaultBackend = new OpenCodeBackend();
  assert.equal(defaultBackend.command, 'opencode');
  assert.equal(typeof defaultBackend.spawn, 'function');

  const blocked = new OpenCodeBackend({ platform: 'win32' });
  assert.equal((await blocked.checkPlatform()).ok, false);
  const degraded = new OpenCodeBackend({ platform: 'win32', nativeWindowsSandbox: 'allow-degraded' });
  assert.deepEqual(await degraded.checkPlatform(), {
    ok: true,
    degraded: true,
    detail: 'opencode has no equivalent native Windows process sandbox; use WSL2 for strong isolation; unsandboxed execution was explicitly allowed'
  });

  const calls = [];
  const installedChild = new FakeChild();
  const installedBackend = new OpenCodeBackend({
    command: 'fake-opencode',
    spawn(...args) { calls.push(args); return installedChild; }
  });
  assert.equal(installedBackend.command, 'fake-opencode');
  const installed = installedBackend.discover();
  installedChild.stdout.emit('data', Buffer.from('1.2.3\n'));
  installedChild.emit('close', 0);
  assert.deepEqual(await installed, { backend: 'opencode', installed: true, version: '1.2.3' });
  assert.deepEqual(calls[0], ['fake-opencode', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }]);

  assert.deepEqual(await new OpenCodeBackend({ command: 'missing', spawn() { throw new Error('missing'); } }).discover(), {
    backend: 'opencode', installed: false, detail: 'failed to spawn missing'
  });

  const failedChild = new FakeChild();
  const failed = new OpenCodeBackend({ command: 'fake-opencode', spawn() { return failedChild; } }).discover();
  failedChild.emit('close', 2);
  assert.deepEqual(await failed, { backend: 'opencode', installed: false, version: undefined, detail: 'exit 2' });

  const erroredChild = new FakeChild();
  const errored = new OpenCodeBackend({ command: 'fake-opencode', spawn() { return erroredChild; } }).discover();
  erroredChild.emit('error', new Error('ENOENT'));
  assert.deepEqual(await errored, { backend: 'opencode', installed: false, detail: 'failed to spawn fake-opencode' });

  vi.useFakeTimers();
  const timedOutChild = new FakeChild();
  const timedOut = new OpenCodeBackend({ command: 'fake-opencode', spawn() { return timedOutChild; } }).discover();
  vi.advanceTimersByTime(10_000);
  vi.useRealTimers();
  assert.deepEqual(await timedOut, { backend: 'opencode', installed: false, detail: 'version probe timed out' });
  assert.deepEqual(timedOutChild.kills, ['SIGKILL']);
});

test('OpenCode probe closes its session after a failed completion', async () => {
  const backend = new OpenCodeBackend();
  let opened;
  let closed = 0;
  backend.openSession = async (value) => {
    opened = value;
    return {
      async completion() { return { ok: false, error: 'provider unavailable' }; },
      async close() { closed += 1; }
    };
  };

  const result = await backend.probe('provider/model');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'provider unavailable');
  assert.equal(typeof result.latencyMs, 'number');
  assert.equal(opened.model, 'provider/model');
  assert.equal(opened.access, 'read-only');
  assert.equal(closed, 1);
});

test('OpenCode killServer clears fake stdio without a real process', (t) => {
  vi.useFakeTimers();
  const backend = new OpenCodeBackend();
  const child = new FakeChild();
  backend.serverChild = child;

  backend.killServer();
  vi.advanceTimersByTime(3_000);
  vi.useRealTimers();

  assert.equal(backend.serverChild, null);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test('OpenCode consumes a completed fake subscription and releases it', async () => {
  const backend = new OpenCodeBackend();
  let activity = 0;
  backend.sessions.set('active', { onActivity() { activity += 1; } });
  const client = {
    event: {
      async subscribe() {
        return {
          stream: (async function* () {
            yield { sessionID: 'active' };
          })()
        };
      }
    }
  };

  await backend.ensureSubscribed(client);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(activity, 1);
  assert.equal(backend.eventStream, null);
  assert.equal(backend.subscribed, false);
  assert.equal(backend.subscribePromise, null);
});

test('OpenCode provider fallback and close reuse one remote abort', async () => {
  const named = await open({ data: { info: { error: { name: 'Unavailable' } } } });
  assert.equal((await named.session.completion()).error, 'opencode provider error: Unavailable');

  const unknown = await open({ data: { info: { error: {} } } });
  assert.equal((await unknown.session.completion()).error, 'opencode provider error: unknown provider error');
  await unknown.session.interrupt();
  await unknown.session.close();
  await unknown.session.close();

  assert.deepEqual(unknown.calls.aborts, [{ path: { id: 'session-1' } }]);
  assert.equal(unknown.backend.sessions.size, 0);
});
