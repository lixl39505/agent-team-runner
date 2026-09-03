import { join } from 'node:path';
import { createCredentialStore, type CredentialStore } from '../core/credentials.js';
import type {
  AgentBinding,
  AgentEntry,
  AgentRole,
  AgentSnapshot,
  BackendId,
  RunnerConfig,
  TaskSpec
} from '../core/types.js';
import { isBackendId, parseInlineAgentSpec } from '../core/agent-config.js';
import type { AgentBackend } from './types.js';
import { ClaudeBackend } from './claude/sdk.js';
import { CodexBackend } from './codex/app-server.js';
import { OpenCodeBackend } from './opencode/sdk.js';

export interface BackendPool {
  get(binding: AgentBinding): Promise<AgentBackend>;
  dispose(): void;
}

/** Compatibility surface for injected test backends and legacy callers. */
export type BackendRegistry = Record<BackendId, AgentBackend> & BackendPool;

export interface BackendRegistryOptions {
  /** Test seam. Created lazily only for a binding that uses authProfile. */
  credentials?: CredentialStore | undefined;
}

/**
 * A binding-aware, lazy backend pool. Native/no-profile bindings retain one
 * shared backend per id; profile credentials never enter a shared backend.
 */
export function buildBackends(config: RunnerConfig, options: BackendRegistryOptions = {}): BackendRegistry {
  const pool = new ProfileAwareBackendPool(config, options.credentials);
  const registry = {} as BackendRegistry;
  for (const id of ['claude', 'codex', 'opencode'] as BackendId[]) {
    Object.defineProperty(registry, id, {
      enumerable: true,
      get: () => pool.shared(id)
    });
  }
  Object.defineProperties(registry, {
    get: { enumerable: false, value: (binding: AgentBinding) => pool.get(binding) },
    dispose: { enumerable: false, value: () => pool.dispose() }
  });
  return registry;
}

/** 释放后端持有的子进程（runner 退出/预检结束时调用） */
export function disposeBackends(backends: Record<BackendId, AgentBackend> | BackendPool): void {
  if (isBackendPool(backends)) {
    backends.dispose();
    return;
  }
  for (const backend of Object.values(backends)) {
    const disposable = backend as AgentBackend & { dispose?: () => void };
    disposable.dispose?.();
  }
}

/** Resolve a backend from a binding, retaining plain-record test seams. */
export async function backendFor(
  backends: Record<BackendId, AgentBackend> | BackendPool,
  binding: AgentBinding
): Promise<AgentBackend> {
  return isBackendPool(backends) ? await backends.get(binding) : backends[binding.backend]!;
}

function isBackendPool(value: Record<BackendId, AgentBackend> | BackendPool): value is BackendPool {
  return typeof (value as Partial<BackendPool>).get === 'function';
}

class ProfileAwareBackendPool implements BackendPool {
  private readonly sharedBackends = new Map<BackendId, AgentBackend>();
  private readonly profiledBackends = new Map<string, Promise<AgentBackend>>();
  private credentialStore: CredentialStore | undefined;
  private disposed = false;

  constructor(
    private readonly config: RunnerConfig,
    credentials?: CredentialStore
  ) {
    this.credentialStore = credentials;
  }

  shared(id: BackendId): AgentBackend {
    if (this.disposed) throw new Error('backend pool has been disposed');
    let backend = this.sharedBackends.get(id);
    if (!backend) {
      backend = this.create(id);
      this.sharedBackends.set(id, backend);
    }
    return backend;
  }

  async get(binding: AgentBinding): Promise<AgentBackend> {
    if (this.disposed) throw new Error('backend pool has been disposed');
    const profile = binding.authProfile;
    if (!profile) return this.shared(binding.backend);

    // Codex profiles always isolate native login state. Claude's SDK keeps its
    // environment per backend. OpenCode isolates only when explicitly asked.
    if (binding.backend === 'opencode' && binding.authIsolation !== 'isolated') {
      return this.shared(binding.backend);
    }
    const key = `${binding.backend}:${profile}`;
    let backend = this.profiledBackends.get(key);
    if (!backend) {
      backend = this.createProfiled(binding, profile);
      this.profiledBackends.set(key, backend);
    }
    return await backend;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const backend of this.sharedBackends.values()) disposeBackend(backend);
    for (const pending of this.profiledBackends.values()) {
      void pending.then(disposeBackend).catch(() => {});
    }
    this.sharedBackends.clear();
    this.profiledBackends.clear();
  }

  private createProfiled(binding: AgentBinding, profile: string): Promise<AgentBackend> {
    // 运行时目录归属 $AGENT_TEAM_HOME，不落在固定的用户家目录旁路。
    const runtime = join(this.config.workspace.stateDir, 'runtimes', binding.backend, profile);
    if (binding.backend === 'codex') {
      // Codex profile support is native-login isolation only. Do not read or
      // inject an API secret until Codex provider configuration is supported.
      return Promise.resolve(this.create('codex', { CODEX_HOME: runtime }, true));
    }
    return (async () => {
      const apiKey = await this.credentials().getApiKey(binding.backend, profile);
      if (binding.backend === 'claude') {
        return this.create('claude', {
          CLAUDE_CONFIG_DIR: runtime,
          ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
          ...(binding.baseUrl ? { ANTHROPIC_BASE_URL: binding.baseUrl } : {})
        }, true);
      }
      if (!apiKey) throw new Error(`auth profile "${profile}" has no API key for OpenCode`);
      const provider = binding.model?.split('/', 1)[0];
      if (!provider) throw new Error(`agent "${binding.agent}" must use a provider/model when OpenCode auth isolation is enabled`);
      return this.create('opencode', {
        OPENCODE_AUTH_CONTENT: JSON.stringify({ [provider]: { type: 'api', key: apiKey } })
      }, true);
    })();
  }

  private credentials(): CredentialStore {
    this.credentialStore ??= createCredentialStore();
    return this.credentialStore;
  }

  private create(id: BackendId, env?: Record<string, string>, minimalEnv?: boolean): AgentBackend {
    const backend = this.config.backends[id];
    const base = {
      ...(backend.command ? { command: backend.command } : {}),
      nativeWindowsSandbox: backend.nativeWindowsSandbox,
      ...(env ? { env } : {}),
      ...(minimalEnv ? { minimalEnv: true } : {})
    };
    if (id === 'claude') return new ClaudeBackend(base);
    if (id === 'codex') return new CodexBackend(base);
    return new OpenCodeBackend(base);
  }
}

