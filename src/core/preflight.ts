import { join } from 'node:path';
import type { AgentBackend } from '../agent/types.js';
import type { AgentBinding, BackendId, RunnerConfig } from './types.js';
import { ProbeCache } from './probe-cache.js';
import { parseSnapshot, resolveAgentByName, snapshotAgents } from '../agent/registry.js';

const DEFAULT_MODEL_CACHE_KEY = '<backend-default>';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface PreflightInput {
  config: RunnerConfig;
  backends: Record<BackendId, AgentBackend>;
  bindings: AgentBinding[];
  /** doctor --probe 时强制重测（忽略缓存） */
  forceProbe?: boolean;
}

/** Collect the immutable role bindings and every task-level Agent selected by a manifest. */
export function bindingsForRun(config: RunnerConfig, rolesJson: string | null, manifestJson: string | null): AgentBinding[] {
  const snapshot = parseSnapshot(rolesJson) ?? snapshotAgents(config);
  const bindings: AgentBinding[] = [...Object.values(snapshot.roles)];
  if (!manifestJson) return bindings;
  const manifest = JSON.parse(manifestJson) as { tasks: { agent?: string }[] };
  for (const task of manifest.tasks) {
    if (!task.agent || bindings.some((binding) => binding.agent === task.agent)) continue;
    bindings.push(resolveAgentByName(task.agent, config, snapshot.agents));
  }
  return bindings;
}

/**
 * 预检闭环：
 * 1. discover() — 后端安装/版本/认证（未安装 = error）
 * 2. listModels() — 枚举本地可用 model（注册表里的 model 不在清单 = 默认 error）
 * 3. probe() — 1-token 真实试跑，验证后端默认模型和清单缺失时的显式模型；
 *    结果按 (backend, model, version) 持久缓存
 * 取代旧的 dotfile 静态解析（codex-config / claude-config 已删除）。
 */
