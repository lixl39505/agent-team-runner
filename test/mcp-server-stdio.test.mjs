import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const clients = [];
const servers = [];
let daemonAvailable = true;

vi.mock('../src/daemon/ipc.ts', () => ({
  LocalIpcClient: class {
    constructor(socket) {
      this.socket = socket;
      clients.push(this);
    }

    async connect() {
      if (!daemonAvailable) throw new Error('IPC connection error: connect ENOENT');
      this.connected = true;
    }
    async request() { return { status: 'ok' }; }
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
    async connect(transport) { this.transport = transport; }
  }
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {}
}));

const { runMcpServer } = await import('../src/mcp/server.ts');

test('runMcpServer connects stdio before attempting daemon IPC', async () => {
  await runMcpServer({
    root: '/agent-team', stateDb: '/agent-team/state.sqlite', daemonLock: '/agent-team/daemon.lock',
    daemonInfo: '/agent-team/daemon.json', socket: '/agent-team/daemon.sock', runsDir: '/agent-team/runs',
    worktreesDir: '/agent-team/worktrees', preflightDir: '/agent-team/preflight'
  });

  assert.equal(clients.length, 0);
  assert.ok(servers.at(-1).transport);
});

test('MCP tool reports a missing daemon and reconnects after it returns', async () => {
  daemonAvailable = false;
  await runMcpServer({
    root: '/agent-team', stateDb: '/agent-team/state.sqlite', daemonLock: '/agent-team/daemon.lock',
    daemonInfo: '/agent-team/daemon.json', socket: '/agent-team/daemon.sock', runsDir: '/agent-team/runs',
    worktreesDir: '/agent-team/worktrees', preflightDir: '/agent-team/preflight'
  });

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
