import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ClaudeBackend } from '../src/agent/claude/sdk.ts';
import { CodexBackend } from '../src/agent/codex/app-server.ts';
import { OpenCodeBackend } from '../src/agent/opencode/sdk.ts';

function spec(overrides = {}) {
  return {
    role: 'worker',
    cwd: process.cwd(),
    prompt: 'test',
    schema: { type: 'object' },
    access: 'workspace-write',
    timeoutMs: 1_000,
    staleAfterMs: 1_000,
    ...overrides
  };
}

test('Claude advertises the session controls it consumes', () => {
  assert.deepEqual(new ClaudeBackend().capabilities, { maxTurns: true, resumeSession: true });
});

test('Codex and OpenCode advertise supported continuation controls', async () => {
  await assert.rejects(new CodexBackend().openSession(spec({ maxTurns: 10 })), /codex.*maxTurns/);
  await assert.rejects(new OpenCodeBackend().openSession(spec({ maxTurns: 10 })), /opencode.*maxTurns/);
  assert.deepEqual(new CodexBackend().capabilities, { maxTurns: false, resumeSession: true });
  assert.deepEqual(new OpenCodeBackend().capabilities, { maxTurns: false, resumeSession: true });
});
