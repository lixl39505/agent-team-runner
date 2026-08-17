import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeSettings {
  /** settings.json 顶层 "model" */
  model?: string | undefined;
  /** settings.json "env" 中与模型路由相关的变量 */
  env: Record<string, string>;
}

export interface ClaudeModelCheck {
  level: 'ok' | 'warning' | 'error';
  message?: string;
}

export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return join(dir && dir.length > 0 ? dir : join(homedir(), '.claude'), 'settings.json');
}

export function readClaudeSettings(): ClaudeSettings | null {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const env = (raw.env && typeof raw.env === 'object' ? raw.env : {}) as Record<string, unknown>;
    return {
      model: typeof raw.model === 'string' ? raw.model : undefined,
      env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string') as [string, string][])
    };
  } catch {
    return null;
  }
}

/** Anthropic 默认模型族命名（claude-sonnet-5、claude-opus-4.8 等） */
function isDefaultFamilyModel(model: string): boolean {
  return /^claude([-_]|$)/i.test(model);
}

/**
 * 校验 claude CLI 的 model 是否本地可用：
 * - 与 settings.json 的 model / env.ANTHROPIC_MODEL 一致 → ok
 * - claude-* 命名（默认模型族）→ ok
 * - 配置了 ANTHROPIC_BASE_URL 网关 → warning（网关后无清单可查）
 * - 既非 claude 命名、无网关、也未在 settings 声明 → error（默认 Anthropic API 不提供该模型）
 */
export function validateClaudeModel(
  model: string,
  settings: ClaudeSettings | null,
  env: Record<string, string | undefined> = process.env
): ClaudeModelCheck {
  const configured = settings?.model ?? settings?.env.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL;
  if (configured === model) return { level: 'ok' };
  const gateway = settings?.env.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL;
  if (isDefaultFamilyModel(model)) return { level: 'ok' };
  if (gateway) {
    return { level: 'warning', message: `model "${model}" goes through ANTHROPIC_BASE_URL gateway; the gateway has no enumerable model list` };
  }
  return {
    level: 'error',
    message: `model "${model}" is not a Claude default-family model and no ANTHROPIC_BASE_URL gateway is configured; set "model" in ${claudeSettingsPath()} or configure a gateway`
  };
}
