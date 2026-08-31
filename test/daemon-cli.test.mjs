import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';
import { resolveAgentTeamHome } from '../src/core/home.ts';
import { formatDaemonCliError, isDaemonCliMain, runDaemonCli } from '../src/daemon-cli.ts';

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

test('daemon CLI starts with the default home and stops after a signal', async () => {
  const calls = [];
  const signals = new Map();
  await withExitCode(async () => {
    await runDaemonCli([], {
      resolveHome: () => home,
      createDaemon: (resolvedHome) => ({
        start: async () => calls.push(['start', resolvedHome]),
        stop: async () => calls.push(['stop'])
      }),
      registerSignal: (signal, listener) => signals.set(signal, listener)
    });
    assert.equal(process.exitCode, undefined);
  });
  assert.deepEqual(calls, [['start', home]]);
  assert.deepEqual([...signals.keys()], ['SIGINT', 'SIGTERM']);
  await signals.get('SIGINT')();
  assert.deepEqual(calls, [['start', home], ['stop']]);
});

test('daemon CLI default daemon and signal registration stop without hanging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-daemon-cli-'));
  const resolvedHome = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: root } });
  let sigint;
  let sigterm;
  try {
    await runDaemonCli([], { resolveHome: () => resolvedHome });
    sigint = process.rawListeners('SIGINT').at(-1);
    sigterm = process.rawListeners('SIGTERM').at(-1);
    await sigint.listener();
  } finally {
    if (sigint) process.off('SIGINT', sigint);
    if (sigterm) process.off('SIGTERM', sigterm);
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon CLI passes --home through AGENT_TEAM_HOME', async () => {
  let options;
  let daemonHome;
  await withExitCode(async () => {
    await runDaemonCli(['--home', '/custom/home'], {
      resolveHome: (value) => {
        options = value;
        return home;
      },
      createDaemon: (value) => {
        daemonHome = value;
        return { start: async () => {}, stop: async () => {} };
      },
      registerSignal: () => {}
    });
  });
  assert.equal(options.env.AGENT_TEAM_HOME, '/custom/home');
  assert.equal(daemonHome, home);
});

test('daemon CLI rejects invalid arguments without starting the daemon', async () => {
  for (const [args, expectedError] of [
    [['--unknown'], /Unknown daemon option/],
    [['--home'], /--home requires a value/],
    [['--home', '--unknown'], /--home requires a value/],
    [['--home', '/custom/home', '--unknown'], /Unknown daemon option/]
  ]) {
    const errors = [];
    let daemonCreated = false;
    await withExitCode(async () => {
      await runDaemonCli(args, {
        createDaemon: () => {
          daemonCreated = true;
          return { start: async () => {}, stop: async () => {} };
        },
        printError: (message) => errors.push(message)
      });
      assert.equal(process.exitCode, 1);
    });
    assert.equal(daemonCreated, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], expectedError);
  }
});

test('daemon CLI formats startup and stop errors and marks the process unsuccessful', async () => {
  const errors = [];
  await withExitCode(async () => {
    await runDaemonCli([], {
      resolveHome: () => home,
      createDaemon: () => ({
        start: async () => { throw new Error('daemon unavailable'); },
        stop: async () => {}
      }),
      printError: (message) => errors.push(message)
    });
    assert.equal(process.exitCode, 1);
  });
  assert.match(errors[0], /daemon unavailable/);

  const signals = new Map();
  await withExitCode(async () => {
    await runDaemonCli([], {
      resolveHome: () => home,
      createDaemon: () => ({
        start: async () => {},
        stop: async () => { throw 'stop failed'; }
      }),
      registerSignal: (signal, listener) => signals.set(signal, listener),
      printError: (message) => errors.push(message)
    });
    await signals.get('SIGTERM')();
    assert.equal(process.exitCode, 1);
  });
  assert.equal(errors.at(-1), 'stop failed');
});

test('daemon CLI formats Error and non-Error failures', () => {
  const withoutStack = new Error('message only');
  withoutStack.stack = undefined;
  assert.equal(formatDaemonCliError(withoutStack), 'message only');
  assert.equal(formatDaemonCliError('string failure'), 'string failure');
});

test('daemon CLI main detection only matches its own entry path', () => {
  const daemonCliUrl = new URL('../src/daemon-cli.ts', import.meta.url).href;
  const daemonCliPath = fileURLToPath(daemonCliUrl);
  assert.equal(isDaemonCliMain([], daemonCliUrl), false);
  assert.equal(isDaemonCliMain([process.execPath, daemonCliPath], daemonCliUrl), true);
  assert.equal(isDaemonCliMain([process.execPath, '/tmp/other-cli.ts'], daemonCliUrl), false);
});

test('daemon CLI main entry handles invalid arguments without starting the daemon', async () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const daemonCliPath = fileURLToPath(new URL('../src/daemon-cli.ts', import.meta.url));
  try {
    process.argv = [process.execPath, daemonCliPath, '--unknown'];
    await import('../src/daemon-cli.ts?main');
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(String(error.mock.calls.at(-1)?.[0]), /Unknown daemon option/);
    assert.equal(process.exitCode, 1);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    error.mockRestore();
  }
});