function disposeBackend(backend: AgentBackend): void {
  (backend as AgentBackend & { dispose?: () => void }).dispose?.();
}

/** 解析角色的 agent 绑定。回退链：roles.<role>（注册表名或内联 backend.model）→ defaultAgent。 */
export function resolveAgent(role: AgentRole, config: RunnerConfig): AgentBinding {
  const value = config.roles?.[role];
  if (value) {
    const entry = config.agents[value];
    if (entry) return { agent: value, ...entry, source: `roles.${role}` };
    const inline = parseInlineAgentSpec(value);
    if (inline) return { agent: value, ...inline, source: `roles.${role} (inline)` };
    throw new Error(`roles.${role}: unknown agent "${value}" (not in agents registry and not a "<backend>.<model>" spec)`);
  }
  const fallback = config.agents[config.defaultAgent];
  if (!fallback) {
    throw new Error(`defaultAgent "${config.defaultAgent}" is not defined in the agents registry`);
  }
  return { agent: config.defaultAgent, ...fallback, source: 'defaultAgent' };
}

/** 按注册表名解析任务 agent：运行快照优先，回退当前 config。 */
export function resolveAgentByName(name: string, config: RunnerConfig, snapshotAgents?: Record<string, AgentEntry>): AgentBinding {
  const entry = snapshotAgents?.[name] ?? config.agents[name];
  if (!entry) throw new Error(`unknown agent "${name}" (not in the agents registry)`);
  return { agent: name, ...entry, source: `task:${name}` };
}

/** 解析 DB 里的 roles_json 快照；兼容旧 v1 形状（{cli, model, source}）。 */
export function parseSnapshot(rolesJson: string | null): AgentSnapshot | null {
  if (!rolesJson) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rolesJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.version === 2 && parsed.roles && parsed.agents) return parsed as unknown as AgentSnapshot;
  // v1 快照：逐角色翻译
  const roles = {} as Record<AgentRole, AgentBinding>;
  for (const [role, value] of Object.entries(parsed)) {
    const entry = value as { cli?: string; model?: string; source?: string } | null;
    if (entry && typeof entry === 'object' && isBackendId(String(entry.cli ?? ''))) {
      roles[role as AgentRole] = {
        agent: entry.source ?? `legacy-${entry.cli}`,
        backend: entry.cli as BackendId,
        ...(entry.model ? { model: entry.model } : {}),
        source: entry.source ?? 'legacy-snapshot'
      };
    }
  }
  return { version: 2, roles, agents: {} };
}

/** 全量快照（roles 绑定 + agents 注册表），创建运行时写入 runs.roles_json。 */
export function snapshotAgents(config: RunnerConfig): AgentSnapshot {
  return {
    version: 2,
    roles: {
      worker: resolveAgent('worker', config),
      reviewer: resolveAgent('reviewer', config),
      integrator: resolveAgent('integrator', config)
    },
    agents: { ...config.agents }
  };
}

/** 执行阶段解析角色：运行快照优先（hermetic），无快照回退当前 config。 */
export function resolveAgentWithSnapshot(role: AgentRole, config: RunnerConfig, rolesJson: string | null): AgentBinding {
  const snapshot = parseSnapshot(rolesJson);
  const entry = snapshot?.roles[role];
  if (entry && isBackendId(entry.backend)) return entry;
  return resolveAgent(role, config);
}

/**
 * 解析任务级 agent：task.agent 优先（连带 model——修复旧 task.adapter 丢 model 的问题），
 * 否则用 worker 角色绑定（快照优先）。
 */
export function resolveTaskAgent(task: TaskSpec, config: RunnerConfig, rolesJson: string | null): AgentBinding {
  if (task.agent) return resolveAgentByName(task.agent, config, parseSnapshot(rolesJson)?.agents);
  return resolveAgentWithSnapshot('worker', config, rolesJson);
}
