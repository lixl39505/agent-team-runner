import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, vi } from 'vitest';

const control = vi.hoisted(() => ({ failure: false, stdout: ' token\n', withStdout: true, exitCode: 0 }));

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new EventEmitter();
    child.stdout = control.withStdout ? new EventEmitter() : undefined;
    queueMicrotask(() => {
      if (control.failure) child.emit('error');
      else {
        child.stdout?.emit('data', Buffer.from(control.stdout));
        child.emit('close', control.exitCode);
      }
    });
    return child;
  }
}));

const { createCredentialStore } = await import('../src/core/credentials.ts');

test('default Keychain runner reads subprocess output and surfaces spawn failures', async () => {
  control.failure = false;
  control.withStdout = true;
  control.exitCode = 0;
  assert.equal(await createCredentialStore({ platform: 'darwin' }).getApiKey('claude', 'work'), 'token');
  control.withStdout = false;
  assert.equal(await createCredentialStore({ platform: 'darwin' }).getApiKey('claude', 'work'), null);
  control.failure = true;
  await assert.rejects(createCredentialStore({ platform: 'darwin' }).getApiKey('claude', 'work'), /Unable to run/);
  control.failure = false;
  control.withStdout = true;
  control.stdout = '';
  assert.equal(await createCredentialStore({ platform: 'darwin' }).getApiKey('claude', 'work'), null);
  control.stdout = 'token';
  assert.equal(await createCredentialStore().getApiKey('claude', 'work'), 'token');
  control.exitCode = null;
  await assert.rejects(createCredentialStore({ platform: 'darwin' }).getApiKey('claude', 'work'), /Unable to read/);
  control.exitCode = 0;
});
