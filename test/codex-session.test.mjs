import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CodexBackend, codexDecision, codexWindowsSandboxCapability, legacyReviewDecision, mapCodexThreadStatus } from '../src/agent/codex/app-server.ts';

function spec(overrides = {}) {
  return {
    role: 'worker', cwd: '/workspace', prompt: 'Return JSON', schema: { type: 'object' },
    access: 'workspace-write', timeoutMs: 1_000, staleAfterMs: 1_000,
    ...overrides
  };
}

async function open(overrides = {}) {
  const backend = new CodexBackend();
  const requests = [];
  const connection = {
    exited: false,
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: method === 'thread/resume' ? 'resumed-thread' : 'thread-1' } };
      return {};
    },
    close() {}
  };
  backend.ensureServer = async () => {};
  backend.connection = connection;
  const events = [];
  const session = await backend.openSession(spec({ onEvent: (event) => events.push(event), ...overrides }));
  return { backend, connection, events, requests, session };
}

test('Codex session maps notifications to events and a structured turn result', async () => {
  const value = await open();
  assert.equal(value.session.sessionId, 'thread-1');
  assert.equal(value.events[0].type, 'session');
  value.backend.handleNotification('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { total: { inputTokens: 2, outputTokens: 3 } } });
  value.backend.handleNotification('thread/status/changed', { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } });
  value.backend.handleNotification('thread/status/changed', { threadId: 'thread-1', status: { type: 'idle' } });
  value.backend.handleNotification('item/agentMessage/delta', { threadId: 'thread-1' });
  value.backend.handleNotification('item/fileChange/patchUpdated', { threadId: 'thread-1', itemId: 'patch', changes: [{ path: 'src/a.ts' }] });
  value.backend.handleNotification('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: '{"status":"completed"}' } });
  value.backend.handleNotification('item/completed', { threadId: 'thread-1', item: { type: 'commandExecution', exitCode: 0, aggregatedOutput: 'passed' } });
  value.backend.handleNotification('turn/completed', { threadId: 'thread-1', turn: { status: 'completed', error: null } });
  assert.deepEqual(await value.session.completion(), {
    ok: true, output: { status: 'completed' }, timedOut: false, stalled: false, sessionId: 'thread-1',
    usage: { inputTokens: 2, outputTokens: 3 }
  });
  assert.equal(value.events.some((event) => event.type === 'tool-result' && event.ok), true);
  assert.deepEqual(value.events.filter((event) => event.type === 'session-status'), [
    { type: 'session-status', status: 'busy' },
    { type: 'session-status', status: 'idle' }
  ]);
});

test('Codex resumes a thread before starting its continuation turn', async () => {
  const value = await open({ resumeSessionId: 'saved-thread', model: 'gpt-test' });
  assert.equal(value.session.sessionId, 'resumed-thread');
  assert.deepEqual(value.requests.slice(0, 2), [
    {
      method: 'thread/resume',
      params: {
        threadId: 'saved-thread', cwd: '/workspace', model: 'gpt-test', approvalPolicy: 'untrusted', sandbox: 'workspace-write'
      }
    },
    {
      method: 'turn/start',
      params: {
        threadId: 'resumed-thread', input: [{ type: 'text', text: 'Return JSON', text_elements: [] }],
        cwd: '/workspace', model: 'gpt-test', approvalPolicy: 'untrusted',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
        outputSchema: { type: 'object' }
      }
    }
  ]);
});

test('Codex sends resumed read-only sessions without an optional model', async () => {
  const value = await open({ resumeSessionId: 'saved-thread', access: 'read-only' });
  assert.deepEqual(value.requests[0], {
    method: 'thread/resume',
    params: { threadId: 'saved-thread', cwd: '/workspace', approvalPolicy: 'untrusted', sandbox: 'read-only' }
  });
});

test('Codex sessions return parse and failed-turn errors and settle on close', async () => {
  const invalid = await open();
  invalid.backend.handleNotification('item/completed', { threadId: 'thread-1', item: { type: 'agentMessage', text: 'not JSON' } });
  invalid.backend.handleNotification('turn/completed', { threadId: 'thread-1', turn: { status: 'completed', error: null } });
  assert.match((await invalid.session.completion()).error, /not parseable JSON/);

  const failed = await open();
  failed.backend.handleNotification('turn/completed', { threadId: 'thread-1', turn: { status: 'failed', error: { message: 'boom' } } });
  assert.match((await failed.session.completion()).error, /codex turn failed.*boom/);

  const closed = await open();
  await closed.session.close();
  assert.match((await closed.session.completion()).error, /session closed/);
});

test('Codex routes approval, user input, and unknown server requests safely', async () => {
  const approvals = [];
  const value = await open({
    requestApproval: async (request) => { approvals.push(request); return 'session'; },
    requestUserInput: async () => ({ choice: ['yes'] })
  });
  value.backend.handleNotification('item/fileChange/patchUpdated', { threadId: 'thread-1', itemId: 'change', changes: [{ path: 'src/a.ts' }] });
  assert.deepEqual(await value.backend.handleServerRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', command: 'npm test' }), { decision: 'acceptForSession' });
  assert.deepEqual(await value.backend.handleServerRequest('item/fileChange/requestApproval', { threadId: 'thread-1', itemId: 'change', grantRoot: '/outside' }), { decision: 'acceptForSession' });
  assert.deepEqual(await value.backend.handleServerRequest('item/permissions/requestApproval', {
    threadId: 'thread-1', permissions: { network: { enabled: true }, fileSystem: { read: ['/tmp'], write: ['/tmp'] } }
  }), { permissions: { network: { enabled: true }, fileSystem: { read: ['/tmp'], write: ['/tmp'] } }, scope: 'session' });
  assert.deepEqual(await value.backend.handleServerRequest('item/tool/requestUserInput', {
    threadId: 'thread-1', questions: [{ id: 'choice', question: 'Continue?', options: null, isOther: true, isSecret: false }]
  }), { answers: { choice: { answers: ['yes'] } } });
  assert.deepEqual(await value.backend.handleServerRequest('item/tool/requestUserInput', { threadId: 'missing', questions: [] }), { answers: {} });
  assert.deepEqual(await value.backend.handleServerRequest('mcpServer/elicitation/request', {}), { action: 'decline', content: null, _meta: null });
  await assert.rejects(value.backend.handleServerRequest('unknown', {}), /unhandled/);
  assert.equal(approvals.length, 3);
});

test('Codex policy helpers map decisions and Windows capability consistently', () => {
  assert.equal(codexDecision('once'), 'accept');
  assert.equal(codexDecision('session'), 'acceptForSession');
  assert.equal(codexDecision('deny'), 'decline');
  assert.equal(legacyReviewDecision('accept'), 'approved');
  assert.deepEqual(legacyReviewDecision('decline'), { denied: { rejection: 'denied by user' } });
  assert.equal(legacyReviewDecision('acceptForSession'), 'approved_for_session');
  assert.equal(codexWindowsSandboxCapability('ready', 'require', 'win32').ok, true);
  assert.equal(codexWindowsSandboxCapability('notInstalled', 'require', 'win32').ok, false);
  assert.equal(codexWindowsSandboxCapability('unavailable', 'allow-degraded', 'win32', 'missing').degraded, true);
  assert.equal(mapCodexThreadStatus({ type: 'systemError' }), 'error');
  assert.equal(mapCodexThreadStatus({ type: 'notLoaded' }), 'error');
});
