import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const clients = [];
const servers = [];
let daemonAvailable = true;
let connectBarrier;
let connectStarted;
let requestError;
let stdioConnectError;

vi.mock('../src/daemon/ipc.ts', () => ({
  LocalIpcClient: class {
    constructor(socket) {
      this.socket = socket;
      clients.push(this);
    }

    async connect() {
      connectStarted?.();
      if (!daemonAvailable) throw new Error('IPC connection error: connect ENOENT');
      await connectBarrier;
      this.connected = true;
    }
    async request() {
      if (requestError) throw requestError;
      return { status: 'ok' };
    }
    close() { this.closed = true; }
  }
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    constructor() {
      this.server = {};
      servers.push(this);
    }

    registerTool(name, _schema, handler) {
      this.tools ??= new Map();
      this.tools.set(name, handler);
    }
    async connect(transport) {
      this.transport = transport;
      if (stdioConnectError) throw stdioConnectError;
    }
  }
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {}
}));

const { runMcpServer } = await import('../src/mcp/server.ts');

function home() {
  return {
    root: '/agent-team', stateDb: '/agent-team/state.sqlite', daemonLock: '/agent-team/daemon.lock',
    daemonInfo: '/agent-team/daemon.json', socket: '/agent-team/daemon.sock', runsDir: '/agent-team/runs',
    worktreesDir: '/agent-team/worktrees', preflightDir: '/agent-team/preflight'
  };
}

beforeEach(() => {
  clients.length = 0;
  servers.length = 0;
  daemonAvailable = true;
  connectBarrier = undefined;
  connectStarted = undefined;
  requestError = undefined;
  stdioConnectError = undefined;
});

test('runMcpServer connects stdio before attempting daemon IPC', async () => {
  await runMcpServer(home());

  assert.equal(clients.length, 0);
  assert.ok(servers.at(-1).transport);
});

test('MCP tool reports a missing daemon and reconnects after it returns', async () => {
  daemonAvailable = false;
  await runMcpServer(home());

  const getStatus = servers.at(-1).tools.get('agent_team_get_status');
  const unavailable = await getStatus({});
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.content[0].text, /connect ENOENT/);
  assert.equal(clients.at(-1).closed, true);

  daemonAvailable = true;
  const recovered = await getStatus({});
  assert.deepEqual(recovered.structuredContent, { result: { status: 'ok' } });
  assert.equal(clients.at(-1).connected, true);
});

test('runMcpServer cleans up its requester when stdio connection fails', async () => {
  stdioConnectError = new Error('stdio unavailable');

  await assert.rejects(runMcpServer(home()), /stdio unavailable/);
  assert.equal(clients.length, 0);
  assert.ok(servers.at(-1).transport);
});

test('MCP reconnecting requester reuses a healthy client and replaces one whose request fails', async () => {
  await runMcpServer(home());
  const getStatus = servers.at(-1).tools.get('agent_team_get_status');

  await getStatus({});
  await getStatus({});
  assert.equal(clients.length, 1);

  requestError = new Error('daemon disconnected');
  const failed = await getStatus({});
  assert.equal(failed.isError, true);
  assert.equal(clients[0].closed, true);

  requestError = undefined;
  await getStatus({});
  assert.equal(clients.length, 2);
  assert.equal(clients[1].connected, true);
});

test('MCP reconnecting requester shares an in-flight daemon connection', async () => {
  let releaseConnect;
  const connectionStarted = new Promise((resolve) => { connectStarted = resolve; });
  connectBarrier = new Promise((resolve) => { releaseConnect = resolve; });
  await runMcpServer(home());
  const getStatus = servers.at(-1).tools.get('agent_team_get_status');

  const statuses = Promise.all([getStatus({}), getStatus({})]);
  await connectionStarted;
  assert.equal(clients.length, 1);

  releaseConnect();
  const results = await statuses;
  assert.deepEqual(results.map((result) => result.structuredContent), [
    { result: { status: 'ok' } },
    { result: { status: 'ok' } }
  ]);
  assert.equal(clients.length, 1);
});
