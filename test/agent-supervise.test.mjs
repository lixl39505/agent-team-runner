import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAgent } from '../dist/agent/supervise.js';
import { FakeBackend } from '../dist/agent/fake.js';
import { readOnlyPolicy } from '../dist/core/policy.js';

function spec(overrides = {}) {
  return {
    role: 'lead',
    cwd: process.cwd(),
    prompt: 'demo',
    schema: { type: 'object' },
    policy: readOnlyPolicy(),
    timeoutMs: 5_000,
    staleAfterMs: 5_000,
    ...overrides
  };
}

function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-supervise-'));
  return { dir, logPath: join(dir, 'logs', 'a.log'), outputPath: join(dir, 'results', 'a.json') };
}

test('runAgent persists structured output and streams events', async () => {
  const { logPath, outputPath } = paths();
  const backend = new FakeBackend({
    events: [
      { type: 'message', text: 'thinking' },
      { type: 'tool-call', tool: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool-result', tool: 'Read', ok: true }
    ],
    output: { status: 'completed', summary: 'done' }
  });
  let heartbeats = 0;
  const outcome = await runAgent({
    backend,
    spec: spec({ onEvent: (event) => { if (event.type === 'activity') heartbeats += 1; } }),
    logPath,
    outputPath
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.output, { status: 'completed', summary: 'done' });
  assert.equal(outcome.timedOut, false);
  assert.equal(existsSync(outputPath), true);
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /\[event\] \{"type":"message"/);
  assert.match(log, /\[session\] structured output written/);
  assert.equal(heartbeats >= 1, true);
  assert.equal(backend.sessions[0].closeCount >= 1, true);
});

test('runAgent enforces the hard timeout', async () => {
  const { logPath, outputPath } = paths();
  const backend = new FakeBackend({ events: [{ type: 'activity' }], stepMs: 10_000 });
  const outcome = await runAgent({
    backend,
    spec: spec({ timeoutMs: 80 }),
    logPath,
    outputPath
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.timedOut, true);
  assert.match(outcome.error, /timeout/);
  assert.equal(backend.sessions[0].interruptCount >= 1, true);
});

test('runAgent detects stalls by lack of events', async () => {
  const { logPath, outputPath } = paths();
  const backend = new FakeBackend({ silent: true });
  const outcome = await runAgent({
    backend,
    spec: spec({ timeoutMs: 5_000, staleAfterMs: 120 }),
    logPath,
    outputPath
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stalled, true);
  assert.match(outcome.error, /no progress/);
});

test('runAgent surfaces transport failures', async () => {
  const { logPath, outputPath } = paths();
  const backend = new FakeBackend({ events: [{ type: 'activity' }], error: 'rpc broke' });
  const outcome = await runAgent({ backend, spec: spec(), logPath, outputPath });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /rpc broke/);
  assert.equal(backend.sessions[0].closeCount >= 1, true);
});

test('runAgent reports open-session failures without throwing', async () => {
  const { logPath, outputPath } = paths();
  const backend = new FakeBackend();
  backend.openSession = async () => { throw new Error('binary missing'); };
  const outcome = await runAgent({ backend, spec: spec(), logPath, outputPath });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /binary missing/);
});

test('runAgent breaks deny-thrash loops instead of burning context', async () => {
  const { logPath, outputPath } = paths();
  const denied = { type: 'permission-check', tool: 'Bash', input: { command: 'x' }, allowed: false };
  const granted = { type: 'permission-check', tool: 'Bash', input: { command: 'npm test' }, allowed: true };
  // 交替拒绝但以 10 连拒收尾 → 熔断
  const backend = new FakeBackend({
    events: [denied, denied, granted, denied, denied, denied, denied, denied, denied, denied, denied, denied, denied, denied],
    output: { ok: true }
  });
  const outcome = await runAgent({ backend, spec: spec({ timeoutMs: 30_000, staleAfterMs: 30_000 }), logPath, outputPath });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /policy thrash/);
  assert.equal(backend.sessions[0].interruptCount >= 1, true);
});
