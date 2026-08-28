import { test } from 'vitest';
import assert from 'node:assert/strict';
import { OpenCodeBackend } from '../src/agent/opencode/sdk.ts';

function spec() {
  return {
    role: 'worker',
    cwd: process.cwd(),
    prompt: 'test',
    schema: { type: 'object' },
    access: 'workspace-write',
    timeoutMs: 1_000,
    staleAfterMs: 1_000
  };
}

test('OpenCode backend routes question events to their session', async () => {
  const backend = new OpenCodeBackend();
  let routed;
  backend.sessions.set('session', {
    async answerQuestion(id, questions) { routed = { id, questions }; }
  });
  backend.handleEvent({
    type: 'question.asked',
    properties: {
      id: 'request', sessionID: 'session',
      questions: [{ header: 'Database', question: 'Which database?', options: [], custom: true }]
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(routed.id, 'request');
  assert.equal(routed.questions[0].question, 'Which database?');
});

test('OpenCode backend rejects questions for unknown sessions', async () => {
  const backend = new OpenCodeBackend();
  const rejected = [];
  backend.questionClient = { question: { async reject(request) { rejected.push(request); } } };
  backend.handleEvent({
    type: 'question.asked',
    properties: { id: 'request', sessionID: 'missing', questions: [] }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(rejected, [{ requestID: 'request' }]);
});

test('OpenCode session close aborts the remote prompt exactly once', async () => {
  const backend = new OpenCodeBackend();
  const aborts = [];
  let rejectPrompt;
  const client = {
    session: {
      async create() { return { data: { id: 'session' } }; },
      prompt() { return new Promise((resolve, reject) => { rejectPrompt = reject; }); },
      async abort(request) {
        aborts.push(request);
        rejectPrompt(new Error('aborted'));
      }
    }
  };
  backend.ensureClient = async () => client;
  backend.ensureSubscribed = async () => {};
  backend.questionClient = {};

  const session = await backend.openSession(spec());
  await session.close();
  await session.close();

  assert.deepEqual(aborts, [{ path: { id: 'session' } }]);
  assert.equal((await session.completion()).ok, false);
  assert.equal(backend.sessions.size, 0);
});

test('OpenCode reconnects an ended SSE stream while sessions are active', async () => {
  const backend = new OpenCodeBackend();
  let subscriptions = 0;
  async function* endedStream() {}
  async function* pendingStream() { await new Promise(() => {}); }
  const client = {
    event: {
      async subscribe() {
        subscriptions += 1;
        return { stream: subscriptions === 1 ? endedStream() : pendingStream() };
      }
    }
  };
  backend.serverChild = {};
  backend.sessions.set('active', {});

  await backend.ensureSubscribed(client);
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(subscriptions, 2);
  backend.serverChild = null;
  backend.sessions.clear();
  backend.eventStream = null;
});
