import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';
import { formatMcpCliError, isMcpCliMain, runMcpCli } from '../src/mcp-cli.ts';

const home = {
  root: '/tmp/agent-team',
  stateDb: '/tmp/agent-team/state.sqlite',
  daemonLock: '/tmp/agent-team/daemon.lock',
  daemonInfo: '/tmp/agent-team/daemon.json',
  socket: '/tmp/agent-team/daemon.sock',
  runsDir: '/tmp/agent-team/runs',
  worktreesDir: '/tmp/agent-team/worktrees',
  preflightDir: '/tmp/agent-team/preflight'
};

async function withExitCode(run) {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await run();
  } finally {
    process.exitCode = originalExitCode;
  }
}

test('MCP CLI starts the server with the default home when given no arguments', async () => {
  const calls = [];
  await withExitCode(async () => {
    await runMcpCli([], {
      resolveHome: () => {
        calls.push('resolve');
        return home;
      },
      runServer: async (resolvedHome) => {
        calls.push(resolvedHome);
      },
      printError: (message) => calls.push(message)
    });
    assert.equal(process.exitCode, undefined);
  });
  assert.deepEqual(calls, ['resolve', home]);
});

test('MCP CLI passes --home through AGENT_TEAM_HOME', async () => {
  let options;
  let serverHome;
  await withExitCode(async () => {
    await runMcpCli(['--home', '/custom/home'], {
      resolveHome: (value) => {
        options = value;
        return home;
      },
      runServer: async (value) => {
        serverHome = value;
      }
    });
  });
  assert.equal(options.env.AGENT_TEAM_HOME, '/custom/home');
  assert.equal(serverHome, home);
});

test('MCP CLI rejects unknown arguments and a missing --home value', async () => {
  for (const [args, expectedError] of [
    [['--unknown'], /Unknown MCP option/],
    [['--home'], /--home requires a value/],
    [['--home', '--unknown'], /--home requires a value/],
    [['--home', '/custom/home', '--unknown'], /Unknown MCP option/]
  ]) {
    const errors = [];
    let serverStarted = false;
    await withExitCode(async () => {
      await runMcpCli(args, {
        resolveHome: () => home,
        runServer: async () => {
          serverStarted = true;
        },
        printError: (message) => errors.push(message)
      });
      assert.equal(process.exitCode, 1);
    });
    assert.equal(serverStarted, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], expectedError);
  }
});

test('MCP CLI formats server errors and marks the process unsuccessful', async () => {
  const errors = [];
  await withExitCode(async () => {
    await runMcpCli([], {
      resolveHome: () => home,
      runServer: async () => {
        throw new Error('daemon unavailable');
      },
      printError: (message) => errors.push(message)
    });
    assert.equal(process.exitCode, 1);
  });
  assert.match(errors[0], /daemon unavailable/);
});

test('MCP CLI formats Error and non-Error failures', () => {
  const withoutStack = new Error('message only');
  withoutStack.stack = undefined;
  assert.equal(formatMcpCliError(withoutStack), 'message only');
  assert.equal(formatMcpCliError('string failure'), 'string failure');
});

test('MCP CLI main detection only matches its own entry path', () => {
  const mcpCliUrl = new URL('../src/mcp-cli.ts', import.meta.url).href;
  const mcpCliPath = fileURLToPath(mcpCliUrl);
  assert.equal(isMcpCliMain([], mcpCliUrl), false);
  assert.equal(isMcpCliMain([process.execPath, mcpCliPath], mcpCliUrl), true);
  assert.equal(isMcpCliMain([process.execPath, '/tmp/other-cli.ts'], mcpCliUrl), false);
});

test('MCP CLI main entry handles invalid arguments without starting the server', async () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const mcpCliPath = fileURLToPath(new URL('../src/mcp-cli.ts', import.meta.url));
  try {
    process.argv = [process.execPath, mcpCliPath, '--unknown'];
    await import('../src/mcp-cli.ts?main');
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(String(error.mock.calls.at(-1)?.[0]), /Unknown MCP option/);
    assert.equal(process.exitCode, 1);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    error.mockRestore();
  }
});
