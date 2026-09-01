import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { test } from 'vitest';
import { createMcpServer, runMcpServer } from '../src/mcp/server.ts';

async function createConnectedServer(request, options = {}, clientOptions = {}, configureClient) {
  const server = createMcpServer({ request }, options);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, clientOptions);
  configureClient?.(client);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

async function waitFor(check) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for MCP gateway');
}

async function closeConnectedServer({ server, client }) {
  await client.close();
  await server.close();
}

function text(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}

function projectRegistration() {
  return {
    gitCommonDir: '/repo/.git',
    repoRoot: '/repo',
    displayName: 'Test repository',
    gitIdentity: { remote: 'git@example.test:team/repo.git' },
    policy: {
      baseRef: 'HEAD',
      verificationAllowedCommandPrefixes: ['npm test'],
      baselinePathPolicy: { allowed: ['src/**'] },
      agentProfileMapping: { defaultAgent: 'worker' },
      backendPolicy: {}
    }
  };
}

function executionContract() {
  return {
    version: 1,
    project: { id: 'project-1', repoRoot: '/repo', baseRef: 'HEAD' },
    target: { integrationBranch: 'agent-team/integration' },
    provenance: { documents: [{ kind: 'spec', locator: 'spec.md', revision: 'abc123' }] },
    tasks: [{
      id: 'T001',
      externalId: 'SPEC-1',
      title: 'Create feature',
      description: 'Implement the feature.',
      role: 'worker',
      agent: 'worker',
      dependsOn: [],
      allowedPaths: ['src/**'],
      blockedPaths: ['docs/**'],
      acceptance: ['feature works'],
      verificationCommands: ['npm test'],
      implementationSkills: [{ name: 'test-skill', role: 'worker', required: false, source: 'project' }],
      implementationGuidance: ['Write tests first.'],
      allowNoChanges: false
    }]
  };
}

