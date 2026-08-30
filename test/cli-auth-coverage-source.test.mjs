import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const control = vi.hoisted(() => ({ present: true, secret: 'key', calls: [] }));
vi.mock('../src/core/credentials.ts', () => ({
  createCredentialStore: () => ({
    async setApiKey(...args) { control.calls.push(['set', ...args]); },
    async hasApiKey(...args) { control.calls.push(['status', ...args]); return control.present; },
    async deleteApiKey(...args) { control.calls.push(['logout', ...args]); return true; }
  })
}));
vi.mock('../src/core/terminal-input.ts', () => ({ promptMaskedSecret: async () => control.secret }));

const { runCli } = await import('../src/cli.ts');

async function capture(args) {
  const output = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value = '') => output.push(String(value)));
  try {
    await runCli(args);
    return output;
  } finally {
    log.mockRestore();
  }
}

test('auth command covers set, status, logout, and validation errors without Keychain access', async () => {
  control.calls = [];
  control.secret = 'secret';
  assert.deepEqual(await capture(['auth', 'set', '--backend', 'claude', '--profile', 'work']), ['Credential saved.']);
  control.present = true;
  assert.deepEqual(await capture(['auth', 'status', '--backend', 'claude', '--profile', 'work']), ['present']);
  control.present = false;
  assert.deepEqual(await capture(['auth', 'status', '--backend', 'claude', '--profile', 'work']), ['missing']);
  assert.deepEqual(await capture(['auth', 'logout', '--backend', 'claude', '--profile', 'work']), ['Credential removed.']);
  assert.deepEqual(control.calls.map(([name]) => name), ['set', 'status', 'status', 'logout']);

  control.secret = '';
  await assert.rejects(runCli(['auth', 'set', '--backend', 'claude', '--profile', 'work']), /must not be empty/);
  await assert.rejects(runCli(['auth', 'unknown']), /Usage:/);
  await assert.rejects(runCli(['auth', 'status', '--backend', 'bad', '--profile', 'work']), /--backend/);
  await assert.rejects(runCli(['auth', 'status', '--backend', 'claude', '--profile', 'bad.profile']), /--profile/);
  await assert.rejects(runCli(['auth', 'login', '--backend', 'claude', '--profile', 'work']), /does not accept --profile/);
  await assert.rejects(runCli(['auth', 'status', '--backend', 'claude', '--profile', 'work', '--extra']), /Unknown auth option/);
});
