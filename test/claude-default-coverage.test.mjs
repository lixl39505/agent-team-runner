import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const calls = [];
vi.mock('cross-spawn', () => ({
  default(command) {
    calls.push(command);
    return {
      stdout: { on() {} },
      on(event, listener) {
        if (event === 'close') queueMicrotask(() => listener(0));
      },
      kill() {}
    };
  }
}));

const { ClaudeBackend } = await import('../src/agent/claude/sdk.ts');

test('ClaudeBackend defaults its options and discovery spawn implementation', async () => {
  const backend = new ClaudeBackend();
  assert.deepEqual(await backend.discover(), { backend: 'claude', installed: true, version: undefined });
  assert.deepEqual(calls, ['claude']);
});
