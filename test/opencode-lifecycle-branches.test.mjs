import { test } from 'vitest';
import { denialGuidance } from '../src/core/approval-collector.ts';
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

async function open(response, overrides = {}, hooks = {}) {
  const backend = new OpenCodeBackend();
  const calls = { permissions: [], replies: [], rejects: [], aborts: [], events: [] };
  const client = {
    session: {
      async create() { return { data: { id: 'session-1' } }; },
      async prompt() {
        if (response instanceof Error) throw response;
        return response;
      },
      async abort(request) {
        calls.aborts.push(request);
        return await hooks.abort?.(request);
      }
    },
    async postSessionIdPermissionsPermissionId(request) {
      calls.permissions.push(request);
      return await hooks.permission?.(request);
    }
  };
  backend.ensureClient = async () => client;
  backend.ensureSubscribed = async () => {};
  backend.questionClient = {
    question: {
      async reply(request) {
        calls.replies.push(request);
        return await hooks.reply?.(request);
      },
      async reject(request) {
        calls.rejects.push(request);
        return await hooks.reject?.(request);
      }
    }
  };
  const session = await backend.openSession(spec({ onEvent: (event) => calls.events.push(event), ...overrides }));
  return { backend, calls, session };
}

test('OpenCode session reports provider fallback and no-text outcomes', async () => {
  const provider = await open({ data: { info: { error: { name: 'Unavailable' } } } });
  assert.deepEqual(await provider.session.completion(), {
    ok: false,
    output: null,
    error: 'opencode provider error: Unavailable',
    timedOut: false,
    stalled: false,
    sessionId: 'session-1'
  });

  const noText = await open({
    data: {
      info: { structured: null, tokens: { input: 5, output: 0 } },
      parts: [{ type: 'tool' }, { type: 'text', text: ' \n ' }]
    }
  });
  assert.deepEqual(await noText.session.completion(), {
    ok: false,
    output: null,
    error: 'opencode turn produced no final message',
    timedOut: false,
    stalled: false,
    sessionId: 'session-1',
    usage: { inputTokens: 5, outputTokens: 0 }
  });
});

test('OpenCode session contains permission and question failures', async () => {
  const denied = await open({ data: { info: { structured: {} } } });
  await denied.session.answerPermission('permission-denied', { type: 'bash' });
  assert.deepEqual(denied.calls.permissions, [{
    path: { id: 'session-1', permissionID: 'permission-denied' }, body: { response: 'reject' }
  }]);
  assert.deepEqual(denied.calls.events.at(-1), {
    type: 'permission-check', tool: 'bash', input: {}, allowed: false, reason: denialGuidance
  });

  let approval;
  const approved = await open({ data: { info: { structured: {} } } }, {
    requestApproval: async (request) => {
      approval = request;
      return 'once';
    }
  });
  await approved.session.answerPermission('permission-approved', { type: 'websearch' });
  assert.equal(approved.calls.permissions[0].body.response, 'once');
  assert.equal(approval.kind, 'network');
  assert.equal(approval.title, 'OpenCode requests websearch permission');

  const postFailure = await open(
    { data: { info: { structured: {} } } },
    {},
    { permission: async () => { throw new Error('session gone'); } }
  );
  await postFailure.session.answerPermission('permission-edit', { type: 'edit' });
  assert.equal(postFailure.calls.permissions[0].body.response, 'once');

  const missingHandler = await open(
    { data: { info: { structured: {} } } },
    {},
    { reject: async () => { throw new Error('request gone'); } }
  );
  await missingHandler.session.answerQuestion('question-rejected', [{ question: 'Continue?' }]);
  assert.deepEqual(missingHandler.calls.rejects, [{ requestID: 'question-rejected', directory: '/workspace' }]);

  const capturedQuestion = { taskId: undefined };
  const replyFailure = await open(
    { data: { info: { structured: {} } } },
    { taskId: 'T9', requestUserInput: async (request) => { capturedQuestion.taskId = request.taskId; return {}; } },
    { reply: async () => { throw new Error('request gone'); } }
  );
  await replyFailure.session.answerQuestion('question-reply-failed', [{ question: 'Continue?', custom: false }]);
  assert.deepEqual(replyFailure.calls.replies[0].answers, [[]]);
  assert.equal(capturedQuestion.taskId, 'T9');
  assert.deepEqual(replyFailure.calls.rejects, [{ requestID: 'question-reply-failed', directory: '/workspace' }]);
});

test('OpenCode session close absorbs abort failures and remains idempotent', async () => {
  const value = await open(
    { data: { info: { structured: { done: true } } } },
    {},
    { abort: async () => { throw new Error('server already stopped'); } }
  );

  await value.session.close();
  await value.session.close();

  assert.deepEqual(value.calls.aborts, [{ path: { id: 'session-1' } }]);
  assert.equal(value.backend.sessions.size, 0);
  assert.equal((await value.session.completion()).ok, true);
});

test('OpenCode subscription failure, sharing, and dispose are controllable', async () => {
  const backend = new OpenCodeBackend();
  let subscriptions = 0;
  let resolveNext;
  let returned = 0;
  let interrupted = 0;
  let timerRan = false;
  const stream = {
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise((resolve) => { resolveNext = resolve; }); },
    async return() {
      returned += 1;
      resolveNext?.({ done: true });
      return { done: true };
    }
  };
  const client = {
    event: {
      async subscribe() {
        subscriptions += 1;
        if (subscriptions === 1) throw new Error('stream unavailable');
        return { stream };
      }
    }
  };

  await assert.rejects(backend.ensureSubscribed(client), /stream unavailable/);
  assert.equal(backend.subscribePromise, null);

  await Promise.all([backend.ensureSubscribed(client), backend.ensureSubscribed(client)]);
  await flush();
  assert.equal(subscriptions, 2);
  assert.equal(backend.subscribed, true);

  backend.clientPromise = Promise.resolve(client);
  backend.questionClient = { question: {} };
  backend.reconnectTimer = setTimeout(() => { timerRan = true; }, 20);
  backend.sessions.set('active', { async interrupt() { interrupted += 1; } });
  backend.dispose();
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(returned, 1);
  assert.equal(interrupted, 1);
  assert.equal(timerRan, false);
  assert.equal(backend.eventStream, null);
  assert.equal(backend.subscribePromise, null);
  assert.equal(backend.clientPromise, null);
  assert.equal(backend.questionClient, null);
  assert.equal(backend.subscribed, false);
  assert.equal(backend.sessions.size, 0);
});
