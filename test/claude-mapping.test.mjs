import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ClaudeBackend, claudeUserQuestions, mapClaudeMessage, mapClaudeResult } from '../src/agent/claude/sdk.ts';

test('Claude message mapping handles stream, assistant, user, and fallback messages', () => {
  assert.deepEqual(mapClaudeMessage({ type: 'stream_event' }), [{ type: 'activity' }]);
  assert.deepEqual(mapClaudeMessage({
    type: 'assistant', message: { content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
      { type: 'image' }
    ] }
  }), [
    { type: 'message', text: 'hello' },
    { type: 'tool-call', tool: 'Bash', input: { command: 'pwd' } }
  ]);
  assert.deepEqual(mapClaudeMessage({ type: 'assistant', message: { content: [] } }), [{ type: 'activity' }]);
  assert.deepEqual(mapClaudeMessage({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: 'ok' },
      { type: 'tool_result', is_error: true, content: { hidden: true } },
      null
    ] }
  }), [
    { type: 'tool-result', tool: 'tool-1', ok: true, summary: 'ok' },
    { type: 'tool-result', tool: 'unknown', ok: false }
  ]);
  assert.deepEqual(mapClaudeMessage({ type: 'user', message: { content: 'plain' } }), [{ type: 'activity' }]);
  assert.deepEqual(mapClaudeMessage({ type: 'unknown' }), [{ type: 'activity' }]);
});

test('Claude result mapping includes structured output, usage, and all failures', () => {
  assert.deepEqual(mapClaudeResult({
    type: 'result', subtype: 'success', is_error: false, structured_output: { ok: true }, session_id: 's1',
    usage: { input_tokens: 2, output_tokens: 3 }
  }), {
    ok: true, output: { ok: true }, timedOut: false, stalled: false, sessionId: 's1',
    usage: { inputTokens: 2, outputTokens: 3 }
  });
  assert.deepEqual(mapClaudeResult({ type: 'result', subtype: 'success', is_error: false }), {
    ok: false, output: null, error: 'claude turn ended without structured output', timedOut: false, stalled: false
  });
  assert.match(mapClaudeResult({ type: 'result', subtype: 'success', is_error: true, result: 'bad' }).error, /error: bad/);
  assert.match(mapClaudeResult({ type: 'result', subtype: 'rate_limit', errors: ['wait', 2] }).error, /rate_limit.*wait; 2/);
  assert.throws(() => mapClaudeResult({ type: 'assistant' }), /expects a result/);
});

test('Claude user questions sanitize options and validate malformed requests', () => {
  assert.deepEqual(claudeUserQuestions({ questions: [{
    header: 'Header', question: 'Pick?', multiSelect: true,
    options: [{ label: 'One', description: 'first' }, { label: 2 }, null]
  }] }), [{
    id: '0', header: 'Header', question: 'Pick?', multiple: true, allowCustom: true,
    options: [{ label: 'One', description: 'first' }]
  }]);
  assert.throws(() => claudeUserQuestions({ questions: [] }), /no questions/);
  assert.throws(() => claudeUserQuestions({ questions: [{}] }), /invalid question/);
});

test('Claude discovery-independent SDK calls close queries and surface outcomes', async () => {
  let closed = 0;
  const modelsBackend = new ClaudeBackend({}, () => ({
    close() { closed += 1; },
    async supportedModels() {
      return [
        { value: 'alias', resolvedModel: 'real', displayName: 'Model' },
        { value: 'same', resolvedModel: 'same', displayName: 'Same' }
      ];
    }
  }));
  assert.deepEqual(await modelsBackend.listModels(), [
    { id: 'alias', displayName: 'Model' }, { id: 'real', displayName: 'Model' }, { id: 'same', displayName: 'Same' }
  ]);
  assert.equal(closed, 1);

  const probeBackend = new ClaudeBackend({}, () => ({
    close() { closed += 1; },
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', subtype: 'failure', is_error: true };
    }
  }));
  const failed = await probeBackend.probe('model');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /probe failed: failure/);

  const emptyBackend = new ClaudeBackend({}, () => ({ close() {}, async *[Symbol.asyncIterator]() {} }));
  assert.match((await emptyBackend.probe()).error, /no result/);
  const thrownBackend = new ClaudeBackend({}, () => { throw new Error('SDK unavailable'); });
  assert.match((await thrownBackend.probe()).error, /SDK unavailable/);
});
