import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CodexBackend } from '../src/agent/codex/app-server.ts';

function spec(overrides = {}) {
  return {
    role: 'worker',
    cwd: '/workspace',
    prompt: 'Return JSON',
    schema: { type: 'object' },
    access: 'workspace-write',
    timeoutMs: 1_000,
    staleAfterMs: 1_000,
    ...overrides
  };
}

async function openSession(overrides = {}) {
  const backend = new CodexBackend();
  const requests = [];
  backend.ensureServer = async () => {};
  backend.connection = {
    exited: false,
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'turn/interrupt') throw new Error('server already exited');
      return {};
    },
    close() {}
  };
  const events = [];
  const session = await backend.openSession(spec({ onEvent: (event) => events.push(event), ...overrides }));
  return { backend, events, requests, session };
}

test('Codex notification dispatch handles every routed notification and absent sessions', () => {
  const backend = new CodexBackend();
  const calls = [];
  backend.sessions.set('thread', {
    onTurnCompleted(turn) { calls.push(['turn', turn]); },
    onItemCompleted(item) { calls.push(['item', item]); },
    onActivity() { calls.push(['activity']); },
    onUsage(usage) { calls.push(['usage', usage]); },
    onFileChangePatch(itemId, paths) { calls.push(['patch', itemId, paths]); }
  });

  const turn = { status: 'completed', error: null };
  const item = { type: 'agentMessage', text: '{}' };
  backend.handleNotification('turn/completed', { threadId: 'thread', turn });
  backend.handleNotification('item/completed', { threadId: 'thread', item });
  for (const method of [
    'item/agentMessage/delta',
    'command/exec/outputDelta',
    'item/commandExecution/outputDelta',
    'item/reasoning/summaryTextDelta'
  ]) {
    backend.handleNotification(method, { threadId: 'thread' });
  }
  backend.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread', tokenUsage: { total: { inputTokens: 3, outputTokens: 5 } }
  });
  backend.handleNotification('item/fileChange/patchUpdated', {
    threadId: 'thread', itemId: 'patch', changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]
  });

  backend.handleNotification('turn/completed', { threadId: 'missing', turn });
  backend.handleNotification('item/completed', { threadId: 'missing', item });
  backend.handleNotification('item/agentMessage/delta', {});
  backend.handleNotification('thread/tokenUsage/updated', {
    threadId: 'missing', tokenUsage: { total: { inputTokens: 1, outputTokens: 1 } }
  });
  backend.handleNotification('item/fileChange/patchUpdated', {
    threadId: 'missing', itemId: 'patch', changes: []
  });
  backend.handleNotification('unhandled/notification', {});

  assert.deepEqual(calls, [
    ['turn', turn],
    ['item', item],
    ['activity'],
    ['activity'],
    ['activity'],
    ['activity'],
    ['usage', { inputTokens: 3, outputTokens: 5 }],
    ['patch', 'patch', ['src/a.ts', 'src/b.ts']]
  ]);
});

