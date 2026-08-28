import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeBackend, claudeUserQuestions, mapClaudeMessage, mapClaudeResult } from '../src/agent/claude/sdk.ts';

function query(messages = [], options = {}) {
  return {
    close: options.close ?? (() => {}),
    interrupt: options.interrupt ?? (async () => {}),
    async *[Symbol.asyncIterator]() {
      if (options.error !== undefined) throw options.error;
      yield* messages;
    }
  };
}

async function open(messages, overrides = {}, backendOptions = {}) {
  let request;
  const backend = new ClaudeBackend({ platform: 'linux', ...backendOptions }, (value) => {
    request = value;
    return query(messages);
  });
  const session = await backend.openSession({
    role: 'worker',
    cwd: mkdtempSync(join(tmpdir(), 'agent-team-claude-sdk-coverage-')),
    prompt: 'test',
    schema: { type: 'object' },
    access: 'workspace-write',
    timeoutMs: 1_000,
    staleAfterMs: 1_000,
    ...overrides
  });
  return { backend, options: request.options, session };
}

function context(overrides = {}) {
  return { signal: new AbortController().signal, toolUseID: 'tool', requestId: 'request', ...overrides };
}

test('Claude discovery uses its default command', async () => {
  const child = {
    stdout: { on() {} },
    on(event, listener) {
      if (event === 'close') queueMicrotask(() => listener(0));
    },
    kill() {}
  };
  const calls = [];
  const backend = new ClaudeBackend({ spawn: (...args) => { calls.push(args); return child; } });
  assert.deepEqual(await backend.discover(), { backend: 'claude', installed: true, version: undefined });
  assert.equal(calls[0][0], 'claude');
});

test('Claude probe handles successful, non-result, and non-Error failures', async () => {
  const successful = new ClaudeBackend({}, () => query([
    { type: 'stream_event' },
    { type: 'result', subtype: 'success', is_error: false }
  ]));
  assert.equal((await successful.probe()).ok, true);

  const failedResult = new ClaudeBackend({}, () => query([
    { type: 'result', subtype: 'success', is_error: true }
  ]));
  assert.match((await failedResult.probe()).error, /probe failed: success/);

  const thrown = new ClaudeBackend({}, () => { throw 'unavailable'; });
  assert.equal((await thrown.probe()).error, 'unavailable');
});

test('Claude Windows sessions omit sandbox and retain supported optional settings', async () => {
  let captured;
  const backend = new ClaudeBackend({ platform: 'win32', nativeWindowsSandbox: 'allow-degraded', command: 'custom-claude' }, (value) => {
    captured = value;
    return query([{ type: 'result', subtype: 'success', is_error: false, structured_output: {} }]);
  });
  const session = await backend.openSession({
    role: 'worker',
    cwd: mkdtempSync(join(tmpdir(), 'agent-team-claude-windows-')),
    prompt: 'test',
    schema: { type: 'object' },
    model: 'model',
    access: 'read-only',
    maxTurns: 2,
    resumeSessionId: 'resume',
    timeoutMs: 1_000,
    staleAfterMs: 1_000
  });
  assert.equal(captured.options.sandbox, undefined);
  assert.equal(captured.options.pathToClaudeCodeExecutable, 'custom-claude');
  assert.equal(captured.options.model, 'model');
  assert.equal(captured.options.maxTurns, 2);
  assert.equal(captured.options.resume, 'resume');
  assert.ok(captured.options.disallowedTools.includes('Bash'));
  await session.close();

  const unavailable = new ClaudeBackend({ platform: 'win32' });
  await assert.rejects(() => unavailable.openSession({
    role: 'worker', cwd: tmpdir(), prompt: 'test', schema: {}, access: 'read-only', timeoutMs: 1, staleAfterMs: 1
  }), /no equivalent native Windows process sandbox/);
});