test('MCP bridge lists and dispatches every fixed IPC tool', async () => {
  const calls = [];
  const connected = await createConnectedServer(async (method, params) => {
    calls.push({ method, params });
    return { method, params: params ?? null };
  });
  const { client } = connected;

  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'agent_team_answer_interaction',
      'agent_team_archive_project',
      'agent_team_attach_controller',
      'agent_team_cancel_run',
      'agent_team_claim_interaction',
      'agent_team_disconnect_controller',
      'agent_team_get_handoff',
      'agent_team_get_host_capabilities',
      'agent_team_get_run',
      'agent_team_get_status',
      'agent_team_heartbeat_controller',
      'agent_team_list_interactions',
      'agent_team_list_project_skills',
      'agent_team_list_projects',
      'agent_team_list_reconnectable_runs',
      'agent_team_list_runs',
      'agent_team_pause_run',
      'agent_team_read_agent_log',
      'agent_team_read_run_events',
      'agent_team_register_project',
      'agent_team_requeue_interactions',
      'agent_team_resume_external_thread',
      'agent_team_start_review_turn',
      'agent_team_start_run',
      'agent_team_submit_execution_contract',
      'agent_team_update_task_contract',
      'agent_team_validate_execution_contract'
    ]);
    assert.equal(tools.tools.some((tool) => tool.name.includes('shutdown')), false);

    const cases = [
      ['agent_team_get_status', {}, 'health', undefined],
      ['agent_team_list_interactions', { runId: 'run-1' }, 'interaction.list', { runId: 'run-1' }],
      ['agent_team_claim_interaction', { id: 'interaction-1', clientId: 'client-1' }, 'interaction.claim', { id: 'interaction-1', clientId: 'client-1' }],
      ['agent_team_answer_interaction', { id: 'interaction-1', clientId: 'client-1', response: { approved: true }, idempotencyKey: 'answer-1' }, 'interaction.answer', { id: 'interaction-1', clientId: 'client-1', response: { approved: true }, idempotencyKey: 'answer-1' }],
      ['agent_team_requeue_interactions', { clientId: 'client-1' }, 'interaction.requeue_client', { clientId: 'client-1' }],
      ['agent_team_attach_controller', { runId: 'run-1', host: 'host-1', externalThreadId: 'thread-1', clientId: 'client-1', lastAckEventId: 3 }, 'controller.attach', { runId: 'run-1', host: 'host-1', externalThreadId: 'thread-1', clientId: 'client-1', lastAckEventId: 3 }],
      ['agent_team_disconnect_controller', { runId: 'run-1', clientId: 'client-1' }, 'controller.disconnect', { runId: 'run-1', clientId: 'client-1' }],
      ['agent_team_heartbeat_controller', { runId: 'run-1', clientId: 'client-1' }, 'controller.heartbeat', { runId: 'run-1', clientId: 'client-1' }],
      ['agent_team_list_reconnectable_runs', {}, 'controller.reconnectable', undefined],
      ['agent_team_get_host_capabilities', { host: 'codex' }, 'host.capabilities', { host: 'codex' }],
      ['agent_team_resume_external_thread', { runId: 'run-1', clientId: 'client-1', explicitlyRequested: true }, 'controller.resume_external_thread', { runId: 'run-1', clientId: 'client-1', explicitlyRequested: true }],
      ['agent_team_start_review_turn', { runId: 'run-1', clientId: 'client-1', explicitlyRequested: true }, 'controller.start_review_turn', { runId: 'run-1', clientId: 'client-1', explicitlyRequested: true }],
      ['agent_team_register_project', projectRegistration(), 'project.register', projectRegistration()],
      ['agent_team_list_projects', {}, 'project.list', undefined],
      ['agent_team_archive_project', { projectId: 'project-1' }, 'project.archive', { projectId: 'project-1' }],
      ['agent_team_list_project_skills', { projectId: 'project-1' }, 'project.skills', { projectId: 'project-1' }],
      ['agent_team_submit_execution_contract', { contract: executionContract(), runId: 'run-1' }, 'execution.submit', { contract: executionContract(), runId: 'run-1' }],
      ['agent_team_validate_execution_contract', { contract: executionContract() }, 'execution.validate', { contract: executionContract() }],
      ['agent_team_update_task_contract', { runId: 'run-1', contract: executionContract() }, 'execution.update_contract', { runId: 'run-1', contract: executionContract() }],
      ['agent_team_start_run', { runId: 'run-1' }, 'execution.start', { runId: 'run-1' }],
      ['agent_team_pause_run', { runId: 'run-1' }, 'execution.pause', { runId: 'run-1' }],
      ['agent_team_cancel_run', { runId: 'run-1' }, 'execution.cancel', { runId: 'run-1' }],
      ['agent_team_get_run', { runId: 'run-1' }, 'execution.get', { runId: 'run-1' }],
      ['agent_team_read_agent_log', { runId: 'run-1', agentId: 'agent-1', maxLines: 10, maxBytes: 1024 }, 'execution.agent_log', { runId: 'run-1', agentId: 'agent-1', maxLines: 10, maxBytes: 1024 }],
      ['agent_team_get_handoff', { runId: 'run-1' }, 'execution.handoff', { runId: 'run-1' }],
      ['agent_team_list_runs', { projectId: 'project-1' }, 'execution.list', { projectId: 'project-1' }],
      ['agent_team_read_run_events', { runId: 'run-1', clientId: 'client-1', afterEventId: 3, limit: 10 }, 'execution.events', { runId: 'run-1', clientId: 'client-1', afterEventId: 3, limit: 10 }]
    ];

    for (const [name, arguments_, method, params] of cases) {
      const result = await client.callTool({ name, arguments: arguments_ });
      const expected = { method, params: params ?? null };
      assert.equal(text(result), JSON.stringify(expected));
      assert.deepEqual(result.structuredContent, { result: expected });
      assert.equal(result.isError, undefined);
    }
    assert.deepEqual(calls, cases.map(([, , method, params]) => ({ method, params })));

    const listWithoutRun = await client.callTool({
      name: 'agent_team_list_interactions', arguments: {}
    });
    assert.equal(text(listWithoutRun), JSON.stringify({ method: 'interaction.list', params: null }));
    assert.deepEqual(calls.at(-1), { method: 'interaction.list', params: undefined });
    const listRunsWithoutProject = await client.callTool({
      name: 'agent_team_list_runs', arguments: {}
    });
    assert.equal(text(listRunsWithoutProject), JSON.stringify({ method: 'execution.list', params: null }));
    assert.deepEqual(calls.at(-1), { method: 'execution.list', params: undefined });
    const reconnectableForProject = await client.callTool({
      name: 'agent_team_list_reconnectable_runs', arguments: { projectId: 'project-1' }
    });
    assert.equal(text(reconnectableForProject), JSON.stringify({ method: 'controller.reconnectable', params: { projectId: 'project-1' } }));
    assert.deepEqual(calls.at(-1), { method: 'controller.reconnectable', params: { projectId: 'project-1' } });
    const listIncludingArchived = await client.callTool({
      name: 'agent_team_list_projects', arguments: { includeArchived: true }
    });
    assert.equal(text(listIncludingArchived), JSON.stringify({ method: 'project.list', params: { includeArchived: true } }));
    assert.deepEqual(calls.at(-1), { method: 'project.list', params: { includeArchived: true } });
  } finally {
    await closeConnectedServer(connected);
  }
});

