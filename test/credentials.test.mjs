import assert from 'node:assert/strict';
import { test } from 'vitest';
import { KEYCHAIN_SERVICE, createCredentialStore } from '../src/core/credentials.ts';

test('macOS Keychain store uses a fixed service and backend/profile account', async () => {
  const calls = [];
  const store = createCredentialStore({
    platform: 'darwin',
    runSecurity: async (args) => {
      calls.push(args);
      return { exitCode: 0 };
    }
  });

  await store.setApiKey('codex', 'work', 'not-printed');
  assert.equal(await store.getApiKey('codex', 'work'), null);
  assert.equal(await store.hasApiKey('codex', 'work'), true);
  assert.equal(await store.deleteApiKey('codex', 'work'), true);
  assert.deepEqual(calls, [
    ['add-generic-password', '-a', 'codex/work', '-s', KEYCHAIN_SERVICE, '-w', 'not-printed', '-U'],
    ['find-generic-password', '-a', 'codex/work', '-s', KEYCHAIN_SERVICE, '-w'],
    ['find-generic-password', '-a', 'codex/work', '-s', KEYCHAIN_SERVICE],
    ['delete-generic-password', '-a', 'codex/work', '-s', KEYCHAIN_SERVICE]
  ]);
});

test('macOS Keychain store reports absent credentials without reading their value', async () => {
  const store = createCredentialStore({ platform: 'darwin', runSecurity: async () => ({ exitCode: 44 }) });
  assert.equal(await store.hasApiKey('claude', 'default'), false);
  assert.equal(await store.deleteApiKey('claude', 'default'), false);
});

test('credential storage clearly rejects unsupported platforms', async () => {
  const store = createCredentialStore({ platform: 'linux' });
  await assert.rejects(store.hasApiKey('codex', 'work'), /only supported on macOS/);
});