test('Claude permission callbacks cover read-only approval and unusual handler outcomes', async () => {
  const readOnly = await open([], { access: 'read-only' });
  assert.equal((await readOnly.options.canUseTool('Bash', {}, context())).behavior, 'deny');
  await readOnly.session.close();

  const userInput = await open([], {
    requestUserInput: async () => ({}),
    onEvent: () => {}
  });
  const answer = await userInput.options.canUseTool('AskUserQuestion', {
    questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }]
  }, context());
  assert.deepEqual(answer.updatedInput.answers, { 'Continue?': '' });
  await userInput.session.close();

  const userInputFailure = await open([], { requestUserInput: async () => { throw 'cancelled'; } });
  assert.deepEqual(await userInputFailure.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Continue?' }] }, context()), {
    behavior: 'deny', message: 'cancelled'
  });
  await userInputFailure.session.close();

  const approvalFailure = await open([], { requestApproval: async () => { throw 'cancelled'; } });
  assert.deepEqual(await approvalFailure.options.canUseTool('Bash', {}, context()), { behavior: 'deny', message: 'cancelled' });
  await approvalFailure.session.close();

  const sessionApproval = await open([], { requestApproval: async () => 'session' });
  assert.deepEqual(await sessionApproval.options.canUseTool('Bash', {}, context()), { behavior: 'allow' });
  assert.equal((await sessionApproval.options.canUseTool('Edit', { file_path: 1 }, context())).behavior, 'allow');
  await sessionApproval.session.close();
});

test('Claude mapping covers omitted data and result fallback errors', () => {
  assert.deepEqual(claudeUserQuestions({ questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, 1] }] }), [{
    id: '0', question: 'Continue?', options: [{ label: 'Yes' }], allowCustom: true
  }]);
  assert.deepEqual(claudeUserQuestions({ questions: [{ question: 'Continue?' }] }), [{
    id: '0', question: 'Continue?', allowCustom: true
  }]);
  assert.throws(() => claudeUserQuestions({ questions: 'nope' }), /no questions/);
  assert.deepEqual(mapClaudeMessage({ type: 'assistant' }), [{ type: 'activity' }]);
  assert.deepEqual(mapClaudeResult({ type: 'result', subtype: 'failed', session_id: 's', usage: { input_tokens: 1 } }), {
    ok: false,
    output: null,
    error: 'claude turn failed (failed): failed',
    timedOut: false,
    stalled: false,
    sessionId: 's',
    usage: { inputTokens: 1, outputTokens: undefined }
  });
  assert.match(mapClaudeResult({ type: 'result', subtype: 'success', is_error: true }).error, /error: $/);
});

test('Claude sessions retain system session IDs and handle non-Error stream failures', async () => {
  const events = [];
  const active = await open([
    { type: 'system', session_id: 'system-session' },
    { type: 'assistant', message: { content: [] } },
    { type: 'result', subtype: 'success', is_error: false, structured_output: {}, session_id: 'result-session' }
  ], { onEvent: (event) => events.push(event) });
  assert.equal((await active.session.completion()).sessionId, 'result-session');
  assert.equal(active.session.sessionId, 'result-session');
  assert.deepEqual(events[0], { type: 'session', sessionId: 'system-session' });
  await active.session.close();

  let request;
  const backend = new ClaudeBackend({ platform: 'linux' }, (value) => {
    request = value;
    return query([], { error: 'stream unavailable' });
  });
  const session = await backend.openSession({
    role: 'worker', cwd: tmpdir(), prompt: 'test', schema: {}, access: 'workspace-write', timeoutMs: 1, staleAfterMs: 1
  });
  assert.equal((await session.completion()).error, 'stream unavailable');
  assert.equal(request.options.abortController.signal.aborted, false);
  await session.close();
});

test('Claude covers approval events, notebook paths, plain Git markers, and absent event handlers', async () => {
  const approvalEvents = [];
  const approved = await open([], {
    onEvent: (event) => approvalEvents.push(event),
    requestApproval: async () => 'once'
  });
  assert.equal((await approved.options.canUseTool('Bash', {}, context())).behavior, 'allow');
  assert.equal(approvalEvents.at(-1).reason, undefined);
  await approved.session.close();

  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-plain-git-'));
  writeFileSync(join(cwd, '.git'), 'not a git marker\n');
  const notebook = await open([], { cwd, access: 'workspace-write' });
  assert.equal((await notebook.options.canUseTool('NotebookEdit', { notebook_path: join(cwd, 'notes.ipynb') }, context())).behavior, 'allow');
  await notebook.session.close();

  const windows = await open([], {}, { platform: 'win32', nativeWindowsSandbox: 'allow-degraded' });
  assert.equal((await windows.options.canUseTool('Edit', { file_path: 'inside.ts' }, context())).behavior, 'allow');
  await windows.session.close();

  const silent = await open([
    { type: 'assistant', message: { content: [] } },
    { type: 'result', subtype: 'success', is_error: false, structured_output: {} }
  ]);
  assert.equal((await silent.session.completion()).ok, true);
  await silent.session.close();
});
