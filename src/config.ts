// ATeam home layout, config loading and the agent registry.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentKind } from './core/types.ts';
import { AGENT_KINDS } from './core/types.ts';

export interface AgentEntry {
  kind: AgentKind;
  model?: string;
  /** Extra argv appended after `--` in `herdr agent start`. */
  args?: string[];
}

export interface AgentRegistry {
  [name: string]: AgentEntry;
}

export interface AteamConfig {
  agents: AgentRegistry;
  roles: {
    worker: string;
    reviewer: string;
    integrator: string;
  };
  defaults: {
    maxParallel: number;
    taskTimeoutMs: number;
    maxWorkerAttempts: number;
    maxReviewCycles: number;
  };
  /** Verification command allowlist applied to every contract. */
  verificationAllowlist: string[];
}

export const DEFAULT_CONFIG: AteamConfig = {
  agents: {
    claude: { kind: 'claude' },
    codex: { kind: 'codex' },
    opencode: { kind: 'opencode' },
  },
  roles: { worker: 'claude', reviewer: 'codex', integrator: 'claude' },
  defaults: {
    maxParallel: 3,
    taskTimeoutMs: 30 * 60_000,
    maxWorkerAttempts: 3,
    maxReviewCycles: 3,
  },
  verificationAllowlist: ['bun', 'npm *', 'npx *', 'pnpm *', 'cargo *', 'go *', 'pytest *', 'python -m pytest *', 'make *', 'just *'],
};

export interface AteamHome {
  root: string;
  dbPath: string;
  runsDir: string;
  config: AteamConfig;
}

export function resolveHome(flagHome?: string): string {
  const root = resolve(flagHome ?? process.env.ATEAM_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.agent-team'));
  return root;
}

export async function loadHome(flagHome?: string): Promise<AteamHome> {
  const root = resolveHome(flagHome);
  const config = await loadConfig(join(root, 'config.json'));
  return {
    root,
    dbPath: join(root, 'state.sqlite'),
    runsDir: join(root, 'runs'),
    config,
  };
}

export async function loadConfig(configPath: string): Promise<AteamConfig> {
  const config: AteamConfig = structuredClone(DEFAULT_CONFIG);
  if (!existsSync(configPath)) return config;
  const raw = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
  if (raw.agents !== undefined) {
    config.agents = validateRegistry(raw.agents);
  }
  if (raw.roles !== undefined) {
    const roles = raw.roles as Record<string, unknown>;
    for (const role of ['worker', 'reviewer', 'integrator'] as const) {
      const name = roles[role];
      if (typeof name === 'string') config.roles[role] = name;
    }
  }
  if (raw.defaults !== undefined) {
    const defaults = raw.defaults as Record<string, unknown>;
    for (const key of Object.keys(config.defaults) as Array<keyof AteamConfig['defaults']>) {
      const value = defaults[key];
      if (typeof value === 'number' && value > 0) config.defaults[key] = value;
    }
  }
  if (raw.verificationAllowlist !== undefined) {
    const list = raw.verificationAllowlist;
    if (Array.isArray(list) && list.every((v) => typeof v === 'string')) {
      config.verificationAllowlist = list as string[];
    }
  }
  return config;
}

function validateRegistry(value: unknown): AgentRegistry {
  if (typeof value !== 'object' || value === null) {
    throw new Error('config.agents must be an object');
  }
  const out: AgentRegistry = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`config.agents.${name} must be an object`);
    }
    const kind = (entry as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !AGENT_KINDS.includes(kind as AgentKind)) {
      throw new Error(`config.agents.${name}.kind must be one of ${AGENT_KINDS.join('|')}`);
    }
    const e = entry as AgentEntry;
    out[name] = { kind: kind as AgentKind, model: e.model, args: e.args };
  }
  return out;
}

/** Resolve a task's agent key to a registry entry; cross-kind reviewer enforced by caller. */
export function resolveAgentEntry(config: AteamConfig, agentKey: string | undefined, role: keyof AteamConfig['roles']): AgentEntry {
  const key = agentKey ?? config.roles[role];
  const entry = config.agents[key];
  if (!entry) {
    throw new Error(`agent "${key}" is not in the registry (roles.${role}); add it to config.json`);
  }
  return entry;
}
