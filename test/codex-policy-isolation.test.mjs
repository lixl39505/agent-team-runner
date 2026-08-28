import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CodexBackend, codexDecision, legacyReviewDecision } from '../src/agent/codex/app-server.ts';

test('Codex maps shared decisions to current and legacy native schemas', () => {
  assert.equal(codexDecision('once'), 'accept');
  assert.equal(codexDecision('session'), 'acceptForSession');
  assert.equal(codexDecision('deny'), 'decline');
  assert.equal(legacyReviewDecision('accept'), 'approved');
  assert.equal(legacyReviewDecision('acceptForSession'), 'approved_for_session');
  assert.deepEqual(legacyReviewDecision('decline'), { denied: { rejection: 'denied by user' } });
});

test('Codex backend routes current command and file requests to their session', async () => {
  const backend = new CodexBackend();
  const calls = [];
  backend.sessions.set('thread', {
    async approveCommand(command, request) { calls.push(['command', command, request]); return 'acceptForSession'; },
    async approveFileChange(itemId, grantRoot, reason) { calls.push(['file', itemId, grantRoot, reason]); return 'accept'; }
  });
  const command = await backend.handleServerRequest('item/commandExecution/requestApproval', {
    threadId: 'thread', turnId: 'turn', itemId: 'command', startedAtMs: 1,
    environmentId: null, command: 'npm test', cwd: '/repo', reason: 'verify'
  });
  const file = await backend.handleServerRequest('item/fileChange/requestApproval', {
    threadId: 'thread', turnId: 'turn', itemId: 'patch', startedAtMs: 1,
    grantRoot: '/outside', reason: 'generated file'
  });
  assert.deepEqual(command, { decision: 'acceptForSession' });
  assert.deepEqual(file, { decision: 'accept' });
  assert.equal(calls[0][1], 'npm test');
  assert.deepEqual(calls[1], ['file', 'patch', '/outside', 'generated file']);
});

test('Codex backend routes generic permission profiles and fails closed for unknown sessions', async () => {
  const backend = new CodexBackend();
  const granted = { permissions: { network: { enabled: true } }, scope: 'session' };
  backend.sessions.set('thread', { async approvePermissions(request) { assert.equal(request.reason, 'download docs'); return granted; } });
  const params = {
    threadId: 'thread', turnId: 'turn', itemId: 'permissions', environmentId: null,
    startedAtMs: 1, cwd: '/repo', reason: 'download docs',
    permissions: { network: { enabled: true }, fileSystem: null }
  };
  assert.deepEqual(await backend.handleServerRequest('item/permissions/requestApproval', params), granted);
  assert.deepEqual(
    await backend.handleServerRequest('item/permissions/requestApproval', { ...params, threadId: 'missing' }),
    { permissions: {}, scope: 'turn' }
  );
});

test('Codex backend routes agent questions to their session', async () => {
  const backend = new CodexBackend();
  backend.sessions.set('thread', {
    async answerUserInput(request) {
      assert.equal(request.questions[0].question, 'Which database?');
      return { answers: { database: { answers: ['SQLite'] } } };
    }
  });
  const params = {
    threadId: 'thread', turnId: 'turn', itemId: 'question', isBlocking: true, autoResolutionMs: null,
    questions: [{
      id: 'database', header: 'Database', question: 'Which database?',
      isOther: true, isSecret: false, options: [{ label: 'SQLite', description: 'Local file' }]
    }]
  };
  assert.deepEqual(await backend.handleServerRequest('item/tool/requestUserInput', params), {
    answers: { database: { answers: ['SQLite'] } }
  });
  assert.deepEqual(await backend.handleServerRequest('item/tool/requestUserInput', { ...params, threadId: 'missing' }), { answers: {} });
});

test('Codex session settles immediately when turn/start fails', async () => {
  const backend = new CodexBackend();
  backend.ensureServer = async () => {};
  backend.connection = {
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'turn/start') throw new Error('model unavailable');
      throw new Error(`unexpected request: ${method}`);
    }
  };
  const session = await backend.openSession({
    role: 'worker',
    cwd: process.cwd(),
    prompt: 'test',
    schema: { type: 'object' },
    access: 'workspace-write',
    timeoutMs: 60_000,
    staleAfterMs: 60_000
  });
  let timer;
  try {
    const outcome = await Promise.race([
      session.completion(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('session did not settle')), 100); })
    ]);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOut, false);
    assert.match(outcome.error, /turn\/start failed: model unavailable/);
  } finally {
    clearTimeout(timer);
    await session.close();
  }
  assert.equal(backend.sessions.size, 0);
});
