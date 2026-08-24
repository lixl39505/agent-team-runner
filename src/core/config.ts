import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentEntry, RunnerConfig } from './types.js';
import { migrateV1Fields } from './agent-config.js';

export const DEFAULT_CONFIG: RunnerConfig = {
  version: 2,
  repoRoot: '.',
  stateDir: '.agent-team',
  worktreesDir: '../.agent-team-worktrees',
  baseRef: 'HEAD',
  defaultAgent: 'default-claude',
  concurrency: 3,
  pollIntervalMs: 2000,
  staleAfterMs: 10 * 60 * 1000,
  taskTimeoutMs: 2 * 60 * 60 * 1000,
  maxPlanAttempts: 2,
  maxWorkerAttempts: 2,
  maxReviewCycles: 2,
  branchPrefix: 'agent-team',
  backends: {
    claude: {},
    codex: {},
    opencode: {}
  },
  agents: {
    'default-claude': { backend: 'claude' }
  },
  roles: {},
  verification: {
    allowedCommandPrefixes: [
      'pnpm test',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm build',
      'npm test',
      'npm run',
      'yarn test',
      'yarn lint',
      'yarn build',
      'bun test',
      'go test',
      'cargo test',
      'make test'
    ],
    globalCommands: []
  },
  integration: {
    allowedPaths: ['specs/**'],
    runAgentAfterCherryPick: true
  }
};

const CONFIG_FILENAME_PRIORITY = ['config.yml', 'config.yaml', 'config.json'] as const;

export function configPath(repoRoot: string): string {
  const dir = join(repoRoot, '.agent-team');
  for (const name of CONFIG_FILENAME_PRIORITY) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, 'config.yml');
}

function readRawConfig(repoRoot: string): { raw: Record<string, unknown>; file: string | null } {
  const dir = join(repoRoot, '.agent-team');
  for (const name of CONFIG_FILENAME_PRIORITY) {
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    const text = readFileSync(candidate, 'utf8');
    const raw = name.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`Config file ${candidate} is empty or not a mapping`);
    }
    return { raw: raw as Record<string, unknown>, file: candidate };
  }
  return { raw: {}, file: null };
}

export function initConfig(repoRoot: string): string {
  const target = configPath(repoRoot);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, defaultConfigYaml(), 'utf8');
  }
  return target;
}

function defaultConfigYaml(): string {
  return `# Agent Team Runner 配置 (v2)
# agent = 后端 + model 的具名组合；角色引用注册表中的 agent 名。
version: 2
repoRoot: .
stateDir: .agent-team
worktreesDir: ../.agent-team-worktrees
baseRef: HEAD
defaultAgent: default-claude
concurrency: 3
pollIntervalMs: 2000
staleAfterMs: 600000
taskTimeoutMs: 7200000
maxPlanAttempts: 2
maxWorkerAttempts: 2
maxReviewCycles: 2
branchPrefix: agent-team

# 后端接线：CLI 命令缺省用 backend 名本身
backends:
  claude: {}
  codex: {}
  opencode: {}

# agent 注册表：为不同 role 配置不同 agent（背后不同 model）
# agents:
#   lead-agent:
#     backend: codex
#     model: gpt-5.6-terra
#     description: strong planner
#   fast-worker:
#     backend: opencode
#     model: deepseek/v4-flash
#   careful-review:
#     backend: claude
#     model: claude-sonnet-5

# 角色 → agent 名（未配置的角色回退 defaultAgent）
# Lead 可在 manifest 的任务里用 "agent" 字段引用注册表中的任何 agent
# roles:
#   lead: lead-agent
#   worker: fast-worker
#   reviewer: careful-review
#   integrator: lead-agent

agents:
  default-claude:
    backend: claude

roles: {}

verification:
  allowedCommandPrefixes:
    - pnpm test
    - pnpm lint
    - pnpm typecheck
    - pnpm build
    - npm test
    - npm run
    - yarn test
    - yarn lint
    - yarn build
    - bun test
    - go test
    - cargo test
    - make test
  globalCommands: []

integration:
  allowedPaths:
    - specs/**
  runAgentAfterCherryPick: true
`;
}

