import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';
import { formatEvent, LiveRunUi } from '../src/core/live-ui.ts';

test('formats visible Agent events and suppresses heartbeat-only activity', () => {
  assert.equal(formatEvent({ type: 'activity' }), null);
  assert.equal(formatEvent({ type: 'session', sessionId: 'abc' }), 'session abc');
  assert.equal(formatEvent({ type: 'message', text: 'one\n two' }), 'one two');
  assert.match(formatEvent({ type: 'tool-call', tool: 'Bash', input: { command: 'npm test' } }), /> Bash/);
  assert.equal(formatEvent({ type: 'tool-result', tool: 'Bash', ok: false }), '< Bash: failed');
  assert.equal(formatEvent({ type: 'usage', inputTokens: 10, outputTokens: 20 }), 'usage in=10 out=20');
});

test('renders Agent state, buffers events, and yields the terminal to interaction prompts', async () => {
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 140;
  output.rows = 12;
  let written = '';
  output.on('data', (chunk) => { written += chunk.toString(); });
  const db = {
    listAgentExecutions: () => [
      { agentId: 'T1-worker-1', role: 'worker', taskId: 'T1', backend: 'codex', model: 'gpt', status: 'running' },
      { agentId: 'lead-1', role: 'lead', taskId: null, backend: 'claude', model: null, status: 'completed' }
    ]
  };
  const ui = new LiveRunUi(db, output);
  const execution = { runId: 'demo', agentId: 'T1-worker-1', taskId: 'T1', role: 'worker', backend: 'codex', model: 'gpt', logPath: '/tmp/log' };
  ui.start();
  ui.onEvent(execution, { type: 'message', text: 'working' });
  ui.onEvent(execution, { type: 'tool-call', tool: 'Bash', input: { command: 'npm test' } });
  ui.onEvent(execution, { type: 'message', text: 'x'.repeat(500) });
  await new Promise((resolve) => setTimeout(resolve, 550));
  ui.onEvent(execution, { type: 'activity' });
  ui.pause();
  ui.onEvent(execution, { type: 'activity' });
  ui.resume();
  delete output.columns;
  delete output.rows;
  ui.onEvent(execution, { type: 'usage' });
  ui.stop();
  assert.match(written, /Agent Team Runner  demo/);
  assert.match(written, /\[T1-worker-1\] working/);
  assert.match(written, /T1-worker-1 worker\/T1 codex\/gpt running/);
  assert.match(written, /lead-1 lead claude completed/);
  assert.match(written, /\x1b\[\?1049l/);
});

test('does not emit terminal controls without real TTY dimensions', () => {
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk.toString(); });
  const ui = new LiveRunUi({ listAgentExecutions: () => [] }, output);
  ui.start('demo');
  ui.pause();
  ui.resume();
  ui.stop();
  assert.equal(written, '');
});

test('handles bounded streams, missing execution lookups, and all visible event details', () => {
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 60;
  output.rows = 12;
  const ui = new LiveRunUi({}, output);
  const execution = { runId: 'demo', agentId: 'agent', role: 'lead', backend: 'claude', logPath: '/tmp/log' };
  ui.start();
  for (let index = 0; index < 205; index += 1) ui.onEvent(execution, { type: 'message', text: `message-${index}` });
  ui.pause();
  ui.pause();
  ui.stop();
  ui.stop();
  ui.resume();
  const circular = {}; circular.self = circular;
  assert.match(formatEvent({ type: 'tool-call', tool: 'Tool', input: circular }), /> Tool/);
  assert.equal(formatEvent({ type: 'tool-result', tool: 'Tool', ok: true, summary: 'finished' }), '< Tool: ok finished');
  assert.equal(formatEvent({ type: 'permission-check', tool: 'Tool', input: {}, allowed: false, reason: 'denied' }), 'permission Tool: denied (denied)');
  assert.equal(formatEvent({ type: 'permission-check', tool: 'Tool', input: {}, allowed: true }), 'permission Tool: allowed');
  assert.equal(formatEvent({ type: 'usage' }), 'usage in=0 out=0');
  assert.equal(formatEvent({ type: 'usage', outputTokens: 1 }), 'usage in=0 out=1');
  assert.match(formatEvent({ type: 'message', text: 'x'.repeat(200) }), /x{10}/);
});
