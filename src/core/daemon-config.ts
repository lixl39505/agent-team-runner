import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type TuiColorPreference = 'auto' | 'always' | 'never';

export interface DaemonBootstrapConfig {
  version: 1;
  concurrency: {
    maxActiveRuns: number;
  };
  logs: {
    retentionDays: number;
  };
  tui: {
    color: TuiColorPreference;
  };
}

export const DEFAULT_DAEMON_BOOTSTRAP_CONFIG: DaemonBootstrapConfig = {
  version: 1,
  concurrency: { maxActiveRuns: 3 },
  logs: { retentionDays: 30 },
  tui: { color: 'auto' }
};

const DEFAULT_DAEMON_BOOTSTRAP_CONFIG_YAML = `# Agent Team daemon bootstrap configuration.
# Changes are applied the next time the daemon starts.
version: 1

concurrency:
  # Maximum number of execution runs active in this daemon at once.
  maxActiveRuns: 3

logs:
  # Stored preference only. This version does not delete run logs automatically.
  retentionDays: 30

tui:
  # auto, always, or never
  color: auto
`;

export function daemonBootstrapConfigPath(homeRoot: string): string {
  return join(homeRoot, 'config.yml');
}

/** Creates the default config without replacing an existing user-owned file. */
export function ensureDaemonBootstrapConfig(homeRoot: string): string {
  const path = daemonBootstrapConfigPath(homeRoot);
  if (existsSync(path)) return path;
  try {
    writeFileSync(path, DEFAULT_DAEMON_BOOTSTRAP_CONFIG_YAML, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return path;
}

export function loadDaemonBootstrapConfig(homeRoot: string): DaemonBootstrapConfig {
  const path = daemonBootstrapConfigPath(homeRoot);
  if (!existsSync(path)) return defaultDaemonBootstrapConfig();
  let value: unknown;
  try {
    value = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid daemon config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateDaemonBootstrapConfig(value, path);
}

export function defaultDaemonBootstrapConfig(): DaemonBootstrapConfig {
  return {
    version: 1,
    concurrency: { ...DEFAULT_DAEMON_BOOTSTRAP_CONFIG.concurrency },
    logs: { ...DEFAULT_DAEMON_BOOTSTRAP_CONFIG.logs },
    tui: { ...DEFAULT_DAEMON_BOOTSTRAP_CONFIG.tui }
  };
}

function validateDaemonBootstrapConfig(value: unknown, path: string): DaemonBootstrapConfig {
  const config = object(value, 'config', path);
  allowedKeys(config, ['version', 'concurrency', 'logs', 'tui'], 'config', path);
  if (config.version !== 1) throw new Error(`Invalid daemon config ${path}: config.version must be 1`);

  const concurrency = object(config.concurrency, 'config.concurrency', path);
  allowedKeys(concurrency, ['maxActiveRuns'], 'config.concurrency', path);
  const maxActiveRuns = positiveInteger(concurrency.maxActiveRuns, 'config.concurrency.maxActiveRuns', path);

  const logs = object(config.logs, 'config.logs', path);
  allowedKeys(logs, ['retentionDays'], 'config.logs', path);
  const retentionDays = nonNegativeInteger(logs.retentionDays, 'config.logs.retentionDays', path);

  const tui = object(config.tui, 'config.tui', path);
  allowedKeys(tui, ['color'], 'config.tui', path);
  if (tui.color !== 'auto' && tui.color !== 'always' && tui.color !== 'never') {
    throw new Error(`Invalid daemon config ${path}: config.tui.color must be "auto", "always", or "never"`);
  }

  return {
    version: 1,
    concurrency: { maxActiveRuns },
    logs: { retentionDays },
    tui: { color: tui.color }
  };
}

function object(value: unknown, label: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid daemon config ${path}: ${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[], label: string, path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`Invalid daemon config ${path}: ${label} contains unknown field: ${key}`);
  }
}

function positiveInteger(value: unknown, label: string, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid daemon config ${path}: ${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid daemon config ${path}: ${label} must be a non-negative integer`);
  }
  return value;
}
