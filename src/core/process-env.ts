import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VERIFICATION_ENV_KEYS = [
  'PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'SHELL', 'USER', 'LOGNAME'
];

/** Disable repository-configured Git helpers, pagers, prompts, and index refresh side effects. */
export function gitIsolationEnv(): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.pager',
    GIT_CONFIG_VALUE_1: 'cat',
    GIT_CONFIG_KEY_2: 'core.hooksPath',
    GIT_CONFIG_VALUE_2: join(tmpdir(), 'agent-team-disabled-git-hooks'),
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0'
  };
}

/** Verification executes project code, so never pass provider credentials or unrelated parent secrets. */
export function verificationEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of VERIFICATION_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, HOME: home, ...gitIsolationEnv() };
}