test('MCP bridge returns IPC failures as tool errors', async () => {
  const connected = await createConnectedServer(async (method) => {
    if (method === 'health') throw new Error('daemon unavailable');
    if (method === 'project.register') throw new Error('project registration failed');
    if (method === 'execution.cancel') throw new Error('run cannot be cancelled');
    if (method === 'execution.events') throw new Error('event read rejected');
    if (method === 'execution.agent_log') throw new Error('agent log unavailable');
    throw 'daemon disconnected';
  });

  try {
    const result = await connected.client.callTool({
      name: 'agent_team_get_status', arguments: {}
    });
    assert.equal(result.isError, true);
    assert.equal(text(result), 'daemon unavailable');
    assert.equal(result.structuredContent, undefined);

    const nonError = await connected.client.callTool({
      name: 'agent_team_list_reconnectable_runs', arguments: {}
    });
    assert.equal(nonError.isError, true);
    assert.equal(text(nonError), 'daemon disconnected');

    const project = await connected.client.callTool({
      name: 'agent_team_register_project', arguments: projectRegistration()
    });
    assert.equal(project.isError, true);
    assert.equal(text(project), 'project registration failed');

    const cancelled = await connected.client.callTool({
      name: 'agent_team_cancel_run', arguments: { runId: 'run-1' }
    });
    assert.equal(cancelled.isError, true);
    assert.equal(text(cancelled), 'run cannot be cancelled');

    const events = await connected.client.callTool({
      name: 'agent_team_read_run_events', arguments: { runId: 'run-1', clientId: 'client-1' }
    });
    assert.equal(events.isError, true);
    assert.equal(text(events), 'event read rejected');

    const log = await connected.client.callTool({
      name: 'agent_team_read_agent_log', arguments: { runId: 'run-1', agentId: 'agent-1' }
    });
    assert.equal(log.isError, true);
    assert.equal(text(log), 'agent log unavailable');
  } finally {
    await closeConnectedServer(connected);
  }
});

test('MCP bridge serializes an undefined IPC result as JSON null', async () => {
  const connected = await createConnectedServer(async () => undefined);

  try {
    const result = await connected.client.callTool({
      name: 'agent_team_get_status', arguments: {}
    });
    assert.equal(text(result), 'null');
    assert.deepEqual(result.structuredContent, { result: null });
  } finally {
    await closeConnectedServer(connected);
  }
});

test('MCP bridge rejects unknown and invalid Zod tool input before IPC', async () => {
  const calls = [];
  const connected = await createConnectedServer(async (method, params) => {
    calls.push({ method, params });
    return {};
  });

  try {
    const unknown = await connected.client.callTool({
      name: 'agent_team_get_status', arguments: { unexpected: true }
    });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /unrecognized key/i);

    const invalid = await connected.client.callTool({
      name: 'agent_team_attach_controller',
      arguments: { runId: 'run-1', host: '', clientId: 'client-1', lastAckEventId: -1 }
    });
    assert.equal(invalid.isError, true);
    assert.match(text(invalid), /too small/i);

    const invalidProject = await connected.client.callTool({
      name: 'agent_team_register_project',
      arguments: { ...projectRegistration(), policy: { ...projectRegistration().policy, unexpected: true } }
    });
    assert.equal(invalidProject.isError, true);
    assert.match(text(invalidProject), /unrecognized key/i);

    const invalidContract = await connected.client.callTool({
      name: 'agent_team_submit_execution_contract',
      arguments: { runId: 'run-1' }
    });
    assert.equal(invalidContract.isError, true);
    assert.match(text(invalidContract), /invalid input at contract/i);

    const invalidCancel = await connected.client.callTool({
      name: 'agent_team_cancel_run', arguments: { runId: '', unexpected: true }
    });
    assert.equal(invalidCancel.isError, true);
    assert.match(text(invalidCancel), /too small|unrecognized key/i);

    const invalidEvents = await connected.client.callTool({
      name: 'agent_team_read_run_events',
      arguments: { runId: 'run-1', clientId: 'client-1', afterEventId: -1, limit: 1001, unexpected: true }
    });
    assert.equal(invalidEvents.isError, true);
    assert.match(text(invalidEvents), /too small|too big|unrecognized key/i);
    const invalidLog = await connected.client.callTool({
      name: 'agent_team_read_agent_log',
      arguments: { runId: 'run-1', agentId: '', maxLines: 201, maxBytes: 65_537, path: '/etc/passwd' }
    });
    assert.equal(invalidLog.isError, true);
    assert.match(text(invalidLog), /too small|too big|unrecognized key/i);
    const implicitResume = await connected.client.callTool({
      name: 'agent_team_resume_external_thread',
      arguments: { runId: 'run-1', clientId: 'client-1', explicitlyRequested: false }
    });
    assert.equal(implicitResume.isError, true);
    assert.match(text(implicitResume), /invalid input/i);
    assert.deepEqual(calls, []);
  } finally {
    await closeConnectedServer(connected);
  }
});

