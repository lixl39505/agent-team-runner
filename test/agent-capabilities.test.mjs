import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeBackend } from '../dist/agent/claude/sdk.js';
import { CodexBackend } from '../dist/agent/codex/app-server.js';
import { OpenCodeBackend } from '../dist/agent/opencode/sdk.js';

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

test('Codex and OpenCode reject unsupported session controls before startup', async () => {
  await assert.rejects(new CodexBackend().openSession(spec({ maxTurns: 10 })), /codex.*maxTurns/);
  await assert.rejects(new CodexBackend().openSession(spec({ resumeSessionId: 'thread' })), /codex.*resumeSessionId/);
  await assert.rejects(new OpenCodeBackend().openSession(spec({ maxTurns: 10 })), /opencode.*maxTurns/);
  await assert.rejects(new OpenCodeBackend().openSession(spec({ resumeSessionId: 'session' })), /opencode.*resumeSessionId/);
});
