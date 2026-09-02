import { test } from 'vitest';
import assert from 'node:assert/strict';
import { sanitizedEnv } from '../src/agent/env.ts';
import { verificationEnv } from '../src/core/process-env.ts';

test('agent environments exclude inherited backend keys, preserve explicit keys, and force Git isolation', () => {
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalOpenai = process.env.OPENAI_API_KEY;
  const originalCodex = process.env.CODEX_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'parent-anthropic';
  process.env.OPENAI_API_KEY = 'parent-openai';
  process.env.CODEX_API_KEY = 'parent-codex';
  try {
    const env = sanitizedEnv({ ANTHROPIC_API_KEY: 'explicit-anthropic', GIT_PAGER: 'less' });
    assert.equal(env.ANTHROPIC_API_KEY, 'explicit-anthropic');
    assert.equal('OPENAI_API_KEY' in env, false);
    assert.equal('CODEX_API_KEY' in env, false);
    assert.equal(sanitizedEnv().ANTHROPIC_API_KEY, undefined);
    assert.equal(sanitizedEnv({ CODEX_API_KEY: 'explicit-codex' }).CODEX_API_KEY, 'explicit-codex');
    assert.equal(sanitizedEnv({ PATH: 'explicit-path' }).PATH, 'explicit-path');
    assert.equal(env.GIT_PAGER, 'cat');
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  } finally {
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    if (originalOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenai;
    if (originalCodex === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = originalCodex;
  }
});

test('verification environments exclude provider credentials', () => {
  const env = verificationEnv('/isolated-home');
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
    assert.equal(key in env, false);
  }
  assert.equal(env.HOME, '/isolated-home');
  assert.equal(env.GIT_PAGER, 'cat');
});
