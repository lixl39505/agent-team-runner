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

test('macOS Keychain store reports API key values and security command failures', async () => {
  const key = createCredentialStore({ platform: 'darwin', runSecurity: async () => ({ exitCode: 0, stdout: ' secret\n' }) });
  assert.equal(await key.getApiKey('claude', 'work'), 'secret');
  const missing = createCredentialStore({ platform: 'darwin', runSecurity: async () => ({ exitCode: 44 }) });
  assert.equal(await missing.getApiKey('claude', 'work'), null);
  for (const method of [
    (store) => store.setApiKey('claude', 'work', 'key'),
    (store) => store.hasApiKey('claude', 'work'),
    (store) => store.getApiKey('claude', 'work'),
    (store) => store.deleteApiKey('claude', 'work')
  ]) {
    const failed = createCredentialStore({ platform: 'darwin', runSecurity: async () => ({ exitCode: 1 }) });
    await assert.rejects(method(failed), /macOS Keychain/);
  }
  const empty = createCredentialStore({ platform: 'darwin', runSecurity: async () => ({ exitCode: 0 }) });
  await assert.rejects(empty.setApiKey('claude', 'work', ''), /must not be empty/);
});

test('credential storage clearly rejects unsupported platforms', async () => {
  const store = createCredentialStore({ platform: 'linux' });
  for (const method of [
    () => store.setApiKey('codex', 'work', 'key'),
    () => store.getApiKey('codex', 'work'),
    () => store.hasApiKey('codex', 'work'),
    () => store.deleteApiKey('codex', 'work')
  ]) await assert.rejects(method(), /only supported on macOS/);
});
