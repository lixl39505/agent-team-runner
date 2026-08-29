import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentEntry, RunnerConfig } from './types.js';

export const DEFAULT_CONFIG: RunnerConfig = {
  version: 3,
  defaultAgent: 'default-claude',
  concurrency: 3,
  staleAfterMs: 10 * 60 * 1000,
  taskTimeoutMs: 2 * 60 * 60 * 1000,
  workspace: {
    repoRoot: '.',
    stateDir: '.agent-team',
    worktreesDir: '../.agent-team-worktrees',
    baseRef: 'HEAD',
    branchPrefix: 'agent-team'
  },
  retry: {
    maxPlanAttempts: 2,
    maxWorkerAttempts: 2,
    maxReviewCycles: 2
  },
  status: {
    pollIntervalMs: 2000
  },
  interactionAlert: {
    background: '#7C3AED',
    foreground: '#FFFFFF'
  },
  backends: {
    claude: { nativeWindowsSandbox: 'require' },
    codex: { nativeWindowsSandbox: 'require' },
    opencode: { nativeWindowsSandbox: 'require' }
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
  return `# Agent Team Runner 配置 (v3)
# agent = 后端 + model 的具名组合；角色引用注册表中的 agent 名。
version: 3

# 常用控制
defaultAgent: default-claude
concurrency: 3
staleAfterMs: 600000
taskTimeoutMs: 7200000
interactionAlert:
  background: '#7C3AED'
  foreground: '#FFFFFF'

# 仓库与 Worktree
workspace:
  repoRoot: .
  stateDir: .agent-team
  worktreesDir: ../.agent-team-worktrees
  baseRef: HEAD
  branchPrefix: agent-team

# 重试与状态刷新
retry:
  maxPlanAttempts: 2
  maxWorkerAttempts: 2
  maxReviewCycles: 2
status:
  pollIntervalMs: 2000

# 后端接线：CLI 命令缺省用 backend 名本身
backends:
  claude:
    nativeWindowsSandbox: require
  codex:
    nativeWindowsSandbox: require
  opencode:
    nativeWindowsSandbox: require

# agent 注册表：为不同 role 配置不同 agent（背后不同 model）
# agents:
#   lead-agent:
#     backend: codex
#     model: gpt-5.6-terra
#     description: strong planner
#     authProfile: work # Keychain profile name; never put API keys here
#     authIsolation: isolated # shared (default behavior) or isolated
#     baseUrl: https://api.example.com/v1
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

  if (file && raw.version !== 3) {
    throw new Error(`Config file ${file ?? configPath(repoRoot)} must declare version: 3`);
  }
  const effective: Record<string, unknown> = { ...raw };

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
    workspace: {
      ...DEFAULT_CONFIG.workspace,
      ...(effective.workspace as object | undefined)
    },
    retry: {
      ...DEFAULT_CONFIG.retry,
      ...(effective.retry as object | undefined)
    },
    status: {
      ...DEFAULT_CONFIG.status,
      ...(effective.status as object | undefined)
    },
    interactionAlert: {
      ...DEFAULT_CONFIG.interactionAlert,
      ...(effective.interactionAlert as object | undefined)
    },
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
  for (const [id, backend] of Object.entries(merged.backends)) {
    if (!['require', 'allow-degraded'].includes(backend.nativeWindowsSandbox ?? '')) {
      throw new Error(`backends.${id}.nativeWindowsSandbox must be "require" or "allow-degraded"`);
    }
  }
  validateInteractionAlert(merged);

  merged.workspace.repoRoot = resolve(repoRoot, merged.workspace.repoRoot);
  merged.workspace.stateDir = resolvePath(merged.workspace.repoRoot, merged.workspace.stateDir);
  merged.workspace.worktreesDir = resolvePath(merged.workspace.repoRoot, merged.workspace.worktreesDir);
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
  validateInteractionAlert(config);
  return config;
}

function validateInteractionAlert(config: RunnerConfig): void {
  for (const [name, value] of Object.entries(config.interactionAlert)) {
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
      throw new Error(`interactionAlert.${name} must be a #RRGGBB color`);
    }
  }
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
