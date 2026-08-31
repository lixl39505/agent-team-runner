import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexBackend, codexWindowsSandboxCapability } from '../src/agent/codex/app-server.ts';

function spec(overrides = {}) {
  return {
    role: 'worker', cwd: '/workspace', prompt: 'Return JSON', schema: { type: 'object' },
    access: 'workspace-write', timeoutMs: 1_000, staleAfterMs: 1_000,
    ...overrides
  };
}

async function open(overrides = {}, request = async (method) => {
  if (method === 'thread/start') return { thread: { id: 'coverage-thread' } };
  return {};
}) {
  const backend = new CodexBackend();
  backend.ensureServer = async () => {};
  backend.connection = { exited: false, request, close() {} };
  return { backend, session: await backend.openSession(spec(overrides)) };
}

test('Codex covers probe, platform, and rejected-turn fallbacks', async () => {
  const probe = new CodexBackend({ command: 'custom-codex' });
  assert.equal(probe.command, 'custom-codex');
  probe.openSession = async () => ({
    completion: async () => ({ ok: false, output: null, timedOut: false, stalled: false }),
    close: async () => {}, interrupt: async () => {}
  });
  assert.equal((await probe.probe()).error, 'probe failed');

  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  const discovery = new CodexBackend({ command: 'custom-codex', spawn: () => child }).discover();
  child.emit('close', 0);
  assert.equal((await discovery).installed, true);

  const defaultChild = new EventEmitter();
  defaultChild.stdout = new EventEmitter();
  defaultChild.kill = () => {};
  const defaultDiscovery = new CodexBackend({ spawn: () => defaultChild }).discover();
  defaultChild.emit('close', 0);
  assert.equal((await defaultDiscovery).installed, true);

  assert.equal(typeof (await new CodexBackend().discover()).installed, 'boolean');

  const blocked = new CodexBackend();
  blocked.checkPlatform = async () => ({ ok: false, degraded: false, detail: 'blocked' });
  await assert.rejects(blocked.openSession(spec()), /blocked/);
  assert.match(codexWindowsSandboxCapability('unavailable', 'require', 'win32').detail, /readiness check failed;/);

  const readinessError = new CodexBackend({ platform: 'win32' });
  readinessError.ensureServer = async () => { throw 'not an Error'; };
  assert.match((await readinessError.checkPlatform()).detail, /not an Error/);

  const modelled = await open({ model: 'gpt-test' });
  await modelled.session.close();

  const rejected = await open({}, async (method) => {
    if (method === 'thread/start') return { thread: { id: 'coverage-thread' } };
    throw { message: 'not an Error' };
  });
  assert.match((await rejected.session.completion()).error, /\[object Object\]/);

  const missingCommand = new CodexBackend();
  assert.deepEqual(await missingCommand.handleServerRequest('item/commandExecution/requestApproval', { threadId: 'missing' }), { decision: 'decline' });
  missingCommand.sessions.set('thread', { approveCommand: async (command) => {
    assert.equal(command, '');
    return 'accept';
  } });
  assert.deepEqual(await missingCommand.handleServerRequest('item/commandExecution/requestApproval', { threadId: 'thread' }), { decision: 'accept' });
});

test('Codex restarts when initialized connections are missing or exited', async () => {
  const backend = new CodexBackend();
  backend.initialized = false;
  backend.initPromise = Promise.resolve();
  await backend.ensureServer();
  backend.initialized = true;
  backend.connection = null;
  backend.initPromise = Promise.resolve();
  await backend.ensureServer();
  backend.connection = { exited: true };
  await backend.ensureServer();
  backend.connection = { exited: false };
  await backend.ensureServer();
});

test('Codex covers optional approval and input fields', async () => {
  const events = [];
  const value = await open({
    onEvent: (event) => events.push(event),
    requestApproval: async () => 'deny',
    requestUserInput: async () => ({})
  });

  assert.equal(await value.session.approveCommand('command', {
    cwd: '/workspace',
    networkApprovalContext: { host: 'example.test' },
    proposedNetworkPolicyAmendments: []
  }, undefined, ['command']), 'decline');
  assert.equal(await value.session.approveCommand('command', {}, undefined, ['command']), 'decline');
  assert.equal(await value.session.approveFilePaths(['src/a.ts'], '/outside'), 'decline');
  assert.deepEqual(await value.session.approvePermissions({ permissions: {} }), { permissions: {}, scope: 'turn' });
  assert.deepEqual(await value.session.answerUserInput({
    questions: [{ id: 'missing', header: undefined, question: 'Question?', options: [{ label: 'Option', description: 'choice' }], isOther: false, isSecret: false }]
  }), { answers: { missing: { answers: [] } } });
  assert.equal(events.filter((event) => event.type === 'permission-check' && !event.allowed).length, 4);

  const withoutHandler = await open();
  assert.deepEqual(await withoutHandler.session.answerUserInput({ questions: [] }), { answers: {} });
  const failedHandler = await open({ requestUserInput: async () => { throw new Error('cancelled'); } });
  assert.deepEqual(await failedHandler.session.answerUserInput({ questions: [] }), { answers: {} });
});

test('Codex covers sparse session notifications and failed turn variants', async () => {
  const events = [];
  const value = await open({ onEvent: (event) => events.push(event) });
  value.session.onUsage({});
  value.session.onItemCompleted({ type: 'reasoning', id: 'reasoning', summary: [] });
  value.session.onTurnCompleted({ status: '', error: undefined });
  value.session.onTurnCompleted({ status: 'completed', error: null });
  assert.deepEqual(await value.session.completion(), {
    ok: false, output: null, error: 'codex turn failed', timedOut: false, stalled: false, sessionId: 'coverage-thread', usage: {}
  });
  assert.deepEqual(events, [{ type: 'session', sessionId: 'coverage-thread' }, { type: 'usage' }]);

  const failed = await open();
  failed.session.onTurnCompleted({ status: 'failed', error: 'plain error' });
  assert.match((await failed.session.completion()).error, /"plain error"/);

  const successful = await open();
  successful.session.onItemCompleted({ type: 'agentMessage', text: '{"ok":true}' });
  successful.session.onTurnCompleted({ status: 'completed', error: null });
  assert.deepEqual(await successful.session.completion(), {
    ok: true, output: { ok: true }, timedOut: false, stalled: false, sessionId: 'coverage-thread'
  });

  let rejectTurn;
  const settledBeforeRejection = await open({}, async (method) => {
    if (method === 'thread/start') return { thread: { id: 'coverage-thread' } };
    return await new Promise((_, reject) => { rejectTurn = reject; });
  });
  settledBeforeRejection.session.onTurnCompleted({ status: 'failed', error: null });
  rejectTurn(new Error('late failure'));
  await Promise.resolve();
  assert.match((await settledBeforeRejection.session.completion()).error, /codex turn failed/);

  const readonly = await open({ access: 'read-only', requestApproval: async () => 'once' });
  assert.deepEqual(await readonly.session.approvePermissions({
    permissions: { fileSystem: { read: ['/tmp'], write: ['/tmp'] } }
  }), { permissions: { fileSystem: { read: ['/tmp'], write: [] } }, scope: 'turn' });
});
