import type { AgentEntry, BackendId, RunnerConfig } from './types.js';

const BACKEND_IDS: BackendId[] = ['claude', 'codex', 'opencode'];

export function isBackendId(value: string): value is BackendId {
  return BACKEND_IDS.includes(value as BackendId);
}

/** 后端 CLI 命令：backends.<id>.command 缺省用 id 本身 */
export function backendCommand(config: RunnerConfig, id: BackendId): string {
  return config.backends[id]?.command?.trim() || id;
}

/** agent 名不允许含 "."（与内联 "backend.model" 规格区分） */
export function isValidAgentName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);
}

/** 注册表清单（注入 Lead prompt 的能力清单） */
export function agentList(config: RunnerConfig): Array<AgentEntry & { name: string }> {
  return Object.entries(config.agents).map(([name, entry]) => ({ name, ...entry }));
}

export interface AgentConfigValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** 校验 agents 注册表与 roles 引用的语法（不检查后端/model 实际可用性） */
export function validateAgents(config: RunnerConfig): AgentConfigValidation {
  const result: AgentConfigValidation = { ok: true, errors: [], warnings: [] };
  for (const [name, entry] of Object.entries(config.agents)) {
    if (!isValidAgentName(name)) {
      result.ok = false;
      result.errors.push(`agents.${name}: invalid agent name (letters/digits/dash/underscore, no dots)`);
    }
    if (!entry || typeof entry !== 'object' || !isBackendId(String(entry.backend))) {
      result.ok = false;
      result.errors.push(`agents.${name}: unknown backend "${String(entry?.backend)}", expected one of ${BACKEND_IDS.join(', ')}`);
    }
  }
  for (const [role, value] of Object.entries(config.roles)) {
    if (!value) continue;
    if (config.agents[value]) continue;
    const inline = parseInlineAgentSpec(value);
    if (inline) {
      result.warnings.push(`roles.${role}: inline spec "${value}" works, but prefer a named agents registry entry`);
      continue;
    }
    result.ok = false;
    result.errors.push(`roles.${role}: unknown agent "${value}" (not in agents registry and not a "<backend>.<model>" spec)`);
  }
  if (!config.agents[config.defaultAgent]) {
    result.ok = false;
    result.errors.push(`defaultAgent: unknown agent "${config.defaultAgent}" (must exist in the agents registry)`);
  }
  return result;
}

/** 解析内联 "backend.model" 规格；不合法返回 null */
export function parseInlineAgentSpec(spec: string): { backend: BackendId; model: string } | null {
  const dot = spec.indexOf('.');
  if (dot <= 0 || dot === spec.length - 1) return null;
  const backend = spec.slice(0, dot);
  if (!isBackendId(backend)) return null;
  return { backend, model: spec.slice(dot + 1) };
}
