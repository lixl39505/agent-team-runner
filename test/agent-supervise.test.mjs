import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAgent } from '../src/agent/supervise.ts';
import { FakeBackend } from '../src/agent/fake.ts';

function spec(overrides = {}) {
  return {
    role: 'lead',
    cwd: process.cwd(),
    prompt: 'demo',
    schema: { type: 'object' },
    access: 'read-only',
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

test('runAgent rejects a success that arrives after a hard timeout', async () => {
  const { logPath, outputPath } = paths();
  let interrupted = false;
  const backend = new FakeBackend();
  backend.openSession = async () => {
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const lateSuccess = () => resolveCompletion({ ok: true, output: { done: true }, timedOut: false, stalled: false });
    const fallback = setTimeout(lateSuccess, 200);
    return {
      async interrupt() { interrupted = true; clearTimeout(fallback); lateSuccess(); },
      async close() {},
      completion() { return completion; }
    };
  };

  const outcome = await runAgent({
    backend,
    spec: spec({ timeoutMs: 40, staleAfterMs: 5_000 }),
    logPath,
    outputPath
  });

  assert.equal(interrupted, true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.output, null);
  assert.equal(outcome.timedOut, true);
  assert.match(outcome.error, /timeout/);
  assert.equal(existsSync(outputPath), false);
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

test('runAgent excludes approval waits from hard and stale timeouts', async () => {
  const { logPath, outputPath } = paths();
  let resolveApproval;
  const approval = new Promise((resolve) => { resolveApproval = resolve; });
  const backend = new FakeBackend();
  backend.openSession = async (sessionSpec) => {
    let interrupted = false;
    const completion = (async () => {
      await sessionSpec.requestApproval({
        backend: 'claude', role: 'lead', cwd: sessionSpec.cwd,
        kind: 'command', tool: 'Bash', input: { command: 'npm test' }, allowSession: true
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      return interrupted
        ? { ok: false, output: null, error: 'interrupted', timedOut: false, stalled: false }
        : { ok: true, output: { done: true }, timedOut: false, stalled: false };
    })();
    return {
      async interrupt() { interrupted = true; },
      async close() {},
      completion() { return completion; }
    };
  };
  const running = runAgent({
    backend,
    spec: spec({ timeoutMs: 80, staleAfterMs: 60, requestApproval: async () => await approval }),
    logPath,
    outputPath
  });
  await new Promise((resolve) => setTimeout(resolve, 140));
  resolveApproval('once');
  const outcome = await running;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.stalled, false);
  assert.match(readFileSync(logPath, 'utf8'), /\[interaction\] resumed/);
});

test('runAgent excludes user-question waits from hard and stale timeouts', async () => {
  const { logPath, outputPath } = paths();
  let resolveAnswer;
  const answer = new Promise((resolve) => { resolveAnswer = resolve; });
  const backend = new FakeBackend();
  backend.openSession = async (sessionSpec) => {
    const completion = (async () => {
      await sessionSpec.requestUserInput({
        backend: 'claude', role: 'lead', cwd: sessionSpec.cwd,
        questions: [{ id: 'one', question: 'Which approach?' }]
      });
      return { ok: true, output: { done: true }, timedOut: false, stalled: false };
    })();
    return { async interrupt() {}, async close() {}, completion() { return completion; } };
  };
  const running = runAgent({
    backend,
    spec: spec({ timeoutMs: 80, staleAfterMs: 60, requestUserInput: async () => await answer }),
    logPath,
    outputPath
  });
  await new Promise((resolve) => setTimeout(resolve, 140));
  resolveAnswer({ one: ['A'] });
  const outcome = await running;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.stalled, false);
});
