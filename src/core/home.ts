import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isWithinDirectory } from './files.js';

export interface AgentTeamHome {
  root: string;
  stateDb: string;
  runsDir: string;
  worktreesDir: string;
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
    worktreesDir: join(root, 'worktrees')
  };
}

export function ensureAgentTeamHome(home: AgentTeamHome = resolveAgentTeamHome()): void {
  for (const path of [home.root, home.runsDir, home.worktreesDir]) {
    mkdirSync(path, { recursive: true });
  }
}

/**
 * ADR 0002：项目仓库内不写任何 runner 状态。--home / AGENT_TEAM_HOME 落在目标仓库内时，
 * state.sqlite、runs/、worktrees/ 会全部写进项目目录，必须在创建任何目录之前拒绝。
 */
export function assertHomeOutsideRepo(home: AgentTeamHome, repoRoot: string): void {
  const root = resolve(home.root);
  const repo = resolve(repoRoot);
  if (isWithinDirectory(root, repo)) {
    throw new Error(
      `Agent-team home ${root} is inside the project repository ${repo}; ` +
      'runner state (state.sqlite, runs/, worktrees/) must never live inside the repository. ' +
      'Choose another AGENT_TEAM_HOME.'
    );
  }
}