test('runMcpServer starts stdio while its daemon is unavailable', async () => {
  await runMcpServer({
    root: '/tmp/agent-team-missing',
    stateDb: '/tmp/agent-team-missing/state.sqlite',
    daemonLock: '/tmp/agent-team-missing/daemon.lock',
    daemonInfo: '/tmp/agent-team-missing/daemon.json',
    socket: `/tmp/agent-team-missing-${process.pid}-${Date.now()}.sock`,
    runsDir: '/tmp/agent-team-missing/runs',
    worktreesDir: '/tmp/agent-team-missing/worktrees',
    preflightDir: '/tmp/agent-team-missing/preflight'
  });
});

test('MCP gateway sends standard logging notifications from durable run events', async () => {
  const messages = [];
  const events = [
    { id: 4, runId: 'run-1', eventType: 'RUN_STARTED', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 5, runId: 'run-1', eventType: 'RUN_HANDOFF_CREATED', createdAt: '2026-01-01T00:00:01.000Z' }
  ];
  const connected = await createConnectedServer(async (method, params) => {
    if (method !== 'execution.events_since') throw new Error(`unexpected IPC method: ${method}`);
    const afterEventId = params.afterEventId;
    const pending = events.filter((event) => event.id > afterEventId);
    return { events: pending, lastEventId: pending.at(-1)?.id ?? afterEventId };
  }, { pollIntervalMs: 5 }, {}, (client) => {
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      messages.push(notification.params.data);
    });
  });

  try {
    await waitFor(() => messages.length === 2);
    assert.deepEqual(messages, [
      {
        type: 'run.status', runId: 'run-1', status: 'running', eventId: 4,
        eventType: 'RUN_STARTED', createdAt: '2026-01-01T00:00:00.000Z'
      },
      { type: 'run.completed', handoff: { runId: 'run-1', available: true } }
    ]);
  } finally {
    await closeConnectedServer(connected);
  }
});

test('MCP gateway elicits approvals and agent questions, but leaves contract blocks queued', async () => {
  const calls = [];
  const approval = {
    id: 'approval-1', status: 'queued', kind: 'approval',
    request: { tool: 'npm', description: 'Run npm test', allowSession: true }
  };
  const question = {
    id: 'question-1', status: 'queued', kind: 'agent_question',
    request: { backend: 'codex', questions: [{ id: 'choice', question: 'Continue?', options: [{ label: 'yes' }, { label: 'no' }] }] }
  };
  const contractBlock = {
    id: 'contract-1', status: 'queued', kind: 'contract_block', request: { reason: 'Needs scope revision' }
  };
  const answered = new Set();
  const elicitationRequests = [];
  const connected = await createConnectedServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'execution.events_since') return { events: [], lastEventId: params.afterEventId };
    if (method === 'controller.attach') return {};
    if (method === 'interaction.list') {
      return [approval, question, contractBlock].filter((item) => !answered.has(item.id));
    }
    if (method === 'interaction.claim') return { ...[approval, question, contractBlock].find((item) => item.id === params.id), status: 'claimed' };
    if (method === 'interaction.answer') {
      answered.add(params.id);
      return { id: params.id, status: 'answered' };
    }
    if (method === 'interaction.requeue_client') return 0;
    throw new Error(`unexpected IPC method: ${method}`);
  }, { pollIntervalMs: 5 }, { capabilities: { elicitation: { form: {} } } }, (client) => {
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      elicitationRequests.push(request.params);
      return request.params.requestedSchema.properties.decision
        ? { action: 'accept', content: { decision: 'session' } }
        : { action: 'accept', content: { answer_1: 'yes' } };
    });
  });

  try {
    await connected.client.callTool({
      name: 'agent_team_attach_controller',
      arguments: { runId: 'run-1', host: 'test', clientId: 'mcp-client' }
    });
    await waitFor(() => answered.size === 2);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(elicitationRequests.length, 2);
    assert.deepEqual(calls.filter((call) => call.method === 'interaction.answer').map((call) => call.params.response), [
      'session', { choice: ['yes'] }
    ]);
    assert.equal(calls.some((call) => call.method === 'interaction.claim' && call.params.id === 'contract-1'), false);
  } finally {
    await closeConnectedServer(connected);
  }
});

