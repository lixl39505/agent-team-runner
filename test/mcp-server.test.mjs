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
      'agent_team_attach_controller',
      'agent_team_claim_interaction',
      'agent_team_disconnect_controller',
      'agent_team_get_status',
      'agent_team_list_interactions',
      'agent_team_list_reconnectable_runs',
      'agent_team_requeue_interactions'
    ]);
    assert.equal(tools.tools.some((tool) => tool.name.includes('shutdown')), false);

    const cases = [
      ['agent_team_get_status', {}, 'health', undefined],
      ['agent_team_list_interactions', { runId: 'run-1' }, 'interaction.list', { runId: 'run-1' }],
      ['agent_team_claim_interaction', { id: 'interaction-1', clientId: 'client-1' }, 'interaction.claim', { id: 'interaction-1', clientId: 'client-1' }],
      ['agent_team_answer_interaction', { id: 'interaction-1', clientId: 'client-1', response: { approved: true } }, 'interaction.answer', { id: 'interaction-1', clientId: 'client-1', response: { approved: true } }],
      ['agent_team_requeue_interactions', { clientId: 'client-1' }, 'interaction.requeue_client', { clientId: 'client-1' }],
      ['agent_team_attach_controller', { runId: 'run-1', host: 'host-1', externalThreadId: 'thread-1', clientId: 'client-1', lastAckEventId: 3 }, 'controller.attach', { runId: 'run-1', host: 'host-1', externalThreadId: 'thread-1', clientId: 'client-1', lastAckEventId: 3 }],
      ['agent_team_disconnect_controller', { runId: 'run-1', clientId: 'client-1' }, 'controller.disconnect', { runId: 'run-1', clientId: 'client-1' }],
      ['agent_team_list_reconnectable_runs', {}, 'controller.reconnectable', undefined]
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
  } finally {
    await closeConnectedServer(connected);
  }
});

test('MCP bridge returns IPC failures as tool errors', async () => {
  const connected = await createConnectedServer(async (method) => {
    if (method === 'health') throw new Error('daemon unavailable');
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
