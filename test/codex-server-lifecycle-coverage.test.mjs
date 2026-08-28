import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexBackend } from '../src/agent/codex/app-server.ts';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function inFixture(name, action) {
  const cwd = process.cwd();
  process.chdir(`${fixtures}codex-app-server-${name}`);
  try {
    await action();
  } finally {
    process.chdir(cwd);
  }
}

test('Codex app-server initialization cleans up failures and reacts to exits', async () => {
  await inFixture('success', async () => {
    const backend = new CodexBackend({ command: process.execPath });
    let notifications = 0;
    let serverRequests = 0;
    let callbacksResolved;
    const callbacks = new Promise((resolve) => { callbacksResolved = resolve; });
    const resolveCallbacks = () => {
      if (notifications && serverRequests) callbacksResolved();
    };
    backend.handleNotification = () => {
      notifications += 1;
      resolveCallbacks();
    };
    backend.handleServerRequest = async () => {
      serverRequests += 1;
      resolveCallbacks();
      return {};
    };
    await backend.ensureServer();
    assert.equal(backend.initialized, true);
    await callbacks;
    assert.equal(notifications, 1);
    assert.equal(serverRequests, 1);

    let closed = 0;
    backend.sessions.set('thread', { close: async () => { closed += 1; } });
    backend.connection.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(closed, 1);
    assert.equal(backend.connection, null);

    await backend.ensureServer();
    assert.equal(backend.initialized, true);
    backend.dispose();
  });

  await inFixture('failure', async () => {
    const backend = new CodexBackend({ command: process.execPath });
    await assert.rejects(backend.ensureServer(), /fixture initialization failed/);
    assert.equal(backend.connection, null);
  });
});
