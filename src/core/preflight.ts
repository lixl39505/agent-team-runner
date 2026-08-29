import { join } from 'node:path';
import type { AgentBackend } from '../agent/types.js';
import type { AgentBinding, BackendId, RunnerConfig } from './types.js';
import { ProbeCache } from './probe-cache.js';
import { type BackendPool, parseSnapshot, resolveAgentByName, snapshotAgents } from '../agent/registry.js';

const DEFAULT_MODEL_CACHE_KEY = '<backend-default>';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface PreflightInput {
  config: RunnerConfig;
  backends: Record<BackendId, AgentBackend> | BackendPool;
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

  const backendKeys = [...new Set(input.bindings.map(backendKey))];
  const versions = new Map<string, string | undefined>();
  const resolved = new Map<string, AgentBackend>();
  const unsupportedTurnLimits = new Set<string>();
  for (const key of backendKeys) {
    const binding = input.bindings.find((value) => backendKey(value) === key)!;
    try {
      const backend = await getBackend(input.backends, binding);
      resolved.set(key, backend);
      const discovery = await backend.discover();
      versions.set(key, discovery.version);
      if (!discovery.installed) {
        errors.push(`backend "${binding.backend}" is not available locally${discovery.detail ? ` (${discovery.detail})` : ''}; install it or choose another agent`);
        continue;
      }
      if (discovery.authed === false) {
        errors.push(`backend "${binding.backend}" is installed but not authenticated; run its login command`);
      }
      for (const candidate of input.bindings) {
        if (backendKey(candidate) !== key || candidate.maxTurns === undefined || backend.capabilities.maxTurns) continue;
        if (unsupportedTurnLimits.has(candidate.agent)) continue;
        unsupportedTurnLimits.add(candidate.agent);
        errors.push(`agent "${candidate.agent}" configures maxTurns, but backend "${candidate.backend}" does not support it`);
      }
      if (backend.checkPlatform) {
        const platform = await backend.checkPlatform();
        if (!platform.ok) errors.push(`backend "${binding.backend}" platform check failed: ${platform.detail}`);
        else if (platform.degraded) warnings.push(`backend "${binding.backend}" platform isolation is degraded: ${platform.detail}`);
      }
    } catch (error) {
      errors.push(`backend "${binding.backend}" discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 每后端一次性拉取 model 清单
  const modelLists = new Map<string, string[] | null>();
  for (const key of backendKeys) {
    const binding = input.bindings.find((value) => backendKey(value) === key)!;
    if (errors.some((message) => message.startsWith(`backend "${binding.backend}"`))) continue;
    try {
      const models = await resolved.get(key)!.listModels();
      modelLists.set(key, models.map((model) => model.id));
    } catch (error) {
      warnings.push(`backend "${binding.backend}": model enumeration failed (${error instanceof Error ? error.message : String(error)}); falling back to probe`);
      modelLists.set(key, null);
    }
  }

  // 每个 (backend, model) 校验。默认模型没有可枚举的 ID，必须真实 probe。
  const seen = new Set<string>();
  for (const binding of input.bindings) {
    const key = `${backendKey(binding)}|${binding.model ?? DEFAULT_MODEL_CACHE_KEY}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const listed = modelLists.get(backendKey(binding));
    const mustProbe = binding.model === undefined || listed === null || (listed !== undefined && !listed.includes(binding.model));
    if (mustProbe) {
      const probe = await probeCached(
        resolved.get(backendKey(binding))!, binding, versions.get(backendKey(binding)), cache,
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
  const cacheBackend = `${backend.id}:${binding.authProfile ?? 'shared'}`;
  const cached = force ? null : cache.get(cacheBackend, cacheModel, version);
  if (cached) return { ok: cached.ok, ...(cached.ok ? {} : { error: cached.error }) };
  try {
    const probe = await backend.probe(binding.model);
    cache.set(cacheBackend, cacheModel, version, {
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
    const key = `${backendKey(binding)}|${binding.model ?? DEFAULT_MODEL_CACHE_KEY}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const backend = await getBackend(input.backends, binding);
      const probe = await backend.probe(binding.model);
      cache.set(`${binding.backend}:${binding.authProfile ?? 'shared'}`, binding.model ?? DEFAULT_MODEL_CACHE_KEY, undefined, { ok: probe.ok, ...(probe.ok ? {} : { error: probe.error }), latencyMs: probe.latencyMs, checkedAt: Date.now() });
      results.push({ agent: binding.agent, backend: binding.backend, ...(binding.model !== undefined ? { model: binding.model } : {}), ok: probe.ok, ...(probe.ok ? {} : { error: probe.error }), latencyMs: probe.latencyMs });
    } catch (error) {
      results.push({ agent: binding.agent, backend: binding.backend, ...(binding.model !== undefined ? { model: binding.model } : {}), ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

function backendKey(binding: AgentBinding): string {
  if (!binding.authProfile) return binding.backend;
  if (binding.backend === 'opencode' && binding.authIsolation !== 'isolated') return binding.backend;
  return `${binding.backend}:${binding.authProfile}`;
}

async function getBackend(
  backends: Record<BackendId, AgentBackend> | BackendPool,
  binding: AgentBinding
): Promise<AgentBackend> {
  if (typeof (backends as Partial<BackendPool>).get === 'function') {
    return await (backends as BackendPool).get(binding);
  }
  const backend = (backends as Record<BackendId, AgentBackend>)[binding.backend];
  if (!backend) throw new Error(`backend "${binding.backend}" has no implementation registered`);
  return backend;
}
