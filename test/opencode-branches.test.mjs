import { test } from 'vitest';
import assert from 'node:assert/strict';
import { OpenCodeBackend } from '../src/agent/opencode/sdk.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));

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

async function open(overrides = {}) {
  const backend = new OpenCodeBackend();
  const calls = { permissions: [], aborts: [], events: [] };
  const client = {
    session: {
      async create() { return { data: { id: 'known-session' } }; },
      async prompt() { return { data: { info: { structured: {} } } }; },
      async abort(request) { calls.aborts.push(request); }
    },
    async postSessionIdPermissionsPermissionId(request) { calls.permissions.push(request); }
  };
  backend.ensureClient = async () => client;
  backend.ensureSubscribed = async () => {};
  backend.questionClient = { question: {} };
  const session = await backend.openSession(spec({ onEvent: (event) => calls.events.push(event), ...overrides }));
  return { backend, calls, session };
}

test('OpenCode routes known, unknown, and incomplete permission events fail-closed', async () => {
  const backend = new OpenCodeBackend();
  const known = [];
  const rejected = [];
  backend.sessions.set('known', {
    async answerPermission(id, request) { known.push({ id, request }); }
  });
  backend.ensureClient = async () => ({
    async postSessionIdPermissionsPermissionId(request) { rejected.push(request); }
  });

  backend.handleEvent({
    type: 'permission.updated',
    properties: { id: 'permission-1', sessionID: 'known', type: 'bash', pattern: ['npm test'] }
  });
  backend.handleEvent({
    type: 'permission.updated',
    properties: { id: 'permission-2', sessionID: 'missing', type: 'edit' }
  });
  backend.handleEvent({
    type: 'permission.updated',
    properties: { sessionID: 'known', type: 'bash' }
  });
  backend.handleEvent({
    type: 'permission.updated',
    properties: { id: 'permission-3', type: 'bash' }
  });
  await flush();

  assert.deepEqual(known, [{ id: 'permission-1', request: { type: 'bash', pattern: ['npm test'] } }]);
  assert.deepEqual(rejected, [{
    path: { id: 'missing', permissionID: 'permission-2' },
    body: { response: 'reject' }
  }]);
});

test('OpenCode emits activity only for active session updates', () => {
  const backend = new OpenCodeBackend();
  let activities = 0;
  backend.sessions.set('active', { onActivity() { activities += 1; } });

  backend.handleEvent({ type: 'message.updated', properties: { sessionID: 'active' } });
  backend.handleEvent({ type: 'message.part.updated', properties: { sessionID: 'active' } });
  backend.handleEvent({ type: 'session.diff', properties: { sessionID: 'active' } });
  backend.handleEvent({ type: 'message.updated', properties: { sessionID: 'missing' } });
  backend.handleEvent({ type: 'unrelated', properties: { sessionID: 'active' } });
  backend.handleEvent({ type: 'message.updated', properties: {} });

  assert.equal(activities, 3);
});

test('OpenCode permission interactions reject denied, failed, and interrupted approvals', async () => {
  const denied = await open({ requestApproval: async () => 'reject' });
  await denied.session.answerPermission('denied', { type: 'bash' });

  const failed = await open({ requestApproval: async () => { throw new Error('dialog failed'); } });
  await failed.session.answerPermission('failed', { type: 'webfetch' });

  let approvalStarted;
  const started = new Promise((resolve) => { approvalStarted = resolve; });
  const interrupted = await open({ requestApproval: async (_request, signal) => {
    approvalStarted();
    return await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } });
  const answer = interrupted.session.answerPermission('interrupted', { type: 'bash' });
  await started;
  await interrupted.session.interrupt();
  await answer;

  for (const result of [denied, failed, interrupted]) {
    assert.equal(result.calls.permissions[0].body.response, 'reject');
    assert.equal(result.calls.events.at(-1).allowed, false);
    assert.equal(result.calls.events.at(-1).reason, 'denied by user');
  }
  assert.deepEqual(interrupted.calls.aborts, [{ path: { id: 'known-session' } }]);
});

test('OpenCode subscription and dispose safely release failed and active streams', async () => {
  const backend = new OpenCodeBackend();
  let subscriptions = 0;
  let nextResolve;
  let returns = 0;
  let interrupts = 0;
  const stream = {
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise((resolve) => { nextResolve = resolve; }); },
    return() {
      returns += 1;
      nextResolve?.({ done: true });
      return Promise.reject(new Error('already closed'));
    }
  };
  const client = {
    event: {
      async subscribe() {
        subscriptions += 1;
        if (subscriptions === 1) throw new Error('subscription unavailable');
        return { stream };
      }
    }
  };

  await assert.rejects(backend.ensureSubscribed(client), /subscription unavailable/);
  assert.equal(backend.subscribePromise, null);
  await Promise.all([backend.ensureSubscribed(client), backend.ensureSubscribed(client)]);
  assert.equal(subscriptions, 2);
  await flush();

  backend.sessions.set('active', { async interrupt() { interrupts += 1; } });
  backend.dispose();
  await flush();

  assert.equal(returns, 1);
  assert.equal(interrupts, 1);
  assert.equal(backend.eventStream, null);
  assert.equal(backend.subscribePromise, null);
  assert.equal(backend.subscribed, false);
  assert.equal(backend.sessions.size, 0);
});
