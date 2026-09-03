import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, vi } from 'vitest';
import { OpenCodeBackend } from '../src/agent/opencode/sdk.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function spec(overrides = {}) {
  return {
    role: 'worker', cwd: '/workspace', prompt: 'Return JSON', schema: { type: 'object' },
    access: 'workspace-write', timeoutMs: 1_000, staleAfterMs: 1_000, ...overrides
  };
}

async function open(response, overrides = {}) {
  const backend = new OpenCodeBackend();
  const calls = { events: [], approvals: [], aborts: [] };
  const client = {
    session: {
      async create() { return { data: { id: 'session' } }; },
      async prompt() { return response; },
      async abort(request) { calls.aborts.push(request); }
    },
    async postSessionIdPermissionsPermissionId() {}
  };
  backend.ensureClient = async () => client;
  backend.ensureSubscribed = async () => {};
  backend.questionClient = { question: { async reply() {}, async reject() {} } };
  const session = await backend.openSession(spec({
    onEvent: (event) => calls.events.push(event),
    requestApproval: async (request) => {
      calls.approvals.push(request);
      return 'once';
    },
    ...overrides
  }));
  return { backend, calls, session };
}

test('OpenCode closes a newly-created session when its second subscription fails', async () => {
  const backend = new OpenCodeBackend();
  let subscriptions = 0;
  let aborts = 0;
  backend.ensureClient = async () => ({
    session: {
      async create() { return { data: { id: 'session' } }; },
      async prompt() { return { data: { info: { structured: {} } } }; },
      async abort() { aborts += 1; }
    }
  });
  backend.questionClient = { question: {} };
  backend.ensureSubscribed = async () => {
    subscriptions += 1;
    if (subscriptions === 2) throw new Error('stream ended');
  };

  await assert.rejects(backend.openSession(spec()), /stream ended/);
  assert.equal(aborts, 1);
  assert.equal(backend.sessions.size, 0);
});

test('OpenCode rejects unavailable platform and missing session identifiers', async () => {
  const blocked = new OpenCodeBackend({ platform: 'win32' });
  await assert.rejects(blocked.openSession(spec()), /no equivalent native Windows process sandbox/);

  const backend = new OpenCodeBackend();
  backend.ensureClient = async () => ({ session: { async create() { return { data: {} }; } } });
  backend.ensureSubscribed = async () => {};
  await assert.rejects(backend.openSession(spec()), /returned no id/);
});

test('OpenCode normalizes every SSE event shape and releases failed streams', async () => {
  const backend = new OpenCodeBackend();
  const events = [];
  backend.handleEvent = (event) => events.push(event);
  const stream = (async function* () {
    yield { type: 'message.updated', properties: { sessionID: 'envelope' } };
    yield { id: 'permission', sessionID: 'expanded' };
    yield { sessionID: 'activity' };
    yield null;
    yield {};
    throw new Error('stream dropped');
  })();
  backend.eventStream = stream;
  await backend.consumeSubscription({}, stream);

  assert.deepEqual(events, [
    { type: 'message.updated', properties: { sessionID: 'envelope' } },
    { type: 'permission.updated', properties: { id: 'permission', sessionID: 'expanded' } },
    { type: 'message.updated', properties: { sessionID: 'activity' } }
  ]);
  assert.equal(backend.eventStream, null);
  assert.equal(backend.subscribed, false);
});

test('OpenCode handles empty providers, invalid text, activity, and external-directory approval', async () => {
  const models = new OpenCodeBackend();
  models.ensureClient = async () => ({
    config: { async providers() { return { data: { providers: [{ id: 'empty' }, { id: 'ignored', error: 'offline' }] } }; } }
  });
  assert.deepEqual(await models.listModels(), []);

  const value = await open({ data: { info: {}, parts: [{ type: 'text', text: 'not JSON' }] } });
  assert.match((await value.session.completion()).error, /not parseable JSON/);
  value.session.onActivity();
  await value.session.answerPermission('external', { type: 'external_directory', pattern: '/tmp/outside' });
  assert.equal(value.calls.events.at(-1).type, 'permission-check');
  assert.equal(value.calls.approvals[0].kind, 'external-directory');
  assert.match(value.calls.approvals[0].title, /external_directory: \/tmp\/outside/);
  await value.session.answerPermission('tool', { type: 'custom_tool' });
  assert.equal(value.calls.approvals.at(-1).kind, 'tool');
});

