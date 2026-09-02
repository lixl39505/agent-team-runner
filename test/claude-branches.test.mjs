import { test } from 'vitest';
import { denialGuidance } from '../src/core/approval-collector.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeBackend } from '../src/agent/claude/sdk.ts';

function fakeQuery({ messages = [], iteratorError, interrupt = async () => {}, close = () => {} } = {}) {
  return {
    close,
    interrupt,
    async *[Symbol.asyncIterator]() {
      if (iteratorError) throw iteratorError;
      yield* messages;
    }
  };
}

async function openFakeSession(query, overrides = {}) {
  const cwd = overrides.cwd ?? mkdtempSync(join(tmpdir(), 'agent-team-claude-branches-'));
  let request;
  const backend = new ClaudeBackend({ platform: 'linux' }, (value) => {
    request = value;
    return query;
  });
  const session = await backend.openSession({
    role: 'worker',
    label: 'branch test',
    cwd,
    prompt: 'test',
    schema: { type: 'object' },
    access: 'workspace-write',
    timeoutMs: 1_000,
    staleAfterMs: 1_000,
    ...overrides
  });
  return { backend, cwd, options: request.options, session };
}

function context(overrides = {}) {
  return { signal: new AbortController().signal, toolUseID: 'tool', requestId: 'request', ...overrides };
}

test('Claude canUseTool denies unavailable and failed user-input handlers', async () => {
  const unavailable = await openFakeSession(fakeQuery());
  const noHandler = await unavailable.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Continue?' }] }, context());
  assert.deepEqual(noHandler, { behavior: 'deny', message: 'No interactive user-input handler is available.' });
  await unavailable.session.close();

  const failed = await openFakeSession(fakeQuery(), {
    requestUserInput: async () => { throw new Error('input service failed'); }
  });
  const handlerError = await failed.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Continue?' }] }, context());
  assert.deepEqual(handlerError, { behavior: 'deny', message: 'input service failed' });
  await failed.session.close();
});

test('Claude canUseTool reports all approval denial paths', async () => {
  const events = [];
  const missing = await openFakeSession(fakeQuery(), { onEvent: (event) => events.push(event) });
  const noHandler = await missing.options.canUseTool('Bash', { command: 'pwd' }, context());
  assert.deepEqual(noHandler, { behavior: 'deny', message: 'no approval handler is available' });
  assert.deepEqual(events, [{
    type: 'permission-check', tool: 'Bash', input: { command: 'pwd' }, allowed: false,
    reason: 'no approval handler is available'
  }]);
  await missing.session.close();

  const rejectedEvents = [];
  const rejected = await openFakeSession(fakeQuery(), {
    onEvent: (event) => rejectedEvents.push(event),
    requestApproval: async () => { throw new Error('approval service failed'); }
  });
  const handlerError = await rejected.options.canUseTool('Bash', { command: 'pwd' }, context());
  assert.deepEqual(handlerError, { behavior: 'deny', message: 'approval service failed' });
  assert.equal(rejectedEvents.at(-1).reason, 'approval service failed');
  await rejected.session.close();

  const deniedEvents = [];
  const denied = await openFakeSession(fakeQuery(), {
    onEvent: (event) => deniedEvents.push(event),
    requestApproval: async () => 'deny'
  });
  const userDenied = await denied.options.canUseTool('Bash', { command: 'pwd' }, context());
  assert.deepEqual(userDenied, { behavior: 'deny', message: denialGuidance });
  assert.equal(deniedEvents.at(-1).reason, 'denied by user');
  await denied.session.close();
});

test('Claude canUseTool maps approval kinds and asks for matched workspace edits', async () => {
  const approvals = [];
  const { cwd, options, session } = await openFakeSession(fakeQuery(), {
    requestApproval: async (request) => {
      approvals.push(request);
      return 'once';
    }
  });
  const outside = join(tmpdir(), 'agent-team-claude-outside.txt');
  const requests = [
    ['Bash', { command: 'pwd' }, context()],
    ['Edit', { file_path: outside }, context()],
    ['WebFetch', { url: 'https://example.test' }, context()],
    ['mcp__release', {}, context()],
    ['Write', { file_path: outside }, context({ blockedPath: outside })],
    ['Edit', { file_path: join(cwd, 'matched.ts') }, context({ matchedAskRule: 'ask-rule' })]
  ];
  for (const [tool, input, nativeContext] of requests) {
    assert.equal((await options.canUseTool(tool, input, nativeContext)).behavior, 'allow');
  }
  assert.deepEqual(approvals.map((request) => request.kind), [
    'command', 'file-change', 'network', 'tool', 'external-directory', 'file-change'
  ]);
  assert.equal(approvals.at(-1).input.file_path, join(cwd, 'matched.ts'));
  await session.close();
});

