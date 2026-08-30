import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { backendFor, buildBackends, disposeBackends } from '../src/agent/registry.ts';

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
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('backendFor supports both managed pools and injected backend records', async () => {
  const binding = { agent: 'main', backend: 'claude', source: 'test' };
  const backend = { id: 'claude' };
  assert.equal(await backendFor({ claude: backend }, binding), backend);
  const pool = { get: async () => backend, dispose() {} };
  assert.equal(await backendFor(pool, binding), backend);
});

test('disposing a rejected profiled backend absorbs its pending creation failure', async () => {
  const backends = buildBackends(config(), {
    credentials: { async getApiKey() { return null; }, async setApiKey() {}, async hasApiKey() { return false; }, async deleteApiKey() { return false; } }
  });
  await assert.rejects(backends.get({ ...binding('opencode', 'missing'), model: 'openai/gpt-5' }), /has no API key/);
  disposeBackends(backends);
  await new Promise((resolve) => setImmediate(resolve));
});

test('profile pool permits Claude native auth, isolates Codex, and rejects use after disposal', async () => {
  const backends = buildBackends(config(), {
    credentials: { async getApiKey() { return null; }, async setApiKey() {}, async hasApiKey() { return false; }, async deleteApiKey() { return false; } }
  });
  const claude = await backends.get(binding('claude', 'native'));
  assert.equal(claude.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal((await backends.get(binding('codex', 'native'))).options.minimalEnv, true);
  disposeBackends(backends);
  disposeBackends(backends);
  assert.throws(() => backends.claude, /disposed/);
  await assert.rejects(backends.get(binding('claude', 'native')), /disposed/);
});

test('isolated OpenCode requires a provider-qualified model', async () => {
  const backends = buildBackends(config(), {
    credentials: { async getApiKey() { return 'secret'; }, async setApiKey() {}, async hasApiKey() { return true; }, async deleteApiKey() { return true; } }
  });
  try {
    await assert.rejects(backends.get(binding('opencode', 'work')), /provider\/model/);
  } finally {
    disposeBackends(backends);
  }
});
