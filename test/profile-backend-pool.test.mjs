import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { buildBackends, disposeBackends } from '../src/agent/registry.ts';

function binding(backend, profile, isolation = 'isolated', baseUrl) {
  return {
    agent: `${backend}-${profile}`,
    backend,
    authProfile: profile,
    authIsolation: isolation,
    ...(baseUrl ? { baseUrl } : {}),
    source: 'test'
  };
}

function config() {
  return {
    backends: {
      claude: {},
      codex: {},
      opencode: {}
    }
  };
}

test('profile-aware pool isolates backend state without leaking credentials into shared backends', async () => {
  const credentialCalls = [];
  const credentials = {
    async getApiKey(backend, profile) {
      credentialCalls.push([backend, profile]);
      return `${backend}-${profile}-secret`;
    },
    async setApiKey() {},
    async hasApiKey() { return true; },
    async deleteApiKey() { return true; }
  };
  const backends = buildBackends(config(), { credentials });
  try {
    const claudeWork = await backends.get(binding('claude', 'work', 'isolated', 'https://gateway.example/v1'));
    const claudeWorkAgain = await backends.get(binding('claude', 'work'));
    const claudePersonal = await backends.get(binding('claude', 'personal'));
    assert.equal(claudeWork, claudeWorkAgain);
    assert.notEqual(claudeWork, claudePersonal);
    assert.deepEqual(claudeWork.options.env, {
      CLAUDE_CONFIG_DIR: join(homedir(), '.agent-team-runner', 'runtimes', 'claude', 'work'),
      ANTHROPIC_API_KEY: 'claude-work-secret',
      ANTHROPIC_BASE_URL: 'https://gateway.example/v1'
    });
    assert.equal(claudeWork.options.minimalEnv, true);

    const codexWork = await backends.get(binding('codex', 'work'));
    const codexPersonal = await backends.get(binding('codex', 'personal'));
    assert.notEqual(codexWork, codexPersonal);
    assert.deepEqual(codexWork.options.env, {
      CODEX_HOME: join(homedir(), '.agent-team-runner', 'runtimes', 'codex', 'work')
    });
    assert.equal(codexWork.options.minimalEnv, true);

    const sharedOpenCode = await backends.get(binding('opencode', 'work', 'shared'));
    assert.equal(sharedOpenCode, backends.opencode);
    const isolatedOpenCode = await backends.get({ ...binding('opencode', 'work'), model: 'openai/gpt-5' });
    assert.notEqual(isolatedOpenCode, sharedOpenCode);
    assert.deepEqual(isolatedOpenCode.options.env, {
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'api', key: 'opencode-work-secret' } })
    });
    assert.equal(isolatedOpenCode.options.minimalEnv, true);
    assert.deepEqual(credentialCalls, [
      ['claude', 'work'],
      ['claude', 'personal'],
      ['opencode', 'work']
    ]);
  } finally {
    disposeBackends(backends);
  }
});
