import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { test } from 'vitest';
import { createMcpServer, runMcpServer } from '../src/mcp/server.ts';

async function createConnectedServer(request) {
  const server = createMcpServer({ request });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
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
    assert.deepEqual(calls, []);
  } finally {
    await closeConnectedServer(connected);
  }
});

test('runMcpServer closes its IPC client when daemon connection fails', async () => {
  await assert.rejects(runMcpServer({
    root: '/tmp/agent-team-missing',
    stateDb: '/tmp/agent-team-missing/state.sqlite',
    daemonLock: '/tmp/agent-team-missing/daemon.lock',
    daemonInfo: '/tmp/agent-team-missing/daemon.json',
    socket: `/tmp/agent-team-missing-${process.pid}-${Date.now()}.sock`,
    runsDir: '/tmp/agent-team-missing/runs',
    worktreesDir: '/tmp/agent-team-missing/worktrees',
    preflightDir: '/tmp/agent-team-missing/preflight'
  }), /IPC connection error/);
});
