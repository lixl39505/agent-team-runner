import { isBackendId, validateAgents } from './agent-config.js';
import { DEFAULT_CONFIG } from './defaults.js';
import type { AgentTeamHome } from './home.js';
import type { JsonValue, ProjectPolicyRevision, ProjectRecord } from './project-registry.js';
import type { AgentEntry, BackendConfig, BackendId, RunnerConfig } from './types.js';

type JsonObject = { [key: string]: JsonValue };

const BACKEND_POLICY_KEYS = [
  'backends',
  'concurrency',
  'staleAfterMs',
  'taskTimeoutMs',
  'retry',
  'crossVendorReview'
] as const;

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: JsonValue | undefined, path: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${path} must be a JSON object`);
  return value;
}

function allowedKeys(value: JsonObject, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${path}.${key} is not allowed`);
  }
}

function string(value: JsonValue | undefined, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function stringArray(value: JsonValue | undefined, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${path} must be an array of strings`);
  }
  return [...value] as string[];
}

function positiveInteger(value: JsonValue | undefined, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}

function backendId(value: JsonValue | undefined, path: string): BackendId {
  const id = string(value, path);
  if (!isBackendId(id)) throw new Error(`${path} has unknown backend "${id}"`);
  return id;
}

function agentEntry(value: JsonValue | undefined, path: string): AgentEntry {
  const input = object(value, path);
  allowedKeys(input, ['backend', 'model', 'description', 'maxTurns', 'authProfile', 'authIsolation', 'baseUrl'], path);
  const entry: AgentEntry = { backend: backendId(input.backend, `${path}.backend`) };
  if (input.model !== undefined) entry.model = string(input.model, `${path}.model`);
  if (input.description !== undefined) entry.description = string(input.description, `${path}.description`);
  if (input.maxTurns !== undefined) entry.maxTurns = positiveInteger(input.maxTurns, `${path}.maxTurns`);
  if (input.authProfile !== undefined) entry.authProfile = string(input.authProfile, `${path}.authProfile`);
  if (input.authIsolation !== undefined) entry.authIsolation = string(input.authIsolation, `${path}.authIsolation`) as NonNullable<AgentEntry['authIsolation']>;
  if (input.baseUrl !== undefined) entry.baseUrl = string(input.baseUrl, `${path}.baseUrl`);
  return entry;
}

function backendConfig(value: JsonValue | undefined, path: string): BackendConfig {
  const input = object(value, path);
  allowedKeys(input, ['command', 'nativeWindowsSandbox'], path);
  const config: BackendConfig = {};
  if (input.command !== undefined) config.command = string(input.command, `${path}.command`);
  if (input.nativeWindowsSandbox !== undefined) {
    const sandbox = string(input.nativeWindowsSandbox, `${path}.nativeWindowsSandbox`);
    if (sandbox !== 'require' && sandbox !== 'allow-degraded') {
      throw new Error(`${path}.nativeWindowsSandbox must be "require" or "allow-degraded"`);
    }
    config.nativeWindowsSandbox = sandbox;
  }
  return config;
}

function defaultConfig(): RunnerConfig {
  return {
    ...DEFAULT_CONFIG,
    workspace: { ...DEFAULT_CONFIG.workspace },
    retry: { ...DEFAULT_CONFIG.retry },
    backends: {
      claude: { ...DEFAULT_CONFIG.backends.claude },
      codex: { ...DEFAULT_CONFIG.backends.codex },
      opencode: { ...DEFAULT_CONFIG.backends.opencode }
    },
    agents: {},
    roles: {},
    verification: {
      allowedCommandPrefixes: [...DEFAULT_CONFIG.verification.allowedCommandPrefixes]
    }
  };
}

/** Converts the persisted global project policy into a hermetic runner configuration. */
export function runnerConfigFromProjectPolicy(
  policy: ProjectPolicyRevision,
  project: ProjectRecord,
  home: AgentTeamHome
): RunnerConfig {
  const agentMapping = object(policy.agentProfileMapping, 'agentProfileMapping');
  allowedKeys(agentMapping, ['defaultAgent', 'agents', 'roles'], 'agentProfileMapping');
  const agentsInput = object(agentMapping.agents, 'agentProfileMapping.agents');
  const agents: Record<string, AgentEntry> = {};
  for (const [name, entry] of Object.entries(agentsInput)) {
    agents[name] = agentEntry(entry, `agentProfileMapping.agents.${name}`);
  }

  const roles: RunnerConfig['roles'] = {};
  if (agentMapping.roles !== undefined) {
    const rolesInput = object(agentMapping.roles, 'agentProfileMapping.roles');
    allowedKeys(rolesInput, ['worker', 'reviewer', 'integrator'], 'agentProfileMapping.roles');
    for (const [role, value] of Object.entries(rolesInput)) {
      roles[role as keyof RunnerConfig['roles']] = string(value, `agentProfileMapping.roles.${role}`);
    }
  }

  const backendPolicy = object(policy.backendPolicy, 'backendPolicy');
  allowedKeys(backendPolicy, BACKEND_POLICY_KEYS, 'backendPolicy');
  const config = defaultConfig();
  config.defaultAgent = string(agentMapping.defaultAgent, 'agentProfileMapping.defaultAgent');
  config.agents = agents;
  config.roles = roles;
  config.workspace = {
    repoRoot: project.repoRoot,
    stateDir: home.root,
    worktreesDir: home.worktreesDir,
    baseRef: string(policy.baseRef, 'baseRef'),
    branchPrefix: 'agent-team'
  };
  config.verification = {
    allowedCommandPrefixes: stringArray(policy.verificationAllowedCommandPrefixes, 'verificationAllowedCommandPrefixes')
  };

  if (backendPolicy.backends !== undefined) {
    const backendsInput = object(backendPolicy.backends, 'backendPolicy.backends');
    for (const [id, value] of Object.entries(backendsInput)) {
      if (!isBackendId(id)) throw new Error(`backendPolicy.backends.${id} has unknown backend`);
      config.backends[id] = { ...config.backends[id], ...backendConfig(value, `backendPolicy.backends.${id}`) };
    }
  }
  if (backendPolicy.concurrency !== undefined) config.concurrency = positiveInteger(backendPolicy.concurrency, 'backendPolicy.concurrency');
  if (backendPolicy.staleAfterMs !== undefined) config.staleAfterMs = positiveInteger(backendPolicy.staleAfterMs, 'backendPolicy.staleAfterMs');
  if (backendPolicy.taskTimeoutMs !== undefined) config.taskTimeoutMs = positiveInteger(backendPolicy.taskTimeoutMs, 'backendPolicy.taskTimeoutMs');
  if (backendPolicy.crossVendorReview !== undefined) {
    if (typeof backendPolicy.crossVendorReview !== 'boolean') {
      throw new Error('backendPolicy.crossVendorReview must be a boolean');
    }
    config.crossVendorReview = backendPolicy.crossVendorReview;
  }
  if (backendPolicy.retry !== undefined) {
    const retry = object(backendPolicy.retry, 'backendPolicy.retry');
    allowedKeys(retry, ['maxWorkerAttempts', 'maxReviewCycles'], 'backendPolicy.retry');
    if (retry.maxWorkerAttempts !== undefined) config.retry.maxWorkerAttempts = positiveInteger(retry.maxWorkerAttempts, 'backendPolicy.retry.maxWorkerAttempts');
    if (retry.maxReviewCycles !== undefined) config.retry.maxReviewCycles = positiveInteger(retry.maxReviewCycles, 'backendPolicy.retry.maxReviewCycles');
  }

  const validation = validateAgents(config);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return config;
}
