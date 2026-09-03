import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeBackend, editPatternWithinWorkspace, mapOpenCodeSessionStatus } from '../src/agent/opencode/sdk.ts';

// edit 权限的工作区包含性检查按 realpath 解析：自动放行场景必须使用真实存在的目录。
const REAL_WORKSPACE = mkdtempSync(join(tmpdir(), 'opencode-workspace-'));
mkdirSync(join(REAL_WORKSPACE, 'src'), { recursive: true });
writeFileSync(join(REAL_WORKSPACE, 'src', 'feature.ts'), 'export {};\n', 'utf8');

function sessionSpec(overrides = {}) {
  return {
    role: 'worker', cwd: '/workspace', prompt: 'Return JSON', schema: { type: 'object' },
    access: 'workspace-write', timeoutMs: 1_000, staleAfterMs: 1_000,
    ...overrides
  };
}

async function open(response, overrides = {}, transport = {}) {
  const backend = new OpenCodeBackend();
  const calls = { creates: [], gets: [], statuses: [], prompts: [], permissions: [], replies: [], rejects: [], events: [] };
  const client = {
    session: {
      async create(request) { calls.creates.push(request); return transport.create ? transport.create(request) : { data: { id: 'session-1' } }; },
      async get(request) { calls.gets.push(request); return transport.get ? transport.get(request) : { data: undefined }; },
      async status(request) { calls.statuses.push(request); return transport.status ? transport.status(request) : { data: undefined }; },
      async prompt(request) { calls.prompts.push(request); return response instanceof Error ? Promise.reject(response) : response; },
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

test('OpenCode resumes only an existing idle session in the requested directory', async () => {
  const resumed = await open(
    { data: { info: { structured: { status: 'completed' } } } },
    { resumeSessionId: 'saved-session' },
    {
      get: async () => ({ data: { id: 'saved-session', directory: '/workspace' } }),
      status: async () => ({ data: { 'saved-session': { type: 'idle' } } })
    }
  );
  assert.equal(resumed.session.sessionId, 'saved-session');
  assert.deepEqual(resumed.calls.creates, []);
  assert.deepEqual(resumed.calls.gets, [{ path: { id: 'saved-session' }, query: { directory: '/workspace' } }]);
  assert.deepEqual(resumed.calls.statuses, [{ query: { directory: '/workspace' } }]);
  assert.equal(resumed.calls.prompts[0].path.id, 'saved-session');
  assert.equal((await resumed.session.completion()).ok, true);

  resumed.backend.handleEvent({ type: 'session.status', properties: { sessionID: 'saved-session', status: { type: 'busy' } } });
  resumed.backend.handleEvent({ type: 'session.idle', properties: { sessionID: 'saved-session' } });
  assert.deepEqual(resumed.calls.events.filter((event) => event.type === 'session-status'), [
    { type: 'session-status', status: 'busy' },
    { type: 'session-status', status: 'idle' }
  ]);
});

test('OpenCode fails closed rather than creating a session when continuation cannot be verified', async () => {
  const cases = [
    {
      transport: { get: async () => ({ data: undefined }) },
      error: /not found or is unreadable/
    },
    {
      transport: {
        get: async () => ({ data: { id: 'saved-session', directory: '/other' } })
      },
      error: /directory does not match/
    },
    {
      transport: {
        get: async () => ({ data: { id: 'saved-session', directory: '/workspace' } }),
        status: async () => ({ data: { 'saved-session': { type: 'busy' } } })
      },
      error: /is not idle \(busy\)/
    },
    {
      transport: {
        get: async () => ({ data: { id: 'saved-session', directory: '/workspace' } }),
        status: async () => ({ data: {} })
      },
      error: /status is unavailable/
    }
  ];
  for (const { transport, error } of cases) {
    const backend = new OpenCodeBackend();
    const calls = { creates: 0 };
    const client = {
      session: {
        async create() { calls.creates += 1; return { data: { id: 'new-session' } }; },
        ...transport
      }
    };
    backend.ensureClient = async () => client;
    backend.ensureSubscribed = async () => {};
    backend.questionClient = { question: { async reply() {}, async reject() {} } };
    await assert.rejects(backend.openSession(sessionSpec({ resumeSessionId: 'saved-session' })), error);
    assert.equal(calls.creates, 0);
  }
  assert.equal(mapOpenCodeSessionStatus({ type: 'retry' }), 'busy');
  assert.equal(mapOpenCodeSessionStatus({ type: 'unknown' }), 'error');
  assert.equal(mapOpenCodeSessionStatus(null), 'error');
  assert.equal(mapOpenCodeSessionStatus({ type: 'idle' }), 'idle');
});

test('OpenCode exposes non-Error resume transport failures without creating a replacement session', async () => {
  const backend = new OpenCodeBackend();
  backend.ensureClient = async () => ({ session: {
    async get() { throw 'get failed'; },
    async create() { throw new Error('must not create'); }
  } });
  backend.ensureSubscribed = async () => {};
  backend.questionClient = { question: { async reply() {}, async reject() {} } };
  await assert.rejects(backend.openSession(sessionSpec({ resumeSessionId: 'saved-session' })), /get failed/);

  backend.ensureClient = async () => ({ session: {
    async get() { return { data: { id: 'saved-session', directory: '/workspace' } }; },
    async status() { throw 'status failed'; },
    async create() { throw new Error('must not create'); }
  } });
  await assert.rejects(backend.openSession(sessionSpec({ resumeSessionId: 'saved-session' })), /status failed/);

  backend.ensureClient = async () => ({ session: {
    async get() { throw new Error('get error'); },
    async create() { throw new Error('must not create'); }
  } });
  await assert.rejects(backend.openSession(sessionSpec({ resumeSessionId: 'saved-session' })), /get error/);

  backend.ensureClient = async () => ({ session: {
    async get() { return { data: { id: 'saved-session', directory: '/workspace' } }; },
    async status() { throw new Error('status error'); },
    async create() { throw new Error('must not create'); }
  } });
  await assert.rejects(backend.openSession(sessionSpec({ resumeSessionId: 'saved-session' })), /status error/);
});

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

  const edit = await open({ data: { info: { structured: {} } } }, { cwd: REAL_WORKSPACE });
  await edit.session.answerPermission('p3', { type: 'edit', pattern: 'src/feature.ts' });
  assert.equal(edit.calls.permissions[0].body.response, 'once');

  // 越界/无 pattern 的 edit 不再自动放行：无审批处理器时 fail-closed 拒绝。
  const outsideEdit = await open({ data: { info: { structured: {} } } });
  await outsideEdit.session.answerPermission('p4', { type: 'edit', pattern: '../outside.txt' });
  assert.equal(outsideEdit.calls.permissions[0].body.response, 'reject');
  assert.equal(outsideEdit.calls.events.at(-1).reason, 'edit target outside the session workspace');

  const missingPattern = await open({ data: { info: { structured: {} } } });
  await missingPattern.session.answerPermission('p5', { type: 'edit' });
  assert.equal(missingPattern.calls.permissions[0].body.response, 'reject');
});

test('OpenCode routes out-of-workspace edits through the approval channel', async () => {
  let approval;
  const routed = await open({ data: { info: { structured: {} } } }, {
    requestApproval: async (request) => {
      approval = request;
      return 'once';
    }
  });
  await routed.session.answerPermission('p6', { type: 'edit', pattern: '/etc/passwd' });
  assert.equal(routed.calls.permissions[0].body.response, 'once');
  assert.equal(approval.kind, 'file-change');
  assert.equal(approval.title, 'OpenCode requests edit: /etc/passwd');

  const glob = await open({ data: { info: { structured: {} } } });
  await glob.session.answerPermission('p7', { type: 'edit', pattern: ['src/**', '../escape.md'] });
  assert.equal(glob.calls.permissions[0].body.response, 'reject');
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

test('editPatternWithinWorkspace judges literal prefixes, resolves symlinks, and rejects unknown targets', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'opencode-edit-'));
  mkdirSync(join(workspace, 'src', 'nested'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'a.ts'), 'export {};\n', 'utf8');
  // 工作区内的目录软链接指向区外：词法在区内，realpath 在区外，必须拒绝。
  symlinkSync(tmpdir(), join(workspace, 'escape-link'));

  assert.equal(await editPatternWithinWorkspace(['src/**', 'docs/a.md'], workspace), true);
  assert.equal(await editPatternWithinWorkspace('*.ts', workspace), true);
  assert.equal(await editPatternWithinWorkspace(join(workspace, 'src', 'a.ts'), workspace), true);
  // 新文件（目标不存在）：上探到最近存在祖先判定。
  assert.equal(await editPatternWithinWorkspace('src/nested/new-file.ts', workspace), true);
  // 目录软链接：字面在区内、解析在区外。
  assert.equal(await editPatternWithinWorkspace('escape-link/steal.txt', workspace), false);
  // 软链接目录下更深的新文件同样不允许（上探命中软链接目录）。
  assert.equal(await editPatternWithinWorkspace('escape-link/deep/new.txt', workspace), false);
  assert.equal(await editPatternWithinWorkspace('../outside.txt', workspace), false);
  assert.equal(await editPatternWithinWorkspace(['/etc/passwd'], workspace), false);
  assert.equal(await editPatternWithinWorkspace(undefined, workspace), false);
  assert.equal(await editPatternWithinWorkspace([], workspace), false);
  assert.equal(await editPatternWithinWorkspace([''], workspace), false);
  // 工作区根自身是软链接时，以解析后的根做包含判定。
  const linkRoot = join(workspace, 'root-link');
  symlinkSync(workspace, linkRoot);
  assert.equal(await editPatternWithinWorkspace('src/a.ts', linkRoot), true);
  assert.equal(await editPatternWithinWorkspace('../outside.txt', linkRoot), false);
});
