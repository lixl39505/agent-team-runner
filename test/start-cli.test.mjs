import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runStartCli, startArguments } from '../src/start-cli.ts';

const home = {
  root: '/agent-team',
  stateDb: '/agent-team/state.sqlite',
  daemonLock: '/agent-team/daemon.lock',
  daemonInfo: '/agent-team/daemon.json',
  socket: '/agent-team/daemon.sock',
  runsDir: '/agent-team/runs',
  worktreesDir: '/agent-team/worktrees',
  preflightDir: '/agent-team/preflight'
};

test('start connects an existing daemon and opens the Inbox without spawning or stopping it', async () => {
  const calls = [];
  await runStartCli([], {
    resolveHome: () => home,
    createClient: () => ({
      connect: async () => calls.push('connect'),
      close: () => calls.push('close')
    }),
    spawnDaemon: () => {
      calls.push('spawn');
      return { unref: () => calls.push('unref') };
    },
    runAttach: async (args) => calls.push(['attach', args])
  });
  assert.deepEqual(calls, ['connect', 'close', ['attach', ['--home', '/agent-team']]]);
});

test('start launches one detached daemon, waits for IPC, then opens the Inbox', async () => {
  const calls = [];
  let connections = 0;
  await runStartCli(['--home', '/custom'], {
    resolveHome: (options) => {
      calls.push(['home', options]);
      return home;
    },
    createClient: () => ({
      connect: async () => {
        connections += 1;
        if (connections === 1) throw new Error('not ready');
        calls.push('connected');
      },
      close: () => calls.push('close')
    }),
    spawnDaemon: (value) => {
      calls.push(['spawn', value]);
      return { unref: () => calls.push('unref') };
    },
    sleep: async () => calls.push('sleep'),
    runAttach: async (args) => calls.push(['attach', args])
  });
  assert.equal(calls.filter((entry) => entry === 'spawn').length, 0);
  assert.deepEqual(calls.at(0)[1].env.AGENT_TEAM_HOME, '/custom');
  assert.equal(calls.some((entry) => Array.isArray(entry) && entry[0] === 'spawn'), true);
  assert.equal(calls.includes('unref'), true);
  assert.deepEqual(calls.at(-1), ['attach', ['--home', '/agent-team']]);
});

test('start validates its options before opening a client or child process', () => {
  assert.equal(startArguments([], () => home), home);
  assert.throws(() => startArguments(['--unknown'], () => home), /Unknown start option/);
  assert.throws(() => startArguments(['--home'], () => home), /--home requires a value/);
  assert.throws(() => startArguments(['--home', '--another-option'], () => home), /--home requires a value/);
  assert.throws(() => startArguments(['--home', '/home', '--extra'], () => home), /Unknown start option/);
});

test('start rejects an invalid startup retry count before it probes or launches', async () => {
  await assert.rejects(runStartCli([], {
    resolveHome: () => home,
    startupAttempts: 0,
    createClient: () => { throw new Error('must not create IPC client'); }
  }), /startupAttempts/);
  await assert.rejects(runStartCli([], {
    resolveHome: () => home,
    startupAttempts: 1.5,
    createClient: () => { throw new Error('must not create IPC client'); }
  }), /startupAttempts/);
});
