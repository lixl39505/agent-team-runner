import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { ClaudeBackend } from '../src/agent/claude/sdk.ts';
import { CodexBackend } from '../src/agent/codex/app-server.ts';
import { JsonRpcConnection } from '../src/agent/codex/jsonrpc.ts';
import { FakeBackend } from '../src/agent/fake.ts';
import { OpenCodeBackend } from '../src/agent/opencode/sdk.ts';
import { disposeBackends } from '../src/agent/registry.ts';
import { runAgent } from '../src/agent/supervise.ts';

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

function query({ models = [], close = () => {} } = {}) {
  return {
    async supportedModels() { return models; },
    close,
    async *[Symbol.asyncIterator]() {}
  };
}

test('Claude SDK closes model queries and all tracked fake sessions during disposal', async () => {
  let modelQueryCloses = 0;
  const modelQuery = query({
    models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet', displayName: 'Sonnet' }],
    close() {
      modelQueryCloses += 1;
      throw new Error('already closed');
    }
  });
  const sessionCloses = [];
  const backend = new ClaudeBackend({ platform: 'linux' }, (request) => {
    if (request.prompt === '') return modelQuery;
    return query({ close: () => sessionCloses.push(request.prompt) });
  });

  assert.deepEqual(await backend.listModels(), [
    { id: 'sonnet', displayName: 'Sonnet' },
    { id: 'claude-sonnet', displayName: 'Sonnet' }
  ]);
  assert.equal(modelQueryCloses, 1);

  await backend.openSession(spec({ prompt: 'one' }));
  await backend.openSession(spec({ prompt: 'two' }));
  backend.dispose();

  assert.deepEqual(sessionCloses, ['one', 'two']);
  assert.equal(backend.sessions.size, 0);
});

test('Codex JSON-RPC close rejects fake pending work without scheduling a real kill timer', async () => {
  const connection = Object.create(JsonRpcConnection.prototype);
  let rejectPending;
  const pending = new Promise((_resolve, reject) => { rejectPending = reject; });
  const rejected = assert.rejects(pending, /connection closed/);
  let killEscalation;
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay) => {
    assert.equal(delay, 3_000);
    killEscalation = callback;
    return {};
  };
  connection.closed = false;
  connection.pending = new Map([[1, { reject: rejectPending, timer: {} }]]);
  connection.child = { pid: undefined };

  try {
    connection.close();
    await rejected;
    assert.equal(connection.pending.size, 0);
    assert.equal(connection.exited, true);
    assert.equal(typeof killEscalation, 'function');
    killEscalation();
    connection.close();
    await assert.rejects(connection.request('after-close', null), /connection is closed/);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('Codex disposal closes fake sessions and resets a reusable app-server state', () => {
  const backend = new CodexBackend();
  const closedSessions = [];
  let closedConnection = 0;
  backend.sessions.set('one', { async close() { closedSessions.push('one'); } });
  backend.sessions.set('two', { async close() { closedSessions.push('two'); } });
  backend.connection = { close() { closedConnection += 1; } };
  backend.initialized = true;
  backend.initPromise = Promise.resolve();
  backend.platformCheckPromise = Promise.resolve({ ok: true, degraded: false, detail: 'ready' });

  backend.dispose();

  assert.deepEqual(closedSessions, ['one', 'two']);
  assert.equal(closedConnection, 1);
  assert.equal(backend.sessions.size, 0);
  assert.equal(backend.connection, null);
  assert.equal(backend.initialized, false);
  assert.equal(backend.initPromise, null);
  assert.equal(backend.platformCheckPromise, null);
});

test('OpenCode server exit releases fake sessions and an optional event stream', async () => {
  class FakeStream extends EventEmitter {
    setEncoding() {}
  }
  const child = new EventEmitter();
  child.stdout = new FakeStream();
  child.stderr = new FakeStream();
  const backend = new OpenCodeBackend({ command: 'fake-opencode', spawn: () => child });
  const launched = backend.launchServer();
  child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4567\n');
  await launched;

  let interrupted = 0;
  let returned = 0;
  backend.sessions.set('active', { async interrupt() { interrupted += 1; } });
  backend.eventStream = { async return() { returned += 1; return { done: true }; } };
  child.emit('exit', 0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(interrupted, 1);
  assert.equal(returned, 1);
  assert.equal(backend.sessions.size, 0);
  assert.equal(backend.serverChild, null);
  assert.equal(backend.clientPromise, null);
  assert.equal(backend.questionClient, null);
  assert.equal(backend.eventStream, null);
  assert.equal(backend.subscribePromise, null);
  assert.equal(backend.subscribed, false);
});

test('registry optional disposal and FakeBackend default completion remain local', async () => {
  const disposed = [];
  disposeBackends({
    claude: { dispose: () => disposed.push('claude') },
    codex: { dispose: undefined },
    opencode: {}
  });
  assert.deepEqual(disposed, ['claude']);

  const backend = new FakeBackend({}, [{ id: 'fake-model' }], 'codex');
  assert.deepEqual(await backend.discover(), { backend: 'codex', installed: true, version: 'fake-1.0', authed: true });
  assert.deepEqual(await backend.listModels(), [{ id: 'fake-model' }]);
  assert.deepEqual(await backend.probe(), { ok: true, latencyMs: 1 });
  const session = await backend.openSession(spec({ access: 'read-only' }));
  session.sessionId = 'fake-session';
  assert.deepEqual(await session.completion(), {
    ok: true, output: null, timedOut: false, stalled: false, sessionId: 'fake-session'
  });
  await session.close();
  assert.equal(session.closeCount, 1);
});

test('supervisor records a non-Error transport failure and absorbs close failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-cleanup-final-'));
  const logPath = join(directory, 'agent.log');
  const outputPath = join(directory, 'result.json');
  let closes = 0;
  const outcome = await runAgent({
    backend: {
      id: 'claude',
      capabilities: { maxTurns: false, resumeSession: false },
      async openSession() {
        return {
          async interrupt() {},
          async close() { closes += 1; throw new Error('transport is already gone'); },
          async completion() { throw 'socket reset'; }
        };
      }
    },
    spec: spec(),
    logPath,
    outputPath
  });

  assert.deepEqual(outcome, {
    ok: false, output: null, error: 'session failed: socket reset', timedOut: false, stalled: false
  });
  assert.equal(closes, 1);
  assert.equal(existsSync(outputPath), false);
  assert.match(readFileSync(logPath, 'utf8'), /transport failure: socket reset/);
  assert.match(readFileSync(logPath, 'utf8'), /closed \(settled=true\)/);
});
