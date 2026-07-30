import type { AdapterName, RunnerConfig } from '../core/types.js';
import type { AgentAdapter } from './types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { OpenCodeAdapter } from './opencode.js';

export function createAdapter(name: AdapterName, config: RunnerConfig): AgentAdapter {
  if (name === 'claude') return new ClaudeAdapter(config.adapters.claude, config.verification.allowedCommandPrefixes);
  if (name === 'codex') return new CodexAdapter(config.adapters.codex);
  return new OpenCodeAdapter(config.adapters.opencode);
}
