import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'vitest';
import { OpenCodeBackend } from '../src/agent/opencode/sdk.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
  }

  kill() { return true; }
}

function spec() {
  return {
    role: 'worker',
    cwd: '/workspace',
    prompt: 'Return JSON',
    schema: { type: 'object' },
    access: 'workspace-write',
    timeoutMs: 1_000,
    staleAfterMs: 1_000
  };
}

async function open(response) {
  const backend = new OpenCodeBackend();
  const aborts = [];
  const client = {
    session: {
      async create() { return { data: { id: 'fake-session' } }; },
      async prompt() { return response; },
      async abort(request) { aborts.push(request); }
    }
  };
  backend.ensureClient = async () => client;
  backend.ensureSubscribed = async () => {};
  backend.questionClient = { question: {} };
  return { aborts, session: await backend.openSession(spec()) };
}

test('OpenCode uses injected spawn, platform policy, and provider models', async () => {
  const child = new FakeChild();
  const calls = [];
  const backend = new OpenCodeBackend({
    command: 'fake-opencode',
    platform: 'win32',
    nativeWindowsSandbox: 'allow-degraded',
    spawn(...args) {
      calls.push(args);
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('fake-1.0\n'));
        child.emit('close', 0);
      });
      return child;
    }
  });

  assert.equal((await backend.checkPlatform()).degraded, true);
  assert.deepEqual(await backend.discover(), {
    backend: 'opencode', installed: true, version: 'fake-1.0'
  });
  assert.deepEqual(calls, [['fake-opencode', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }]]);

  backend.ensureClient = async () => ({
    config: {
      async providers() {
        return { data: { providers: [
          { id: 'good', models: { one: { name: 'One' }, two: {} } },
          { models: { ignored: {} } },
          { id: 'broken', error: 'unavailable', models: { ignored: {} } }
        ] } };
      }
    }
  });
  assert.deepEqual(await backend.listModels(), [
    { id: 'good/one', displayName: 'One' },
    { id: 'good/two', displayName: undefined }
  ]);
});

test('OpenCode consumes a private fake subscription without reconnecting', async () => {
  const backend = new OpenCodeBackend();
  let activity = 0;
  let finish;
  backend.sessions.set('active', { onActivity() { activity += 1; } });
  const stream = (async function* () {
    yield { sessionID: 'active' };
    await new Promise((resolve) => { finish = resolve; });
  })();
  const client = { event: { async subscribe() { return { stream }; } } };

  await backend.ensureSubscribed(client);
  await flush();
  assert.equal(backend.subscribed, true);
  assert.equal(backend.eventStream, stream);
  assert.equal(activity, 1);

  finish();
  await flush();
  assert.equal(backend.subscribed, false);
  assert.equal(backend.eventStream, null);
  assert.equal(backend.subscribePromise, null);
});

test('OpenCode session reports provider and empty responses and aborts once', async () => {
  const provider = await open({ data: { info: { error: { name: 'Unavailable' } } } });
  assert.deepEqual(await provider.session.completion(), {
    ok: false,
    output: null,
    error: 'opencode provider error: Unavailable',
    timedOut: false,
    stalled: false,
    sessionId: 'fake-session'
  });
  await provider.session.interrupt();
  await provider.session.close();
  assert.deepEqual(provider.aborts, [{ path: { id: 'fake-session' } }]);

  const empty = await open({ data: { info: {}, parts: [{ type: 'tool' }] } });
  assert.deepEqual(await empty.session.completion(), {
    ok: false,
    output: null,
    error: 'opencode turn produced no final message',
    timedOut: false,
    stalled: false,
    sessionId: 'fake-session'
  });
  await empty.session.close();
  assert.deepEqual(empty.aborts, [{ path: { id: 'fake-session' } }]);
});
