import { test } from 'vitest';
import assert from 'node:assert/strict';
import { sanitizedEnv } from '../src/agent/env.ts';
import { verificationEnv } from '../src/core/process-env.ts';

test('agent environments keep auth but force non-interactive Git isolation', () => {
  const env = sanitizedEnv({ ANTHROPIC_API_KEY: 'test-key', GIT_PAGER: 'less' });
  assert.equal(env.ANTHROPIC_API_KEY, 'test-key');
  assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  const isolated = sanitizedEnv({ ANTHROPIC_API_KEY: 'explicit', UNUSED: undefined }, false);
  assert.equal(isolated.ANTHROPIC_API_KEY, 'explicit');
});

test('verification environments exclude provider credentials', () => {
  const env = verificationEnv('/isolated-home');
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
    assert.equal(key in env, false);
  }
  assert.equal(env.HOME, '/isolated-home');
  assert.equal(env.GIT_PAGER, 'cat');
});
