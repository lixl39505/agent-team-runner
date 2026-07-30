import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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

export function configPath(repoRoot: string): string {
  return join(repoRoot, '.agent-team', 'config.json');
}

export function initConfig(repoRoot: string): string {
  const target = configPath(repoRoot);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
  }
  return target;
}

export function loadConfig(inputRepoRoot: string): RunnerConfig {
  const repoRoot = resolve(inputRepoRoot);
  const target = configPath(repoRoot);
  const raw = existsSync(target)
    ? (JSON.parse(readFileSync(target, 'utf8')) as Partial<RunnerConfig>)
    : {};

  const merged: RunnerConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
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

function resolvePath(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}