test('Claude sessions handle empty and failed pumps and close fake queries safely', async () => {
  let emptyClosed = 0;
  const empty = await openFakeSession(fakeQuery({ close: () => { emptyClosed += 1; } }));
  assert.deepEqual(await empty.session.completion(), {
    ok: false, output: null, error: 'claude session ended without a result message', timedOut: false, stalled: false
  });
  await empty.session.close();
  assert.equal(emptyClosed, 1);

  const failed = await openFakeSession(fakeQuery({ iteratorError: new Error('stream failed') }));
  assert.deepEqual(await failed.session.completion(), {
    ok: false, output: null, error: 'stream failed', timedOut: false, stalled: false
  });
  await failed.session.close();

  const throwingClose = await openFakeSession(fakeQuery({ close: () => { throw new Error('already closed'); } }));
  await assert.doesNotReject(throwingClose.session.close());
});

test('Claude session interrupt uses the fake interrupt and aborts when it fails', async () => {
  let interrupted = 0;
  const successful = await openFakeSession(fakeQuery({ interrupt: async () => { interrupted += 1; } }));
  await successful.session.interrupt();
  assert.equal(interrupted, 1);
  await successful.session.close();

  const failed = await openFakeSession(fakeQuery({ interrupt: async () => { throw new Error('interrupt failed'); } }));
  assert.equal(failed.options.abortController.signal.aborted, false);
  await failed.session.interrupt();
  assert.equal(failed.options.abortController.signal.aborted, true);
  await failed.session.close();
});

test('Claude sandbox protects regular and linked-worktree Git metadata', async () => {
  const regular = mkdtempSync(join(tmpdir(), 'agent-team-claude-git-regular-'));
  mkdirSync(join(regular, '.git'));
  const regularSession = await openFakeSession(fakeQuery(), { cwd: regular });
  assert.deepEqual(regularSession.options.sandbox.filesystem.denyWrite, [join(regular, '.git')]);
  await regularSession.session.close();

  const withoutCommon = mkdtempSync(join(tmpdir(), 'agent-team-claude-git-linked-'));
  const gitDir = join(withoutCommon, 'metadata', 'worktree');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(withoutCommon, '.git'), 'gitdir: metadata/worktree\n');
  const linkedSession = await openFakeSession(fakeQuery(), { cwd: withoutCommon });
  assert.deepEqual(linkedSession.options.sandbox.filesystem.denyWrite, [join(withoutCommon, '.git'), gitDir]);
  await linkedSession.session.close();

  const withCommon = mkdtempSync(join(tmpdir(), 'agent-team-claude-git-common-'));
  const linkedGitDir = join(withCommon, 'metadata', 'worktree');
  mkdirSync(linkedGitDir, { recursive: true });
  writeFileSync(join(withCommon, '.git'), 'gitdir: metadata/worktree\n');
  writeFileSync(join(linkedGitDir, 'commondir'), '../common\n');
  const commonSession = await openFakeSession(fakeQuery(), { cwd: withCommon });
  assert.deepEqual(commonSession.options.sandbox.filesystem.denyWrite, [
    join(withCommon, '.git'), linkedGitDir, join(withCommon, 'metadata', 'common')
  ]);
  await commonSession.session.close();
});

test('Claude threads taskId from the session spec into permission requests', async () => {
  const approvals = [];
  const questions = [];
  const { options, session } = await openFakeSession(fakeQuery(), {
    taskId: 'T9',
    requestApproval: async (request) => { approvals.push(request); return 'deny'; },
    requestUserInput: async (request) => { questions.push(request); return {}; }
  });
  await options.canUseTool('Bash', { command: 'pwd' }, context());
  await options.canUseTool('AskUserQuestion', { questions: [{ question: 'Continue?' }] }, context());
  assert.deepEqual(approvals.map((request) => request.taskId), ['T9']);
  assert.deepEqual(questions.map((request) => request.taskId), ['T9']);
  await session.close();
});
