import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatEvent } from '../src/core/live-ui.ts';

test('formats visible Agent events and suppresses heartbeat-only activity', () => {
  assert.equal(formatEvent({ type: 'activity' }), null);
  assert.equal(formatEvent({ type: 'session', sessionId: 'abc' }), 'session abc');
  assert.equal(formatEvent({ type: 'message', text: 'one\n two' }), 'one two');
  assert.match(formatEvent({ type: 'tool-call', tool: 'Bash', input: { command: 'npm test' } }), /> Bash/);
  assert.equal(formatEvent({ type: 'tool-result', tool: 'Bash', ok: false }), '< Bash: failed');
  assert.equal(formatEvent({ type: 'usage', inputTokens: 10, outputTokens: 20 }), 'usage in=10 out=20');
});
