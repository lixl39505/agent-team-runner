import type { AgentEntry, BackendConfig, BackendId, RunnerConfig } from './types.js';

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

// ---------------------------------------------------------------------------
// v1 → v2 迁移（内存内完成，不重写磁盘文件）
// ---------------------------------------------------------------------------

interface V1Raw {
  defaultAdapter?: string;
  models?: Record<string, string>;
  roles?: Record<string, string>;
  adapters?: Record<string, { command?: string; extraArgs?: string[]; model?: string }>;
}

function looksLikeV1(raw: Record<string, unknown>): boolean {
  const v1 = raw as V1Raw;
  return raw.version !== 2 && (
    v1.adapters !== undefined || v1.defaultAdapter !== undefined || v1.models !== undefined
  );
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';
}

function synthAgentName(backend: BackendId, model?: string): string {
  return model ? `${backend}-${slug(model)}` : `default-${backend}`;
}

/**
 * 把 v1 配置字段翻译成 v2 的 backends/agents/roles/defaultAgent。
 * 返回 null 表示不是 v1 配置。除 v1 专属字段外的其他键由调用方照常合并。
 */
export function migrateV1Fields(raw: Record<string, unknown>): {
  backends: Record<BackendId, BackendConfig>;
  agents: Record<string, AgentEntry>;
  roles: Record<string, string>;
  defaultAgent: string;
  v2Yaml: string;
} | null {
  if (!looksLikeV1(raw)) return null;
  const v1 = raw as V1Raw;
  const alias = v1.models ?? {};

  const backends: Record<BackendId, BackendConfig> = { claude: {}, codex: {}, opencode: {} };
  for (const id of BACKEND_IDS) {
    const legacy = v1.adapters?.[id];
    backends[id] = legacy?.command || legacy?.extraArgs?.length
      ? { ...(legacy?.command ? { command: legacy.command } : {}), ...(legacy?.extraArgs?.length ? { extraArgs: legacy.extraArgs } : {}) }
      : {};
  }

  const agents: Record<string, AgentEntry> = {};
  const roles: Record<string, string> = {};
  const claim = (backend: BackendId, model?: string): string => {
    let name = synthAgentName(backend, model);
    let suffix = 2;
    let existing = agents[name];
    while (existing && (existing.backend !== backend || existing.model !== model)) {
      name = `${synthAgentName(backend, model)}-${suffix}`;
      suffix += 1;
      existing = agents[name];
    }
    if (!agents[name]) agents[name] = { backend, ...(model ? { model } : {}) };
    return name;
  };

  for (const [role, spec] of Object.entries(v1.roles ?? {})) {
    if (!spec) continue;
    const dot = spec.indexOf('.');
    if (dot <= 0) continue; // 语法错误交给 validateAgents 报告
    const backend = spec.slice(0, dot);
    if (!isBackendId(backend)) continue;
    const rawModel = spec.slice(dot + 1);
    const model = alias[rawModel] ?? rawModel;
    roles[role] = claim(backend, model);
  }
  const defaultBackend = (isBackendId(String(v1.defaultAdapter ?? '')) ? v1.defaultAdapter : 'claude') as BackendId;
  const defaultModel = v1.adapters?.[defaultBackend]?.model;
  const defaultAgent = claim(defaultBackend, defaultModel);

  const lines = ['version: 2', 'agents:'];
  for (const [name, entry] of Object.entries(agents)) {
    lines.push(`  ${name}: { backend: ${entry.backend}${entry.model ? `, model: ${entry.model}` : ''} }`);
  }
  const roleLines = Object.entries(roles).map(([role, name]) => `  ${role}: ${name}`);
  if (roleLines.length > 0) lines.push('roles:', ...roleLines);
  lines.push(`defaultAgent: ${defaultAgent}`);
  return { backends, agents, roles, defaultAgent, v2Yaml: lines.join('\n') };
}