test('OpenCode handles omitted data, probe defaults, and rejected stale interactions', async () => {
  const models = new OpenCodeBackend();
  models.ensureClient = async () => ({ config: { async providers() { return {}; } } });
  assert.deepEqual(await models.listModels(), []);

  const probe = new OpenCodeBackend();
  let probeSpec;
  probe.openSession = async (value) => {
    probeSpec = value;
    return { async completion() { return { ok: false }; }, async close() {} };
  };
  const probeResult = await probe.probe();
  assert.equal(probeResult.ok, false);
  assert.equal(probeResult.error, 'probe failed');
  assert.equal(typeof probeResult.latencyMs, 'number');
  assert.equal('model' in probeSpec, false);

  const backend = new OpenCodeBackend();
  backend.ensureClient = async () => ({ async postSessionIdPermissionsPermissionId() { throw new Error('gone'); } });
  backend.questionClient = { question: { async reject() { throw new Error('gone'); } } };
  backend.handleEvent({ type: 'permission.updated' });
  backend.handleEvent({ type: 'permission.updated', properties: { id: 'permission', sessionID: 'missing' } });
  backend.handleEvent({ type: 'question.asked', properties: { id: 'question' } });
  await flush();
});

test('OpenCode captures model routing and string transport failures', async () => {
  const backend = new OpenCodeBackend();
  let prompt;
  const client = {
    session: {
      async create() { return { data: { id: 'model-session' } }; },
      async prompt(request) { prompt = request; throw 'transport string'; },
      async abort() {}
    }
  };
  backend.ensureClient = async () => client;
  backend.ensureSubscribed = async () => {};
  backend.questionClient = { question: {} };
  const session = await backend.openSession(spec({ model: 'provider/model' }));
  assert.equal((await session.completion()).error, 'transport string');
  assert.deepEqual(prompt.body.model, { providerID: 'provider', modelID: 'model' });

  const plain = await open({ data: { info: {} } }, { model: 'plain-model' });
  assert.match((await plain.session.completion()).error, /no final message/);

  const missing = await open({});
  assert.match((await missing.session.completion()).error, /no final message/);

  const missingInfo = await open({ data: {} });
  assert.match((await missingInfo.session.completion()).error, /no final message/);
  // 无 pattern 的 edit 无法证明在工作区内：转交审批通道而不是自动放行。
  await missingInfo.session.answerPermission('edit', { type: 'edit' });
  assert.equal(missingInfo.calls.approvals.length, 1);
  assert.equal(missingInfo.calls.approvals[0].kind, 'file-change');

  const nullData = await open({ data: null });
  assert.match((await nullData.session.completion()).error, /no final message/);
  const nullInfo = await open({ data: { info: null } });
  assert.match((await nullInfo.session.completion()).error, /no final message/);
  const parsed = await open({ data: { parts: [{ type: 'text', text: '{}' }] } });
  assert.deepEqual((await parsed.session.completion()).output, {});
});

test('OpenCode cleanup tolerates destroyed stdio and failed process-tree termination', () => {
  const backend = new OpenCodeBackend();
  const originalKill = process.kill;
  process.kill = () => { throw new Error('gone'); };
  backend.serverChild = {
    pid: 123,
    stdout: { destroy() { throw new Error('closed'); } },
    stderr: { destroy() { throw new Error('closed'); } }
  };
  try {
    assert.doesNotThrow(() => backend.killServer());
  } finally {
    process.kill = originalKill;
  }
});

test('OpenCode tolerates blank discovery output and absent optional cleanup handles', async () => {
  const listeners = new Map();
  const child = {
    on(event, listener) { listeners.set(event, listener); },
    kill() {}
  };
  const backend = new OpenCodeBackend({ spawn() { return child; } });
  const discovery = backend.discover();
  listeners.get('close')(0);
  assert.deepEqual(await discovery, { backend: 'opencode', installed: true, version: undefined });

  backend.eventStream = {};
  backend.dispose();
  assert.equal(backend.eventStream, null);
});

test('OpenCode covers successful probes and default server launch cleanup', async (t) => {
  const probe = new OpenCodeBackend();
  probe.openSession = async () => ({ async completion() { return { ok: true }; }, async close() {} });
  assert.equal((await probe.probe()).ok, true);

  class Stream extends EventEmitter {
    setEncoding() {}
    destroy() {}
  }
  const child = new EventEmitter();
  child.stdout = new Stream();
  child.stderr = new Stream();
  const backend = new OpenCodeBackend({ spawn() { return child; } });
  const launched = backend.launchServer();
  child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4567\n');
  await launched;
  const replacement = {};
  backend.serverChild = replacement;
  child.emit('exit', 0);
  assert.equal(backend.serverChild, replacement);

  vi.useFakeTimers();
  backend.serverChild = { stdout: { destroy() {} }, stderr: { destroy() {} } };
  backend.killServer();
  vi.advanceTimersByTime(3_000);

  const originalKill = process.kill;
  let kills = 0;
  process.kill = () => {
    kills += 1;
    if (kills > 1) throw new Error('already exited');
  };
  try {
    backend.serverChild = { pid: 123, stdout: { destroy() {} }, stderr: { destroy() {} } };
    backend.killServer();
    vi.advanceTimersByTime(3_000);
  } finally {
    process.kill = originalKill;
  }

  let subscriptions = 0;
  backend.serverChild = {};
  backend.subscribed = true;
  backend.scheduleResubscribe({ event: { async subscribe() { subscriptions += 1; return { stream: {} }; } } });
  vi.advanceTimersByTime(100);
  vi.useRealTimers();
  assert.equal(subscriptions, 0);
});

