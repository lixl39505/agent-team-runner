import { gitIsolationEnv } from '../core/process-env.js';

/**
 * 子进程环境净化：默认只保留安全的基础变量，避免把父进程的
 * 后端 API key 或其他秘密泄漏给能执行命令的 agent。调用方通过
 * extraEnv 显式传入后端认证变量或其他必要变量。
 */
const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'SHELL', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'no_proxy'];

export function sanitizedEnv(
  extraEnv: Record<string, string | undefined> = {}
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = extraEnv[key] ?? process.env[key];
    if (value !== undefined) result[key] = value;
  }
  // 显式传入的额外变量最后合并（调用方可控）
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value !== undefined && !(key in result)) result[key] = value;
  }
  return { ...result, ...gitIsolationEnv() };
}
