import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RunnerConfig } from './types.js';

export const DEFAULT_CONFIG: RunnerConfig = {
  version: 1,
  repoRoot: '.',
  stateDir: '.agent-team',
  worktreesDir: '../.agent-team-worktrees',
  baseRef: 'HEAD',
  defaultAdapter: 'claude',
  concurrency: 3,
  pollIntervalMs: 2000,
  staleAfterMs: 10 * 60 * 1000,
  taskTimeoutMs: 2 * 60 * 60 * 1000,
  maxPlanAttempts: 2,
  maxWorkerAttempts: 2,
  maxReviewCycles: 2,
  branchPrefix: 'agent-team',
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
  },
  adapters: {
    claude: { command: 'claude', extraArgs: [] },
    codex: { command: 'codex', extraArgs: [] },
    opencode: { command: 'opencode', extraArgs: [] }
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

function readRawConfig(repoRoot: string): { raw: Partial<RunnerConfig>; file: string | null } {
  const dir = join(repoRoot, '.agent-team');
  for (const name of CONFIG_FILENAME_PRIORITY) {
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    const text = readFileSync(candidate, 'utf8');
    const raw = name.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`Config file ${candidate} is empty or not a mapping`);
    }
    return { raw: raw as Partial<RunnerConfig>, file: candidate };
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
  return `# Agent Team Runner 配置
# Profile 格式: <cli>.<model>，如 codex.gpt-5.6-terra、opencode.deepseek/v4-flash
# model 段可引用下方 models 别名表中的短名
version: 1
repoRoot: .
stateDir: .agent-team
worktreesDir: ../.agent-team-worktrees
baseRef: HEAD
defaultAdapter: claude
concurrency: 3
pollIntervalMs: 2000
staleAfterMs: 600000
taskTimeoutMs: 7200000
maxPlanAttempts: 2
maxWorkerAttempts: 2
maxReviewCycles: 2
branchPrefix: agent-team

# model 别名（可选）：短名 → 真实 model id
# models:
#   terra: gpt-5.6-terra
#   glm52: z-ai/glm-5.2

# 角色 → profile（可选）：未配置的角色回退到 defaultAdapter
# 同一 CLI 可通过不同 profile 使用不同 model
# roles:
#   lead: codex.terra
#   worker: opencode.deepseek/v4-flash
#   reviewer: opencode.glm52
#   integrator: codex.gpt-5.6-terra

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

adapters:
  claude:
    command: claude
    extraArgs: []
  codex:
    command: codex
    extraArgs: []
  opencode:
    command: opencode
    extraArgs: []
`;
}

export function loadConfig(inputRepoRoot: string): RunnerConfig {
  const repoRoot = resolve(inputRepoRoot);
  const { raw } = readRawConfig(repoRoot);

  const merged: RunnerConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    models: { ...(raw.models ?? {}) },
    roles: { ...(raw.roles ?? {}) },
    verification: {
      ...DEFAULT_CONFIG.verification,
      ...(raw.verification ?? {})
    },
    integration: {
      ...DEFAULT_CONFIG.integration,
      ...(raw.integration ?? {})
    },
    adapters: {
      claude: { ...DEFAULT_CONFIG.adapters.claude, ...(raw.adapters?.claude ?? {}) },
      codex: { ...DEFAULT_CONFIG.adapters.codex, ...(raw.adapters?.codex ?? {}) },
      opencode: { ...DEFAULT_CONFIG.adapters.opencode, ...(raw.adapters?.opencode ?? {}) }
    }
  };

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
