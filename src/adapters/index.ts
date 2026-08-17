import type { AdapterName, RunnerConfig } from '../core/types.js';
import type { AgentAdapter } from './types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { OpenCodeAdapter } from './opencode.js';

/**
 * 创建 Agent CLI adapter。modelOverride 来自 role profile 解析结果，
 * 存在时覆盖该 CLI 基础配置中的 model。
 */
export function createAdapter(name: AdapterName, config: RunnerConfig, modelOverride?: string): AgentAdapter {
  const base = config.adapters[name];
  const adapterConfig = modelOverride ? { ...base, model: modelOverride } : base;
  if (name === 'claude') return new ClaudeAdapter(adapterConfig, config.verification.allowedCommandPrefixes);
  if (name === 'codex') return new CodexAdapter(adapterConfig);
  return new OpenCodeAdapter(adapterConfig);
}
