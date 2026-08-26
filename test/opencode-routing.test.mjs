import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeBackend } from '../dist/agent/opencode/sdk.js';

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
