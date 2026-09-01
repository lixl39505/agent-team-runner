import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const spawn = vi.fn(() => ({ unref: vi.fn() }));
const attach = vi.fn();
let unavailable = false;

vi.mock('node:child_process', () => ({ spawn }));
vi.mock('../src/daemon/ipc.ts', () => ({
  LocalIpcClient: class {
    async connect() {
      if (unavailable) throw new Error('unavailable');
    }
    close() {}
  }
}));
vi.mock('../src/attach-cli.ts', () => ({ runAttachCli: attach }));
vi.mock('../src/core/home.ts', () => ({
  resolveAgentTeamHome: () => ({
    root: '/agent-team', stateDb: '/agent-team/state.sqlite', daemonLock: '/agent-team/daemon.lock',
    daemonInfo: '/agent-team/daemon.json', socket: '/agent-team/daemon.sock', runsDir: '/agent-team/runs',
    worktreesDir: '/agent-team/worktrees', preflightDir: '/agent-team/preflight'
  })
}));

const { runStartCli } = await import('../src/start-cli.ts');

test('start uses the default detached daemon spawner after its first IPC probe fails', async () => {
  let probes = 0;
  const attached = [];
  await runStartCli([], {
    resolveHome: () => ({
      root: '/agent-team', stateDb: '/agent-team/state.sqlite', daemonLock: '/agent-team/daemon.lock',
      daemonInfo: '/agent-team/daemon.json', socket: '/agent-team/daemon.sock', runsDir: '/agent-team/runs',
      worktreesDir: '/agent-team/worktrees', preflightDir: '/agent-team/preflight'
    }),
    createClient: () => ({
      async connect() {
        probes += 1;
        if (probes === 1) throw new Error('not ready');
      },
      close() {}
    }),
    sleep: async () => {},
    runAttach: async (args) => { attached.push(args); }
  });

  assert.equal(spawn.mock.calls.length, 1);
  assert.deepEqual(attached, [['--home', '/agent-team']]);
});

test('start accepts default arguments and dependencies for an already available daemon', async () => {
  attach.mockClear();
  await runStartCli();
  assert.deepEqual(attach.mock.calls, [[['--home', '/agent-team']]]);
});

test('start uses its default retry sleep when the default IPC client is unavailable', async () => {
  unavailable = true;
  try {
    await assert.rejects(runStartCli([], { startupAttempts: 1 }), /Daemon did not become available/);
  } finally {
    unavailable = false;
  }
});
