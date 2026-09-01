import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureDaemonBootstrapConfig } from './daemon-config.js';

export interface AgentTeamHome {
  root: string;
  stateDb: string;
  daemonLock: string;
  daemonInfo: string;
  socket: string;
  runsDir: string;
  worktreesDir: string;
  preflightDir: string;
}

export interface ResolveAgentTeamHomeOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export function resolveAgentTeamHome(options: ResolveAgentTeamHomeOptions = {}): AgentTeamHome {
  const env = options.env ?? process.env;
  const root = env.AGENT_TEAM_HOME || join(options.homeDir ?? homedir(), '.agent-team');
  const platform = options.platform ?? process.platform;
  return {
    root,
    stateDb: join(root, 'state.sqlite'),
    daemonLock: join(root, 'daemon.lock'),
    daemonInfo: join(root, 'daemon.json'),
    socket: platform === 'win32' ? '\\\\.\\pipe\\agent-team' : join(root, 'daemon.sock'),
    runsDir: join(root, 'runs'),
    worktreesDir: join(root, 'worktrees'),
    preflightDir: join(root, 'preflight')
  };
}

export function ensureAgentTeamHome(home: AgentTeamHome = resolveAgentTeamHome()): void {
  for (const path of [home.root, home.runsDir, home.worktreesDir, home.preflightDir]) {
    mkdirSync(path, { recursive: true });
  }
  ensureDaemonBootstrapConfig(home.root);
}