test('MCP gateway requeues an interaction when elicitation is cancelled', async () => {
  const calls = [];
  const queued = { id: 'approval-1', status: 'queued', kind: 'approval', request: { tool: 'npm', allowSession: false } };
  const connected = await createConnectedServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'execution.events_since') return { events: [], lastEventId: params.afterEventId };
    if (method === 'controller.attach' || method === 'interaction.claim') return {};
    if (method === 'interaction.list') return [queued];
    if (method === 'interaction.requeue_client') throw new Error('requeue unavailable');
    throw new Error(`unexpected IPC method: ${method}`);
  }, { pollIntervalMs: 5 }, { capabilities: { elicitation: { form: {} } } }, (client) => {
    client.setRequestHandler(ElicitRequestSchema, () => ({ action: 'cancel' }));
  });

  try {
    await connected.client.callTool({
      name: 'agent_team_attach_controller',
      arguments: { runId: 'run-1', host: 'test', clientId: 'mcp-client' }
    });
    await waitFor(() => calls.some((call) => call.method === 'interaction.requeue_client'));
    assert.equal(calls.filter((call) => call.method === 'interaction.claim').length, 1);
  } finally {
    await closeConnectedServer(connected);
  }
});

test('MCP gateway handles declined approvals and invalid question answers without stranding interactions', async () => {
  const calls = [];
  const queued = [
    { id: 'approval-1', status: 'queued', kind: 'approval', request: {} },
    { id: 'question-1', status: 'queued', kind: 'agent_question', request: { questions: [{ id: 'choice', multiple: true, options: [{ label: 'yes' }] }] } }
  ];
  const claimed = new Set();
  const connected = await createConnectedServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'execution.events_since') return { events: [], lastEventId: params.afterEventId };
    if (method === 'controller.attach') return {};
    if (method === 'interaction.list') return queued.filter((item) => !claimed.has(item.id));
    if (method === 'interaction.claim') return {};
    if (method === 'interaction.answer') {
      claimed.add(params.id);
      return {};
    }
    if (method === 'interaction.requeue_client') return 1;
    throw new Error(`unexpected IPC method: ${method}`);
  }, { pollIntervalMs: 5 }, { capabilities: { elicitation: { form: {} } } }, (client) => {
    let requests = 0;
    client.setRequestHandler(ElicitRequestSchema, () => {
      requests += 1;
      return requests === 1 ? { action: 'decline' } : { action: 'accept', content: { answer_1: 'no' } };
    });
  });

  try {
    await connected.client.callTool({
      name: 'agent_team_attach_controller', arguments: { runId: 'run-1', host: 'test', clientId: 'mcp-client' }
    });
    await waitFor(() => calls.some((call) => call.method === 'interaction.requeue_client'));
    assert.deepEqual(calls.filter((call) => call.method === 'interaction.answer').map((call) => call.params.response), ['deny']);
  } finally {
    await closeConnectedServer(connected);
  }
});

test('MCP bridge keeps attachment state unchanged when attach or disconnect fails', async () => {
  const connected = await createConnectedServer(async (method) => {
    if (method === 'controller.attach' || method === 'controller.disconnect') throw new Error('controller unavailable');
    throw new Error(`unexpected IPC method: ${method}`);
  });

  try {
    for (const [name, arguments_] of [
      ['agent_team_attach_controller', { runId: 'run-1', host: 'test', clientId: 'client-1' }],
      ['agent_team_disconnect_controller', { runId: 'run-1', clientId: 'client-1' }]
    ]) {
      const result = await connected.client.callTool({
        name,
        arguments: arguments_
      });
      assert.equal(result.isError, true);
      assert.equal(text(result), 'controller unavailable');
    }
  } finally {
    await closeConnectedServer(connected);
  }
});

