import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const clients = [];
const servers = [];

vi.mock('../src/daemon/ipc.ts', () => ({
  LocalIpcClient: class {
    constructor(socket) {
      this.socket = socket;
      clients.push(this);
    }

    async connect() { this.connected = true; }
    close() { this.closed = true; }
  }
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    constructor() {
      this.server = {};
      servers.push(this);
    }

    registerTool() {}
    async connect(transport) { this.transport = transport; }
  }
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {}
}));

const { runMcpServer } = await import('../src/mcp/server.ts');

test('runMcpServer connects an already connected IPC client to stdio', async () => {
  await runMcpServer({
    root: '/agent-team', stateDb: '/agent-team/state.sqlite', daemonLock: '/agent-team/daemon.lock',
    daemonInfo: '/agent-team/daemon.json', socket: '/agent-team/daemon.sock', runsDir: '/agent-team/runs',
    worktreesDir: '/agent-team/worktrees', preflightDir: '/agent-team/preflight'
  });

  assert.equal(clients.at(-1).connected, true);
  assert.equal(clients.at(-1).closed, undefined);
  assert.ok(servers.at(-1).transport);
});
