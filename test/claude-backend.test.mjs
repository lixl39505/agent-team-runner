import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeBackend } from '../dist/agent/claude/sdk.js';
import { readOnlyPolicy } from '../dist/core/policy.js';

test('ClaudeBackend forwards the task worktree as the SDK cwd', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-cwd-'));
  let capturedOptions;
  const queryFactory = ({ options }) => {
    capturedOptions = options;
    return {
      close() {},
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          structured_output: { status: 'completed' },
          session_id: 'test-session'
        };
      }
    };
  };
  const backend = new ClaudeBackend({}, queryFactory);

  const session = await backend.openSession({
    role: 'worker',
    cwd,
    prompt: 'test',
    schema: { type: 'object' },
    policy: readOnlyPolicy(),
    timeoutMs: 1_000,
    staleAfterMs: 1_000
  });
  const outcome = await session.completion();

  assert.equal(capturedOptions.cwd, cwd);
  assert.equal(outcome.ok, true);
  await session.close();
});