test('MCP server validates gateway poll intervals and accepts the default options object', () => {
  const server = createMcpServer({ request: async () => ({}) });
  assert.ok(server);
  const invalid = createMcpServer({ request: async () => ({}) }, { pollIntervalMs: 0 });
  assert.throws(() => invalid.server.oninitialized(), /pollIntervalMs/);
});

test('MCP gateway rejects malformed durable data and retries invalid elicitation outcomes', async () => {
  const callbacks = [];
  const calls = [];
  const events = [
    null,
    { id: -1, runId: 'invalid', eventType: 'RUN_STARTED', createdAt: 'now' },
    { id: 1, runId: 'run-1', eventType: 'RUN_PAUSED', createdAt: 'now' },
    { id: 2, runId: 'run-1', eventType: 'RUN_CANCELLED', createdAt: 'now' },
    { id: 3, runId: 'run-1', eventType: 'RUN_FAILED', createdAt: 'now' },
    { id: 4, runId: 'run-1', eventType: 'RUN_DAEMON_FAILED', createdAt: 'now' }
  ];
  const connected = await createConnectedServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'execution.events_since') return { events, lastEventId: 4 };
    if (method === 'controller.attach' || method === 'controller.disconnect' || method === 'interaction.claim') return {};
    if (method === 'interaction.list') return [
      null,
      { id: 'approval-1', status: 'queued', kind: 'approval', request: {} },
      { id: 'question-1', status: 'queued', kind: 'agent_question', request: {} }
    ];
    if (method === 'interaction.requeue_client') return 1;
    throw new Error(`unexpected IPC method: ${method}`);
  }, {
    pollIntervalMs: 1,
    setInterval(callback) {
      callbacks.push(callback);
      return { unref() {} };
    },
    clearInterval() {}
  }, { capabilities: { elicitation: { form: {} } } }, (client) => {
    client.setRequestHandler(ElicitRequestSchema, () => ({ action: 'accept', content: { decision: 'invalid' } }));
  });

  try {
    await connected.client.callTool({
      name: 'agent_team_attach_controller', arguments: { runId: 'run-1', host: 'test', clientId: 'client-1' }
    });
    await waitFor(() => calls.some((call) => call.method === 'interaction.requeue_client'));
    connected.server.server.oninitialized();
    await connected.client.callTool({
      name: 'agent_team_disconnect_controller', arguments: { runId: 'run-1', clientId: 'other-client' }
    });
    callbacks[0]();
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(calls.filter((call) => call.method === 'interaction.claim').length >= 1, true);
  } finally {
    await closeConnectedServer(connected);
  }
});

test('MCP gateway rejects malformed question forms and answers', async () => {
  const calls = [];
  const interactions = [
    { id: 'secret', status: 'queued', kind: 'agent_question', request: { questions: [{ id: 'x', secret: true }] } },
    { id: 'freeform', status: 'queued', kind: 'agent_question', request: { questions: [{ id: 'x', options: 'invalid' }] } }
  ];
  const connected = await createConnectedServer(async (method, params) => {
    calls.push({ method, params });
    if (method === 'execution.events_since') return { events: {}, lastEventId: 0 };
    if (method === 'controller.attach' || method === 'interaction.claim') return {};
    if (method === 'interaction.list') return interactions;
    if (method === 'interaction.requeue_client') return 1;
    throw new Error(`unexpected IPC method: ${method}`);
  }, { pollIntervalMs: 5 }, { capabilities: { elicitation: { form: {} } } }, (client) => {
    client.setRequestHandler(ElicitRequestSchema, () => ({ action: 'decline' }));
  });

  try {
    await connected.client.callTool({
      name: 'agent_team_attach_controller', arguments: { runId: 'run-1', host: 'test', clientId: 'client-1' }
    });
    await waitFor(() => calls.filter((call) => call.method === 'interaction.requeue_client').length > 0);
    assert.equal(calls.some((call) => call.method === 'interaction.claim' && call.params.id === 'secret'), true);
  } finally {
    await closeConnectedServer(connected);
  }
});

test('MCP gateway closes cleanly before polling starts', async () => {
  const server = createMcpServer({ request: async () => ({}) });
  await server.server.onclose();
});