export async function checkAgentAvailability(input: PreflightInput): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cache = new ProbeCache(join(input.config.workspace.stateDir, 'preflight-cache.json'));

  const backendIds = [...new Set(input.bindings.map((binding) => binding.backend))];
  const versions = new Map<BackendId, string | undefined>();
  const unsupportedTurnLimits = new Set<string>();
  for (const id of backendIds) {
    const backend = input.backends[id];
    if (!backend) {
      errors.push(`backend "${id}" has no implementation registered`);
      continue;
    }
    try {
      const discovery = await backend.discover();
      versions.set(id, discovery.version);
      if (!discovery.installed) {
        errors.push(`backend "${id}" is not available locally${discovery.detail ? ` (${discovery.detail})` : ''}; install it or choose another agent`);
        continue;
      }
      if (discovery.authed === false) {
        errors.push(`backend "${id}" is installed but not authenticated; run its login command`);
      }
      for (const binding of input.bindings) {
        if (binding.backend !== id || binding.maxTurns === undefined || backend.capabilities.maxTurns) continue;
        if (unsupportedTurnLimits.has(binding.agent)) continue;
        unsupportedTurnLimits.add(binding.agent);
        errors.push(`agent "${binding.agent}" configures maxTurns, but backend "${id}" does not support it`);
      }
      if (backend.checkPlatform) {
        const platform = await backend.checkPlatform();
        if (!platform.ok) errors.push(`backend "${id}" platform check failed: ${platform.detail}`);
        else if (platform.degraded) warnings.push(`backend "${id}" platform isolation is degraded: ${platform.detail}`);
      }
    } catch (error) {
      errors.push(`backend "${id}" discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 每后端一次性拉取 model 清单
  const modelLists = new Map<BackendId, string[] | null>();
  for (const id of backendIds) {
    if (errors.some((message) => message.startsWith(`backend "${id}"`))) continue;
    try {
      const models = await input.backends[id]!.listModels();
      modelLists.set(id, models.map((model) => model.id));
    } catch (error) {
      warnings.push(`backend "${id}": model enumeration failed (${error instanceof Error ? error.message : String(error)}); falling back to probe`);
      modelLists.set(id, null);
    }
  }

  // 每个 (backend, model) 校验。默认模型没有可枚举的 ID，必须真实 probe。
  const seen = new Set<string>();
  for (const binding of input.bindings) {
    const key = `${binding.backend}|${binding.model ?? DEFAULT_MODEL_CACHE_KEY}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const listed = modelLists.get(binding.backend);
    const mustProbe = binding.model === undefined || listed === null || (listed !== undefined && !listed.includes(binding.model));
    if (mustProbe) {
      const probe = await probeCached(
        input.backends[binding.backend]!, binding, versions.get(binding.backend), cache,
        input.forceProbe === true, warnings
      );
      if (!probe.ok) {
        const target = binding.model === undefined ? 'default model' : `model "${binding.model}"`;
        errors.push(`agent "${binding.agent}": ${target} is not available on backend "${binding.backend}"${probe.error ? `: ${probe.error}` : ''}`);
      } else if (binding.model !== undefined && listed === null) {
        warnings.push(`agent "${binding.agent}": model "${binding.model}" could not be enumerated but a live probe succeeded`);
      } else if (binding.model !== undefined) {
        warnings.push(`agent "${binding.agent}": model "${binding.model}" is not in the backend's model list but a live probe succeeded (gateway/custom model?)`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

async function probeCached(
  backend: AgentBackend,
  binding: AgentBinding,
  version: string | undefined,
  cache: ProbeCache,
  force: boolean,
  warnings: string[]
): Promise<{ ok: boolean; error?: string | undefined }> {
  const cacheModel = binding.model ?? DEFAULT_MODEL_CACHE_KEY;
  const cached = force ? null : cache.get(backend.id, cacheModel, version);
  if (cached) return { ok: cached.ok, ...(cached.ok ? {} : { error: cached.error }) };
  try {
    const probe = await backend.probe(binding.model);
    cache.set(backend.id, cacheModel, version, {
      ok: probe.ok,
      ...(probe.ok ? {} : { error: probe.error }),
      latencyMs: probe.latencyMs,
      checkedAt: Date.now()
    });
    return { ok: probe.ok, ...(probe.ok ? {} : { error: probe.error }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`probe on ${backend.id}/${binding.model ?? 'default'} crashed: ${message}`);
    return { ok: false, error: message };
  }
}

/** doctor --probe：对全部配置的 agent 强制真实试跑并返回逐项结果 */
export async function probeAll(input: PreflightInput): Promise<Array<{ agent: string; backend: string; model?: string | undefined; ok: boolean; error?: string | undefined; latencyMs?: number | undefined }>> {
  const cache = new ProbeCache(join(input.config.workspace.stateDir, 'preflight-cache.json'));
  const results: Array<{ agent: string; backend: string; model?: string | undefined; ok: boolean; error?: string | undefined; latencyMs?: number | undefined }> = [];
  const seen = new Set<string>();
  for (const binding of input.bindings) {
    const key = `${binding.backend}|${binding.model ?? DEFAULT_MODEL_CACHE_KEY}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const backend = input.backends[binding.backend];
    if (!backend) continue;
    try {
      const probe = await backend.probe(binding.model);
      cache.set(binding.backend, binding.model ?? DEFAULT_MODEL_CACHE_KEY, undefined, { ok: probe.ok, ...(probe.ok ? {} : { error: probe.error }), latencyMs: probe.latencyMs, checkedAt: Date.now() });
      results.push({ agent: binding.agent, backend: binding.backend, ...(binding.model !== undefined ? { model: binding.model } : {}), ok: probe.ok, ...(probe.ok ? {} : { error: probe.error }), latencyMs: probe.latencyMs });
    } catch (error) {
      results.push({ agent: binding.agent, backend: binding.backend, ...(binding.model !== undefined ? { model: binding.model } : {}), ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