test('Codex server requests use private session fakes and fail closed', async () => {
  const backend = new CodexBackend();
  const calls = [];
  backend.sessions.set('thread', {
    async approveCommand(command, request, legacyReason, rawCommand) {
      calls.push(['command', command, request, legacyReason, rawCommand]);
      return 'acceptForSession';
    },
    async approveFileChange(itemId, grantRoot, reason) {
      calls.push(['file', itemId, grantRoot, reason]);
      return 'accept';
    },
    async approveFilePaths(paths, grantRoot, reason) {
      calls.push(['paths', paths, grantRoot, reason]);
      return 'decline';
    },
    async approvePermissions(request) {
      calls.push(['permissions', request]);
      return { permissions: { network: { enabled: true } }, scope: 'turn' };
    },
    async answerUserInput(request) {
      calls.push(['input', request]);
      return { answers: { question: { answers: ['answer'] } } };
    }
  });

  assert.deepEqual(await backend.handleServerRequest('item/commandExecution/requestApproval', {
    threadId: 'thread', command: 'npm test'
  }), { decision: 'acceptForSession' });
  assert.deepEqual(await backend.handleServerRequest('item/commandExecution/requestApproval', {
    threadId: 'missing', command: 'npm test'
  }), { decision: 'decline' });
  assert.deepEqual(await backend.handleServerRequest('item/fileChange/requestApproval', {
    threadId: 'thread', itemId: 'change', grantRoot: '/tmp', reason: 'write'
  }), { decision: 'accept' });
  assert.deepEqual(await backend.handleServerRequest('item/fileChange/requestApproval', {
    threadId: 'thread'
  }), { decision: 'decline' });
  assert.deepEqual(await backend.handleServerRequest('item/fileChange/requestApproval', {
    itemId: 'change'
  }), { decision: 'decline' });
  assert.deepEqual(await backend.handleServerRequest('item/permissions/requestApproval', {
    threadId: 'thread', permissions: { network: { enabled: true } }
  }), { permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.deepEqual(await backend.handleServerRequest('item/permissions/requestApproval', {
    threadId: 'missing', permissions: {}
  }), { permissions: {}, scope: 'turn' });
  assert.deepEqual(await backend.handleServerRequest('applyPatchApproval', {
    conversationId: 'thread', fileChanges: { 'src/a.ts': {} }, grantRoot: '/tmp', reason: 'write'
  }), { decision: { denied: { rejection: 'denied by user' } } });
  assert.deepEqual(await backend.handleServerRequest('applyPatchApproval', {
    conversationId: 'missing', fileChanges: {}
  }), { decision: { denied: { rejection: 'denied by user' } } });
  assert.deepEqual(await backend.handleServerRequest('execCommandApproval', {
    conversationId: 'thread', command: ['npm', 'test'], reason: 'verify'
  }), { decision: 'approved_for_session' });
  assert.deepEqual(await backend.handleServerRequest('execCommandApproval', {
    conversationId: 'missing', command: ['npm', 'test']
  }), { decision: { denied: { rejection: 'denied by user' } } });
  assert.deepEqual(await backend.handleServerRequest('item/tool/requestUserInput', {
    threadId: 'thread', questions: []
  }), { answers: { question: { answers: ['answer'] } } });
  assert.deepEqual(await backend.handleServerRequest('item/tool/requestUserInput', {
    threadId: 'missing', questions: []
  }), { answers: {} });
  assert.deepEqual(await backend.handleServerRequest('mcpServer/elicitation/request', {}), {
    action: 'decline', content: null, _meta: null
  });
  await assert.rejects(backend.handleServerRequest('unknown/request', {}), /unhandled app-server request/);

  assert.deepEqual(calls.map(([kind]) => kind), ['command', 'file', 'permissions', 'paths', 'command', 'input']);
  assert.equal(calls[4][1], 'npm test');
  assert.equal(calls[4][3], 'verify');
  assert.deepEqual(calls[4][4], ['npm', 'test']);
});

test('Codex session item, interruption, and close paths settle without a CLI', async () => {
  const approvals = [];
  const value = await openSession({
    requestApproval: async (request) => {
      approvals.push(request);
      return 'once';
    }
  });

  value.backend.handleNotification('item/fileChange/patchUpdated', {
    threadId: 'thread', itemId: 'change', changes: [{ path: 'src/a.ts' }]
  });
  value.backend.handleNotification('item/agentMessage/delta', { threadId: 'thread' });
  assert.equal(value.session.cwd, '/workspace');
  assert.deepEqual(await value.backend.handleServerRequest('item/commandExecution/requestApproval', {
    threadId: 'thread', command: 'npm test'
  }), { decision: 'accept' });
  await value.backend.handleServerRequest('item/fileChange/requestApproval', {
    threadId: 'thread', itemId: 'change', grantRoot: '/tmp'
  });
  value.backend.handleNotification('item/completed', { threadId: 'thread', item: { type: 'fileChange', id: 'change' } });
  await value.backend.handleServerRequest('item/fileChange/requestApproval', {
    threadId: 'thread', itemId: 'change', grantRoot: '/tmp'
  });
  value.backend.handleNotification('item/completed', {
    threadId: 'thread', item: { type: 'agentMessage', text: '{"ok":true}' }
  });
  value.backend.handleNotification('item/completed', {
    threadId: 'thread', item: { type: 'commandExecution', exitCode: null, aggregatedOutput: null }
  });
  value.backend.handleNotification('item/completed', {
    threadId: 'thread', item: { type: 'commandExecution', exitCode: 1, aggregatedOutput: 'failed' }
  });

  assert.deepEqual(
    approvals.filter((request) => request.tool === 'Edit').map((request) => request.input.paths),
    [['src/a.ts'], []]
  );
  assert.equal(approvals.some((request) => request.tool === 'Bash' && request.input.command === 'npm test'), true);
  assert.equal(value.events.some((event) => event.type === 'activity'), true);
  assert.equal(value.events.some((event) => event.type === 'message' && event.text === '{"ok":true}'), true);
  assert.deepEqual(value.events.filter((event) => event.type === 'tool-result'), [
    { type: 'tool-result', tool: 'Bash', ok: true },
    { type: 'tool-result', tool: 'Bash', ok: false, summary: 'failed' }
  ]);

  await value.session.interrupt();
  await value.session.close();
  await value.session.close();
  assert.deepEqual(await value.session.completion(), {
    ok: false,
    output: null,
    error: 'session closed before the turn completed',
    timedOut: true,
    stalled: false,
    sessionId: 'thread'
  });
  assert.equal(value.backend.sessions.size, 0);
  assert.equal(value.requests.some(({ method }) => method === 'turn/interrupt'), true);

  const settled = await openSession();
  settled.backend.handleNotification('turn/completed', {
    threadId: 'thread', turn: { status: 'failed', error: null }
  });
  await settled.session.close();
  assert.match((await settled.session.completion()).error, /codex turn failed/);
  assert.equal(settled.backend.sessions.size, 0);
});
