import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentTeamHome {
  root: string;
  stateDb: string;
  runsDir: string;
  worktreesDir: string;
  preflightDir: string;
}

export interface ResolveAgentTeamHomeOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function resolveAgentTeamHome(options: ResolveAgentTeamHomeOptions = {}): AgentTeamHome {
  const env = options.env ?? process.env;
  const root = env.AGENT_TEAM_HOME || join(options.homeDir ?? homedir(), '.agent-team');
  return {
    root,
    stateDb: join(root, 'state.sqlite'),
    runsDir: join(root, 'runs'),
    worktreesDir: join(root, 'worktrees'),
    preflightDir: join(root, 'preflight')
  };
}

export function ensureAgentTeamHome(home: AgentTeamHome = resolveAgentTeamHome()): void {
  for (const path of [home.root, home.runsDir, home.worktreesDir, home.preflightDir]) {
    mkdirSync(path, { recursive: true });
  }
}
