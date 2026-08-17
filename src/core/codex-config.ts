import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexProviderConfig {
  envKey?: string;
  baseUrl?: string;
}

export interface CodexConfig {
  /** [model_providers.<id>] 声明的自定义 provider */
  providers: Record<string, CodexProviderConfig>;
  /** 顶层 model = "..."（默认 model） */
  defaultModel?: string;
  /** 顶层 model_provider = "..."（默认 provider id） */
  modelProvider?: string;
  /** [profiles.<name>] 中的 model */
  profileModels: Record<string, string>;
}

export function codexConfigPath(): string {
  const home = process.env.CODEX_HOME;
  return join(home && home.length > 0 ? home : join(homedir(), '.codex'), 'config.toml');
}

/**
 * 解析 config.toml 中与 model 校验相关的子集：
 * section 头（[model_providers.<id>] / [profiles.<name>]）和 `key = "string"` 赋值。
 * 其他语法（数组、内联表、多行字符串）安全跳过。
 */
export function parseCodexConfig(text: string): CodexConfig {
  const config: CodexConfig = { providers: {}, profileModels: {} };
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!;
      const parts = section.split('.');
      if (parts[0] === 'model_providers' && parts.length === 2) {
        config.providers[parts[1]!] = config.providers[parts[1]!] ?? {};
      }
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2] !== undefined ? kv[2]! : kv[3]!;
    const parts = section.split('.');
    if (parts[0] === 'model_providers' && parts.length === 2) {
      const provider = config.providers[parts[1]!]!;
      if (key === 'env_key') provider.envKey = value;
      if (key === 'base_url') provider.baseUrl = value;
    } else if (parts[0] === 'profiles' && parts.length === 2 && key === 'model') {
      config.profileModels[parts[1]!] = value;
    } else if (section === '' && key === 'model') {
      config.defaultModel = value;
    } else if (section === '' && key === 'model_provider') {
      config.modelProvider = value;
    }
  }
  return config;
}

export function readCodexConfig(): CodexConfig | null {
  const path = codexConfigPath();
  if (!existsSync(path)) return null;
  try {
    return parseCodexConfig(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export type CodexModelCheckLevel = 'ok' | 'warning' | 'error';

export interface CodexModelCheck {
  level: CodexModelCheckLevel;
  message?: string;
}

/** OpenAI 默认模型族命名（gpt-5.6-terra、o3、codex-mini 等） */
function isDefaultFamilyModel(model: string): boolean {
  return /^(gpt|chatgpt|codex|o\d)/i.test(model);
}

/**
 * 校验 codex 的 model 是否在本地 config.toml 中可用：
 * - "provider/model" 形式：provider 必须已声明（config 缺失时任何 provider 引用都是 error），env_key 对应的环境变量必须存在
 * - 裸 model 名：与顶层 model 或 profile model 一致 → ok；默认 provider 下的 OpenAI 命名（gpt、o、codex 前缀）→ ok；
 *   自定义 provider 或无法识别的命名 → warning（没有可枚举的 model 清单）
 * - model_provider 声明了未定义的 provider → error
 */
export function validateCodexModel(model: string, config: CodexConfig | null, env: Record<string, string | undefined> = process.env): CodexModelCheck {
  const slash = model.indexOf('/');
  if (slash > 0) {
    const providerId = model.slice(0, slash);
    const provider = config?.providers[providerId];
    if (!provider) {
      return {
        level: 'error',
        message: `model "${model}" references provider "${providerId}" which is not declared; add [model_providers.${providerId}] to the codex config`
      };
    }
    if (provider.envKey && !env[provider.envKey]) {
      return {
        level: 'error',
        message: `provider "${providerId}" requires env ${provider.envKey} which is not set`
      };
    }
    return { level: 'ok' };
  }
  if (config?.modelProvider && !config.providers[config.modelProvider]) {
    return {
      level: 'error',
      message: `codex model_provider "${config.modelProvider}" is not declared; add [model_providers.${config.modelProvider}] to the codex config`
    };
  }
  if (config && (model === config.defaultModel || Object.values(config.profileModels).includes(model))) {
    return { level: 'ok' };
  }
  if (!config?.modelProvider && isDefaultFamilyModel(model)) {
    return { level: 'ok' };
  }
  const target = config?.modelProvider ? `provider "${config.modelProvider}"` : 'the default OpenAI provider';
  return { level: 'warning', message: `model "${model}" on codex ${target} cannot be enumerated; failures surface at runtime` };
}
