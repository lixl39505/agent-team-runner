/**
 * 子进程环境净化：默认只保留安全的基础变量 + 后端认证变量，
 * 防止把父进程的全部秘密（云凭证、token）泄漏给能执行命令的 agent。
 * 项目通过 extraEnv 显式放行更多变量。
 */
const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'SHELL', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'no_proxy'];

const BACKEND_AUTH_KEYS = [
  // claude
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'DISABLE_TELEMETRY',
  // codex
  'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY',
  // opencode
  'OPENCODE_CONFIG', 'OPENCODE_MODELS_URL'
];

export function sanitizedEnv(extraEnv: Record<string, string | undefined> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [...BASE_ENV_KEYS, ...BACKEND_AUTH_KEYS]) {
    const value = extraEnv[key] ?? process.env[key];
    if (value !== undefined) result[key] = value;
  }
  // 显式传入的额外变量最后合并（调用方可控）
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value !== undefined && !(key in result)) result[key] = value;
  }
  return result;
}