test('OpenCode resubscription retries a dropped stream while work remains', async () => {
  const backend = new OpenCodeBackend();
  backend.serverChild = {};
  backend.sessions.set('active', { async interrupt() {} });
  let attempts = 0;
  const client = { event: { async subscribe() { attempts += 1; throw new Error('unavailable'); } } };
  backend.scheduleResubscribe(client);
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(attempts, 1);
  assert.notEqual(backend.reconnectTimer, null);
  backend.dispose();
  await flush();
});

test('OpenCode shares an in-flight subscription', async () => {
  const backend = new OpenCodeBackend();
  backend.subscribePromise = Promise.resolve();
  await backend.ensureSubscribed({});
});

test('OpenCode creates and reuses its client promise', async () => {
  const backend = new OpenCodeBackend();
  const client = {};
  let launches = 0;
  backend.launchServer = async () => {
    launches += 1;
    return client;
  };
  assert.equal(await backend.ensureClient(), client);
  assert.equal(await backend.ensureClient(), client);
  assert.equal(launches, 1);
});

test('OpenCode covers event dispatch and subscription cleanup races', async () => {
  const backend = new OpenCodeBackend();
  const permissions = [];
  backend.sessions.set('session', {
    async answerPermission(id, request) { permissions.push({ id, request }); },
    async answerQuestion() {}
  });
  backend.handleEvent({ type: 'permission.updated', properties: { id: 'without-pattern', sessionID: 'session' } });
  backend.handleEvent({ type: 'permission.updated', properties: { id: 'with-pattern', sessionID: 'session', pattern: '/tmp' } });
  backend.handleEvent({ type: 'question.asked', properties: { id: 'unknown-question' } });
  backend.sessions.set('no-questions', { async answerPermission() {}, async answerQuestion() {} });
  backend.handleEvent({ type: 'question.asked', properties: { id: 'missing-questions', sessionID: 'no-questions' } });
  backend.handleEvent({ type: 'question.asked', properties: { sessionID: 'no-questions' } });
  await flush();
  assert.deepEqual(permissions, [
    { id: 'without-pattern', request: { type: '' } },
    { id: 'with-pattern', request: { type: '', pattern: '/tmp' } }
  ]);

  const stream = { return() { return Promise.reject(new Error('stream already closed')); } };
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  const launched = new OpenCodeBackend({ spawn() { return child; } });
  const startup = launched.launchServer();
  child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4569\n');
  await startup;
  launched.eventStream = stream;
  child.emit('exit', 0);
  await flush();
  assert.equal(launched.eventStream, null);

  const race = new OpenCodeBackend();
  const rejected = Promise.reject(new Error('dropped'));
  rejected.catch(() => {});
  race.startSubscription = () => rejected;
  const pending = race.ensureSubscribed({});
  race.subscribePromise = Promise.resolve();
  await assert.rejects(pending, /dropped/);

  const reconnect = new OpenCodeBackend();
  reconnect.serverChild = {};
  reconnect.sessions.set('active', {});
  reconnect.scheduleResubscribe({});
  reconnect.serverChild = null;
  await new Promise((resolve) => setTimeout(resolve, 110));
});

test('OpenCode includes usage with a parsed text result', async () => {
  const result = await open({
    data: { info: { tokens: { input: 3, output: 5 } }, parts: [{ type: 'text', text: '{}' }] }
  });
  assert.deepEqual((await result.session.completion()).usage, { inputTokens: 3, outputTokens: 5 });
});

test('OpenCode launches a non-detached Windows server and releases its reconnect timer on exit', async () => {
  class Stream extends EventEmitter {
    setEncoding() {}
    destroy() {}
  }
  const child = new EventEmitter();
  child.stdout = new Stream();
  child.stderr = new Stream();
  let options;
  const backend = new OpenCodeBackend({
    platform: 'win32',
    spawn(command, args, value) {
      options = value;
      return child;
    }
  });
  const launch = backend.launchServer();
  child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4568\n');
  await launch;
  backend.reconnectTimer = setTimeout(() => {}, 10_000);
  child.emit('exit', 0);
  assert.equal(options.detached, false);
  assert.equal(backend.reconnectTimer, null);
});
