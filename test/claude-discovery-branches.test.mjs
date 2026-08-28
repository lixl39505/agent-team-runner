import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { ClaudeBackend } from '../src/agent/claude/sdk.ts';

function fakeChild({ stdout = true } = {}) {
  const listeners = new Map();
  const stdoutListeners = new Map();
  const killed = [];
  return {
    ...(stdout ? {
      stdout: {
        on(event, listener) { stdoutListeners.set(event, listener); }
      }
    } : {}),
    on(event, listener) { listeners.set(event, listener); },
    kill(signal) { killed.push(signal); },
    emit(event, value) { listeners.get(event)?.(value); },
    write(value) { stdoutListeners.get('data')?.(Buffer.from(value)); },
    killed
  };
}

function backendWith(childOrError, command = 'fake-claude') {
  const calls = [];
  const backend = new ClaudeBackend({
    command,
    spawn(...args) {
      calls.push(args);
      if (childOrError instanceof Error) throw childOrError;
      return childOrError;
    }
  });
  return { backend, calls };
}

test('Claude discovery handles spawn throws and error events', async () => {
  const thrown = backendWith(new Error('missing'));
  assert.deepEqual(await thrown.backend.discover(), {
    backend: 'claude', installed: false, detail: 'failed to spawn fake-claude'
  });
  assert.deepEqual(thrown.calls, [['fake-claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }]]);

  const child = fakeChild();
  const errored = backendWith(child);
  const result = errored.backend.discover();
  child.emit('error');
  assert.deepEqual(await result, {
    backend: 'claude', installed: false, detail: 'failed to spawn fake-claude'
  });
});

test('Claude discovery kills a timed-out fake child', async (t) => {
  vi.useFakeTimers();
  const child = fakeChild();
  const { backend } = backendWith(child);
  const result = backend.discover();
  vi.advanceTimersByTime(10_000);
  vi.useRealTimers();
  assert.deepEqual(await result, {
    backend: 'claude', installed: false, detail: 'version probe timed out'
  });
  assert.deepEqual(child.killed, ['SIGKILL']);
});

test('Claude discovery reports version stdout and nonzero close results', async () => {
  const successfulChild = fakeChild();
  const successful = backendWith(successfulChild);
  const successResult = successful.backend.discover();
  successfulChild.write(' Claude Code 1.2.3\n');
  successfulChild.emit('close', 0);
  assert.deepEqual(await successResult, {
    backend: 'claude', installed: true, version: 'Claude Code 1.2.3'
  });

  const failedChild = fakeChild({ stdout: false });
  const failed = backendWith(failedChild);
  const failedResult = failed.backend.discover();
  failedChild.emit('close', 1);
  assert.deepEqual(await failedResult, {
    backend: 'claude', installed: false, version: undefined, detail: 'exit 1'
  });
});
