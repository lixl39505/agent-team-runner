import type { AdapterName, AgentRole, ResolvedProfile, RunnerConfig } from './types.js';

const ADAPTER_NAMES: AdapterName[] = ['claude', 'codex', 'opencode'];

export function isAdapterName(value: string): value is AdapterName {
  return ADAPTER_NAMES.includes(value as AdapterName);
}

/**
 * 解析 Agent profile 字符串 "cli.model"。
 * 按第一个 "." 切分，model 段可含 "." 和 "/"（如 codex.gpt-5.6-terra、opencode.deepseek/v4-flash）。
 * model 段先查 config.models 别名表，未命中按字面量使用。
 */
export function parseProfile(spec: string, config: RunnerConfig): ResolvedProfile {
  const dot = spec.indexOf('.');
  if (dot <= 0) {
    throw new Error(`Invalid agent profile "${spec}": expected format <cli>.<model> (e.g. codex.gpt-5.6-terra)`);
  }
  const cli = spec.slice(0, dot);
  if (!isAdapterName(cli)) {
    throw new Error(`Invalid agent profile "${spec}": unknown cli "${cli}", expected one of ${ADAPTER_NAMES.join(', ')}`);
  }
  const rawModel = spec.slice(dot + 1);
  if (rawModel.length === 0) {
    throw new Error(`Invalid agent profile "${spec}": model part is empty`);
  }
  const model = config.models?.[rawModel] ?? rawModel;
  return { cli, model, source: spec };
}

/**
 * 解析角色的 agent 配置。回退链：config.roles[role] → defaultAdapter + adapters[defaultAdapter].model。
 */
export function resolveRole(role: AgentRole, config: RunnerConfig): ResolvedProfile {
  const spec = config.roles?.[role];
  if (spec) return parseProfile(spec, config);
  const cli = config.defaultAdapter;
  return { cli, model: config.adapters[cli].model, source: `default:${cli}` };
}

export interface ProfileValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** 校验 config 中所有声明的 profile 语法（不检查 CLI 是否实际可用） */
export function validateProfiles(config: RunnerConfig): ProfileValidation {
  const result: ProfileValidation = { ok: true, errors: [], warnings: [] };
  for (const [role, spec] of Object.entries(config.roles ?? {})) {
    if (!spec) continue;
    try {
      parseProfile(spec, config);
    } catch (error) {
      result.ok = false;
      result.errors.push(`roles.${role}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isAdapterName(config.defaultAdapter)) {
    result.ok = false;
    result.errors.push(`defaultAdapter: unknown cli "${config.defaultAdapter}"`);
  }
  return result;
}

/** 生成全量角色快照（plan 时持久化到 runs.roles_json） */
export function snapshotRoles(config: RunnerConfig): Record<AgentRole, ResolvedProfile> {
  return {
    lead: resolveRole('lead', config),
    worker: resolveRole('worker', config),
    reviewer: resolveRole('reviewer', config),
    integrator: resolveRole('integrator', config)
  };
}

/**
 * 从快照或当前 config 解析角色（run 阶段使用）。
 * 优先 plan 时固化的快照，保证配置文件后续变化不影响已规划的 run。
 */
export function resolveRoleWithSnapshot(
  role: AgentRole,
  config: RunnerConfig,
  rolesJson: string | null
): ResolvedProfile {
  if (!rolesJson) return resolveRole(role, config);
  const snapshot = JSON.parse(rolesJson) as Record<string, ResolvedProfile>;
  const entry = snapshot[role];
  if (!entry || !isAdapterName(entry.cli)) return resolveRole(role, config);
  return entry;
}