export function loadConfig(inputRepoRoot: string): RunnerConfig {
  const repoRoot = resolve(inputRepoRoot);
  const { raw, file } = readRawConfig(repoRoot);

  // v1 配置（adapters/defaultAdapter/models 字段）在内存内迁移成 v2，不重写磁盘
  const migration = migrateV1Fields(raw);
  if (migration && file) {
    console.error([
      `warning: ${file} uses the v1 config format (adapters/defaultAdapter/models).`,
      'It was translated in memory; equivalent v2 config:',
      ...migration.v2Yaml.split('\n').map((line) => `  ${line}`),
      'Please migrate the file to version: 2.'
    ].join('\n'));
  }
  const effective: Record<string, unknown> = { ...raw };
  if (migration) {
    delete effective.adapters;
    delete effective.defaultAdapter;
    delete effective.models;
    effective.backends = migration.backends;
    effective.agents = migration.agents;
    effective.roles = migration.roles;
    effective.defaultAgent = migration.defaultAgent;
    effective.version = 2;
  }

  const merged: RunnerConfig = {
    ...DEFAULT_CONFIG,
    ...(effective as Partial<RunnerConfig>),
    backends: {
      claude: { ...DEFAULT_CONFIG.backends.claude, ...(effective.backends as Record<string, object> | undefined)?.claude },
      codex: { ...DEFAULT_CONFIG.backends.codex, ...(effective.backends as Record<string, object> | undefined)?.codex },
      opencode: { ...DEFAULT_CONFIG.backends.opencode, ...(effective.backends as Record<string, object> | undefined)?.opencode }
    },
    agents: effective.agents
      ? { ...(effective.agents as Record<string, AgentEntry>) }
      : { ...DEFAULT_CONFIG.agents },
    roles: { ...(effective.roles as Record<string, string> | undefined) },
    verification: {
      ...DEFAULT_CONFIG.verification,
      ...(effective.verification as object | undefined)
    },
    integration: {
      ...DEFAULT_CONFIG.integration,
      ...(effective.integration as object | undefined)
    }
  };
  const rawDefaultAgent = typeof effective.defaultAgent === 'string' ? effective.defaultAgent : null;
  if (typeof merged.defaultAgent !== 'string' || !merged.defaultAgent) merged.defaultAgent = DEFAULT_CONFIG.defaultAgent;
  // 自定义 agents 注册表会整体替换默认项；用户未显式指定 defaultAgent 时自动回退到注册表第一个条目
  if (!merged.agents[merged.defaultAgent] && !rawDefaultAgent) {
    const first = Object.keys(merged.agents)[0];
    if (first) merged.defaultAgent = first;
  }

  merged.repoRoot = resolve(repoRoot, merged.repoRoot);
  merged.stateDir = resolvePath(merged.repoRoot, merged.stateDir);
  merged.worktreesDir = resolvePath(merged.repoRoot, merged.worktreesDir);
  return merged;
}

export interface ConfigOverride {
  key: string;
  value: string;
}

/**
 * 应用 "-c key=value" 形式的命令行覆写（优先级：CLI > 配置文件 > 默认值）。
 * key 按 "." 逐层定位；value 先尝试 JSON 解析（数字/布尔/JSON 结构），失败按字符串。
 */
export function applyOverrides(config: RunnerConfig, overrides: ConfigOverride[]): RunnerConfig {
  for (const { key, value } of overrides) {
    const segments = key.split('.').filter((segment) => segment.length > 0);
    if (segments.length === 0) throw new Error(`Invalid -c override: empty key`);
    let target: Record<string, unknown> = config as unknown as Record<string, unknown>;
    for (const segment of segments.slice(0, -1)) {
      const next = target[segment];
      if (next === undefined || next === null || typeof next !== 'object') {
        target[segment] = {};
      }
      target = target[segment] as Record<string, unknown>;
    }
    target[segments[segments.length - 1]!] = parseOverrideValue(value);
  }
  return config;
}

function parseOverrideValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function resolvePath(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}
