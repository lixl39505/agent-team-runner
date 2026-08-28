import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CodexBackend } from '../src/agent/codex/app-server.ts';

function spec(overrides = {}) {
  return {
    role: 'worker', cwd: '/workspace', prompt: 'JSON', schema: { type: 'object' },
    access: 'workspace-write', timeoutMs: 1_000, staleAfterMs: 1_000,
    ...overrides
  };
}

async function open(access = 'workspace-write', overrides = {}) {
  const backend = new CodexBackend();
  const connection = {
    exited: false,
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'thread-branches' } };
      return {};
    },
    close() {}
  };
  backend.ensureServer = async () => {};
  backend.connection = connection;
  const session = await backend.openSession(spec({ access, ...overrides }));
  return { backend, session };
}

test('Codex model enumeration filters hidden entries and includes aliases', async () => {
  const backend = new CodexBackend();
  backend.ensureServer = async () => {};
  backend.connection = {
    exited: false,
    async request() {
      return { data: [
        { id: 'hidden', hidden: true },
        { id: 'plain', hidden: false },
        { id: 'alias', model: 'resolved', displayName: 'Resolved' },
        { id: 'same', model: 'same', displayName: 'Same' }
      ] };
    },
    close() {}
  };
  assert.deepEqual(await backend.listModels(), [
    { id: 'plain' },
    { id: 'alias', displayName: 'Resolved' },
    { id: 'resolved', displayName: 'Resolved' },
    { id: 'same', displayName: 'Same' }
  ]);
});

test('Codex Windows sandbox readiness is cached and failures fail closed', async () => {
  let requests = 0;
  const ready = new CodexBackend({ platform: 'win32' });
  ready.ensureServer = async () => {};
  ready.connection = {
    exited: false,
    async request() { requests += 1; return { status: 'ready' }; },
    close() {}
  };
  assert.equal((await ready.checkPlatform()).ok, true);
  assert.equal((await ready.checkPlatform()).ok, true);
  assert.equal(requests, 1);

  const failed = new CodexBackend({ platform: 'win32', nativeWindowsSandbox: 'require' });
  failed.ensureServer = async () => { throw new Error('server unavailable'); };
  assert.equal((await failed.checkPlatform()).ok, false);
  const degraded = new CodexBackend({ platform: 'win32', nativeWindowsSandbox: 'allow-degraded' });
  degraded.ensureServer = async () => { throw new Error('server unavailable'); };
  assert.equal((await degraded.checkPlatform()).degraded, true);
});

test('Codex probe closes sessions for successful and failed outcomes', async () => {
  for (const outcome of [
    { ok: true, output: 'ok', timedOut: false, stalled: false },
    { ok: false, output: null, error: 'failed', timedOut: false, stalled: false }
  ]) {
    const backend = new CodexBackend();
    let closed = 0;
    backend.openSession = async () => ({
      completion: async () => outcome,
      close: async () => { closed += 1; },
      interrupt: async () => {}
    });
    const result = await backend.probe('model');
    assert.equal(result.ok, outcome.ok);
    if (!outcome.ok) assert.equal(result.error, 'failed');
    assert.equal(closed, 1);
  }
});

test('Codex session permissions fail closed and strip readonly writes', async () => {
  const readOnly = await open('read-only', { requestApproval: async () => 'session' });
  assert.equal(await readOnly.session.approveFilePaths(['src/a.ts']), 'decline');
  assert.deepEqual(await readOnly.session.approvePermissions({
    permissions: {
      network: { enabled: true },
      fileSystem: { read: ['/tmp'], write: ['/tmp'], entries: [{ path: '/tmp/read', access: 'read' }, { path: '/tmp/write', access: 'write' }] }
    }
  }), {
    permissions: {
      network: { enabled: true },
      fileSystem: { read: ['/tmp'], write: [], entries: [{ path: '/tmp/read', access: 'read' }] }
    },
    scope: 'session'
  });

  const noHandler = await open();
  assert.equal(await noHandler.session.approveCommand('npm test'), 'decline');
  assert.deepEqual(await noHandler.session.approvePermissions({ permissions: {} }), { permissions: {}, scope: 'turn' });
});

test('Codex workspace permission paths handle automatic, denied, and thrown decisions', async () => {
  const automatic = await open();
  assert.equal(await automatic.session.approveFilePaths(['src/a.ts']), 'accept');

  const denied = await open('workspace-write', { requestApproval: async () => 'deny' });
  assert.equal(await denied.session.approveFilePaths(['outside/a.ts'], '/outside', 'outside root'), 'decline');
  assert.equal(await denied.session.approveCommand('curl test', { networkApprovalContext: { host: 'example.test' } }), 'decline');

  const thrown = await open('workspace-write', { requestApproval: async () => { throw new Error('closed'); } });
  assert.equal(await thrown.session.approveCommand('npm test'), 'decline');
});
