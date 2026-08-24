import { join } from 'node:path';
import type { AgentBackend } from '../agent/types.js';
import type { AgentBinding, BackendId, RunnerConfig } from './types.js';
import { ProbeCache } from './probe-cache.js';

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

/**
 * 预检闭环：
 * 1. discover() — 后端安装/版本/认证（未安装 = error）
 * 2. listModels() — 枚举本地可用 model（注册表里的 model 不在清单 = 默认 error）
 * 3. probe() — 1-token 真实试跑，仅用于：清单缺失时的仲裁（网关模型）、或 --probe 强制；
 *    结果按 (backend, model, version) 持久缓存
 * 取代旧的 dotfile 静态解析（codex-config / claude-config 已删除）。
 */
export async function checkAgentAvailability(input: PreflightInput): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cache = new ProbeCache(join(input.config.stateDir, 'preflight-cache.json'));

  const backendIds = [...new Set(input.bindings.map((binding) => binding.backend))];
  const versions = new Map<BackendId, string | undefined>();
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

  // 每个 (backend, model) 校验
  const seen = new Set<string>();
  for (const binding of input.bindings) {
    if (!binding.model) continue; // 未指定 model → 用后端默认，无需校验
    const key = `${binding.backend}|${binding.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const listed = modelLists.get(binding.backend);
    if (listed !== null && listed !== undefined && !listed.includes(binding.model)) {
      const probe = await probeCached(input.backends[binding.backend]!, binding, versions.get(binding.backend), cache, input.forceProbe === true, warnings);
      if (!probe.ok) {
        errors.push(`agent "${binding.agent}": model "${binding.model}" is not available on backend "${binding.backend}"${probe.error ? `: ${probe.error}` : ''}`);
      } else {
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
  const cached = force ? null : cache.get(backend.id, binding.model!, version);
  if (cached) return { ok: cached.ok, ...(cached.ok ? {} : { error: cached.error }) };
  try {
    const probe = await backend.probe(binding.model);
    cache.set(backend.id, binding.model!, version, {
      ok: probe.ok,
      ...(probe.ok ? {} : { error: probe.error }),
      latencyMs: probe.latencyMs,
      checkedAt: Date.now()
    });
    return { ok: probe.ok, ...(probe.ok ? {} : { error: probe.error }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`probe on ${backend.id}/${binding.model} crashed: ${message}`);
    return { ok: false, error: message };
  }
}

/** doctor --probe：对全部配置的 agent 强制真实试跑并返回逐项结果 */
export async function probeAll(input: PreflightInput): Promise<Array<{ agent: string; backend: string; model?: string | undefined; ok: boolean; error?: string | undefined; latencyMs?: number | undefined }>> {
  const cache = new ProbeCache(join(input.config.stateDir, 'preflight-cache.json'));
  const results: Array<{ agent: string; backend: string; model?: string | undefined; ok: boolean; error?: string | undefined; latencyMs?: number | undefined }> = [];
  const seen = new Set<string>();
  for (const binding of input.bindings) {
    const key = `${binding.backend}|${binding.model ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const backend = input.backends[binding.backend];
    if (!backend) continue;
    if (!binding.model) {
      results.push({ agent: binding.agent, backend: binding.backend, ok: true });
      continue;
    }
    try {
      const probe = await backend.probe(binding.model);
      cache.set(binding.backend, binding.model, undefined, { ok: probe.ok, ...(probe.ok ? {} : { error: probe.error }), latencyMs: probe.latencyMs, checkedAt: Date.now() });
      results.push({ agent: binding.agent, backend: binding.backend, model: binding.model, ok: probe.ok, ...(probe.ok ? {} : { error: probe.error }), latencyMs: probe.latencyMs });
    } catch (error) {
      results.push({ agent: binding.agent, backend: binding.backend, model: binding.model, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
