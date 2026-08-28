import { test } from 'vitest';
import assert from 'node:assert/strict';
import { OpenCodeBackend } from '../src/agent/opencode/sdk.ts';

function sessionSpec(overrides = {}) {
  return {
    role: 'worker', cwd: '/workspace', prompt: 'Return JSON', schema: { type: 'object' },
    access: 'workspace-write', timeoutMs: 1_000, staleAfterMs: 1_000,
    ...overrides
  };
}

async function open(response, overrides = {}) {
  const backend = new OpenCodeBackend();
  const calls = { permissions: [], replies: [], rejects: [], events: [] };
  const client = {
    session: {
      async create() { return { data: { id: 'session-1' } }; },
      async prompt() { return response instanceof Error ? Promise.reject(response) : response; },
      async abort() {},
    },
    async postSessionIdPermissionsPermissionId(request) { calls.permissions.push(request); }
  };
  backend.ensureClient = async () => client;
  backend.ensureSubscribed = async () => {};
  backend.questionClient = {
    question: {
      async reply(request) { calls.replies.push(request); },
      async reject(request) { calls.rejects.push(request); }
    }
  };
  const session = await backend.openSession(sessionSpec({ onEvent: (event) => calls.events.push(event), ...overrides }));
  return { backend, calls, client, session };
}

test('OpenCode session maps structured, text, empty, provider, and transport results', async () => {
  const structured = await open({ data: { info: { structured: { status: 'completed' }, tokens: { input: 2, output: 3 } } } });
  assert.deepEqual(await structured.session.completion(), {
    ok: true, output: { status: 'completed' }, timedOut: false, stalled: false, sessionId: 'session-1',
    usage: { inputTokens: 2, outputTokens: 3 }
  });

  const text = await open({ data: { info: {}, parts: [{ type: 'text', text: 'ignore' }, { type: 'text', text: '```json\n{"ok":true}\n```' }] } });
  assert.deepEqual((await text.session.completion()).output, { ok: true });

  const empty = await open({ data: { info: {}, parts: [] } });
  assert.match((await empty.session.completion()).error, /no final message/);

  const provider = await open({ data: { info: { error: { name: 'Unauthorized', data: { message: 'bad token' } } } } });
  assert.match((await provider.session.completion()).error, /provider error: bad token/);

  const transport = await open(new Error('network down'));
  assert.match((await transport.session.completion()).error, /network down/);
});

test('OpenCode permissions enforce role policy and map approvals', async () => {
  const readOnly = await open({ data: { info: { structured: {} } } }, { access: 'read-only' });
  await readOnly.session.answerPermission('p1', { type: 'bash', pattern: 'rm -rf /' });
  assert.deepEqual(readOnly.calls.permissions, [{ path: { id: 'session-1', permissionID: 'p1' }, body: { response: 'reject' } }]);
  assert.deepEqual(readOnly.calls.events.at(-1), { type: 'permission-check', tool: 'bash', input: { pattern: 'rm -rf /' }, allowed: false, reason: 'read-only role' });

  const approved = await open({ data: { info: { structured: {} } } }, { requestApproval: async () => 'session' });
  await approved.session.answerPermission('p2', { type: 'webfetch', pattern: ['https://example.test'] });
  assert.deepEqual(approved.calls.permissions, [{ path: { id: 'session-1', permissionID: 'p2' }, body: { response: 'always' } }]);
  assert.equal(approved.calls.events.at(-1).allowed, true);

  const edit = await open({ data: { info: { structured: {} } } });
  await edit.session.answerPermission('p3', { type: 'edit' });
  assert.equal(edit.calls.permissions[0].body.response, 'once');
});

test('OpenCode questions reject without a handler and reply with normalized answers', async () => {
  const rejected = await open({ data: { info: { structured: {} } } });
  await rejected.session.answerQuestion('q1', [{ header: 'Header', question: 'Question?', options: [{ label: 'One' }], multiple: false, custom: true }]);
  assert.deepEqual(rejected.calls.rejects, [{ requestID: 'q1', directory: '/workspace' }]);

  const answered = await open({ data: { info: { structured: {} } } }, { requestUserInput: async (request) => {
    assert.equal(request.questions[0].allowCustom, true);
    return { '0': ['One'] };
  } });
  await answered.session.answerQuestion('q2', [{ question: 'Pick', options: [{ label: 'One' }] }]);
  assert.deepEqual(answered.calls.replies, [{ requestID: 'q2', directory: '/workspace', answers: [['One']] }]);
  assert.equal(answered.calls.events.at(-1).type, 'activity');
});
