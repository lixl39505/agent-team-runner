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

/** 按配置实例化三后端（codex/opencode 的子进程都是懒启动） */
export function buildBackends(config: RunnerConfig): Record<BackendId, AgentBackend> {
  return {
    claude: new ClaudeBackend(
      config.backends.claude?.command ? { command: config.backends.claude.command } : {}
    ),
    codex: new CodexBackend(
      config.backends.codex?.command ? { command: config.backends.codex.command } : {}
    ),
    opencode: new OpenCodeBackend(
      config.backends.opencode?.command ? { command: config.backends.opencode.command } : {}
    )
  };
}

/** 释放后端持有的子进程（runner 退出/预检结束时调用） */
export function disposeBackends(backends: Record<BackendId, AgentBackend>): void {
  for (const backend of Object.values(backends)) {
    const disposable = backend as AgentBackend & { dispose?: () => void };
    disposable.dispose?.();
  }
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

/** 按注册表名解析（task.agent 用）：plan 快照优先，回退当前 config。 */
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

/** 全量快照（roles 绑定 + agents 注册表），plan 时写入 runs.roles_json */
export function snapshotAgents(config: RunnerConfig): AgentSnapshot {
  return {
    version: 2,
    roles: {
      lead: resolveAgent('lead', config),
      worker: resolveAgent('worker', config),
      reviewer: resolveAgent('reviewer', config),
      integrator: resolveAgent('integrator', config)
    },
    agents: { ...config.agents }
  };
}

/** run 阶段解析角色：plan 快照优先（hermetic），无快照回退当前 config。 */
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

