import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { ensureAgentTeamHome, resolveAgentTeamHome } from '../src/core/home.ts';

test('resolveAgentTeamHome prefers AGENT_TEAM_HOME and exposes all global paths', () => {
  const root = join(tmpdir(), 'agent-team-custom-home');
  const home = resolveAgentTeamHome({
    env: { AGENT_TEAM_HOME: root },
    homeDir: join(tmpdir(), 'ignored-home'),
    platform: 'linux'
  });

  assert.deepEqual(home, {
    root,
    stateDb: join(root, 'state.sqlite'),
    daemonLock: join(root, 'daemon.lock'),
    daemonInfo: join(root, 'daemon.json'),
    socket: join(root, 'daemon.sock'),
    runsDir: join(root, 'runs'),
    worktreesDir: join(root, 'worktrees'),
    preflightDir: join(root, 'preflight')
  });
});

test('resolveAgentTeamHome falls back to the user home and uses a Windows named pipe', () => {
  const userHome = join(tmpdir(), 'agent-team-user-home');
  const home = resolveAgentTeamHome({
    env: { AGENT_TEAM_HOME: '' },
    homeDir: userHome,
    platform: 'win32'
  });

  assert.equal(home.root, join(userHome, '.agent-team'));
  assert.equal(home.socket, '\\\\.\\pipe\\agent-team');
});

test('ensureAgentTeamHome creates persistent directories but never creates a socket', () => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-team-home-'));
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') }, platform: 'win32' });
  try {
    ensureAgentTeamHome(home);

    assert.equal(existsSync(home.root), true);
    assert.equal(existsSync(home.runsDir), true);
    assert.equal(existsSync(home.worktreesDir), true);
    assert.equal(existsSync(home.preflightDir), true);
    assert.equal(existsSync(home.stateDb), false);
    assert.equal(existsSync(home.daemonLock), false);
    assert.equal(existsSync(home.daemonInfo), false);
    assert.equal(existsSync(home.socket), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('default resolution uses os.homedir and default directory creation uses AGENT_TEAM_HOME', () => {
  const previousHome = process.env.AGENT_TEAM_HOME;
  const parent = mkdtempSync(join(tmpdir(), 'agent-team-default-home-'));
  try {
    delete process.env.AGENT_TEAM_HOME;
    const fallback = resolveAgentTeamHome();
    assert.equal(fallback.root, join(homedir(), '.agent-team'));
    assert.equal(fallback.socket, process.platform === 'win32' ? '\\\\.\\pipe\\agent-team' : join(fallback.root, 'daemon.sock'));

    process.env.AGENT_TEAM_HOME = join(parent, 'home');
    ensureAgentTeamHome();
    assert.equal(existsSync(join(process.env.AGENT_TEAM_HOME, 'preflight')), true);
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TEAM_HOME;
    else process.env.AGENT_TEAM_HOME = previousHome;
    rmSync(parent, { recursive: true, force: true });
  }
});
