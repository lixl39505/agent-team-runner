import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isWithinDirectory } from './files.js';
import { git } from './git.js';

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
  // 符号链接会让词法比较失真（如 macOS 的 /var → /private/var），且任一侧可能尚不存在、
  // 无法 realpath：对两侧的「词法形式 + 规范形式」做全组合判断，任一命中即拒绝。
  const rootVariants = pathVariants(home.root);
  const repoVariants = pathVariants(repoRoot);
  const inside = rootVariants.some((root) => repoVariants.some((repo) => isWithinDirectory(root, repo)));
  if (inside) {
    throw new Error(
      `Agent-team home ${home.root} is inside the project repository ${repoRoot}; ` +
      'runner state (state.sqlite, runs/, worktrees/) must never live inside the repository. ' +
      'Choose another AGENT_TEAM_HOME.'
    );
  }
}

/** 路径的词法形式 + realpath 规范形式（路径不存在时只有词法形式）。 */
function pathVariants(path: string): string[] {
  const lexical = resolve(path);
  try {
    const canonical = realpathSync(lexical);
    return canonical === lexical ? [lexical] : [lexical, canonical];
  } catch {
    return [lexical];
  }
}

/**
 * status/log/clean 不经过 run 路径的 contract repoRoot 防护，而它们同样会创建
 * state.sqlite。以进程 cwd 所在仓库（工作树根 + git 公共目录，覆盖 linked worktree）
 * 为界做同样的拒绝；cwd 不在任何 Git 仓库内时无需防护。
 */
export async function assertHomeOutsideProcessRepo(home: AgentTeamHome, cwd: string = process.cwd()): Promise<void> {
  for (const args of [['rev-parse', '--show-toplevel'], ['rev-parse', '--git-common-dir']]) {
    const result = await git(cwd, args, true);
    const output = result.stdout.trim();
    // 不在 Git 仓库内（code≠0、无输出）：没有需要防护的仓库边界。
    if (result.code !== 0 || output === '') continue;
    assertHomeOutsideRepo(home, resolve(cwd, output));
  }
}
