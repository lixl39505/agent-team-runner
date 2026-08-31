import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { FakeBackend } from '../src/agent/fake.ts';
import { executionInfo, runTrackedAgent } from '../src/core/agent-execution.ts';

function spec(onEvent) {
  return { role: 'worker', cwd: mkdtempSync(join(tmpdir(), 'agent-execution-')), prompt: 'work', schema: {}, access: 'workspace-write', timeoutMs: 1_000, staleAfterMs: 1_000, onEvent };
}

test('tracked Agent execution persists lifecycle, session IDs, and forwarded events', async () => {
  const starts = [];
  const updates = [];
  const events = [];
  const db = { startAgentExecution: (value) => starts.push(value), updateAgentExecution: (...value) => updates.push(value) };
  const execution = executionInfo('run', 'T1-worker-1', 'worker', 'claude', '/tmp/worker.log', 'model', 'T1');
  const backend = new FakeBackend({ events: [{ type: 'session', sessionId: 'session-1' }, { type: 'message', text: 'done' }], output: { ok: true } });
  const result = await runTrackedAgent({ db, execution, onAgentEvent: (info, event) => events.push([info.agentId, event.type]), backend, spec: spec(() => {}), logPath: '/tmp/worker.log', outputPath: '/tmp/worker.json' });
  assert.equal(result.ok, true);
  assert.equal(starts[0].agentId, 'T1-worker-1');
  assert.deepEqual(events.map((entry) => entry[1]), ['activity', 'session', 'message', 'activity']);
  assert.deepEqual(updates.map((entry) => entry[2].status ?? entry[2].sessionId), ['session-1', 'completed']);
});

test('tracked execution handles minimal test doubles and failed outcomes', async () => {
  const updates = [];
  const db = { updateAgentExecution: (...value) => updates.push(value) };
  const execution = executionInfo('run', 'lead-1', 'lead', 'claude', '/tmp/lead.log');
  const backend = new FakeBackend({ error: 'failed' });
  const result = await runTrackedAgent({ db, execution, backend, spec: spec(), logPath: '/tmp/lead.log', outputPath: '/tmp/lead.json' });
  assert.equal(result.ok, false);
  assert.equal(updates.at(-1)[2].status, 'failed');
  assert.equal(executionInfo('run', 'lead-2', 'lead', 'claude', '/tmp/lead.log').taskId, undefined);
});

test('tracked execution forwards an abort signal to the supervisor', async () => {
  const controller = new AbortController();
  controller.abort();
  const backend = new FakeBackend();
  const result = await runTrackedAgent({
    db: { updateAgentExecution() {} },
    execution: executionInfo('run', 'worker-1', 'worker', 'claude', '/tmp/worker.log'),
    backend,
    spec: spec(),
    logPath: '/tmp/worker.log',
    outputPath: '/tmp/worker.json',
    signal: controller.signal
  });

  assert.equal(result.ok, false);
  assert.equal(backend.sessions.length, 0);
});
