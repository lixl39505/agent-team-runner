import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { runAgent } from '../src/agent/supervise.ts';

function paths() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-supervise-coverage-'));
  return { logPath: join(directory, 'agent.log'), outputPath: join(directory, 'result.json') };
}

function spec(overrides = {}) {
  return {
    role: 'worker', cwd: '/repo', prompt: 'test', schema: { type: 'object' }, access: 'read-only',
    timeoutMs: 10, staleAfterMs: 10, ...overrides
  };
}

test('runAgent pauses its clock for concurrent interactions and activity', async () => {
  let approve;
  let answer;
  const approval = new Promise((resolve) => { approve = resolve; });
  const input = new Promise((resolve) => { answer = resolve; });
  const outcome = await runAgent({
    backend: {
      id: 'claude', capabilities: { maxTurns: false, resumeSession: false },
      async discover() {}, async listModels() { return []; }, async probe() { return { ok: true }; },
      async openSession(wrapped) {
        return {
          async interrupt() {}, async close() {},
          completion: async () => {
            const waitingForApproval = wrapped.requestApproval({ backend: 'claude', role: 'worker', cwd: '/repo', kind: 'command', tool: 'Bash', input: {}, allowSession: false });
            const waitingForSecondApproval = wrapped.requestApproval({ backend: 'claude', role: 'worker', cwd: '/repo', kind: 'command', tool: 'Bash', input: {}, allowSession: false });
            const waitingForInput = wrapped.requestUserInput({ backend: 'claude', role: 'worker', cwd: '/repo', questions: [] });
            wrapped.onEvent?.({ type: 'activity' });
            approve('once');
            answer({});
            await waitingForApproval;
            await waitingForSecondApproval;
            await waitingForInput;
            return { ok: true, output: null, timedOut: false, stalled: false };
          }
        };
      }
    },
    spec: spec({ requestApproval: async () => await approval, requestUserInput: async () => await input }),
    ...paths()
  });
  assert.equal(outcome.ok, true);
});

test('runAgent reuses one grace timer when timeout and stall both interrupt', async () => {
  const originalNow = Date.now;
  const originalInterval = global.setInterval;
  const originalTimeout = global.setTimeout;
  let now = 0;
  let interruptCalls = 0;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  Date.now = () => now;
  global.setInterval = (callback) => {
    queueMicrotask(() => {
      now = 20;
      callback();
      now = 40;
      callback();
      resolveCompletion({ ok: false, output: null, timedOut: false, stalled: false });
    });
    return {};
  };
  global.setTimeout = () => ({});
  try {
    const outcome = await runAgent({
      backend: {
        id: 'claude', capabilities: { maxTurns: false, resumeSession: false },
        async discover() {}, async listModels() { return []; }, async probe() { return { ok: true }; },
        async openSession() { return { async interrupt() { interruptCalls += 1; }, async close() {}, completion: () => completion }; }
      },
      spec: spec(),
      ...paths()
    });
    assert.equal(interruptCalls, 2);
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.stalled, true);
  } finally {
    Date.now = originalNow;
    global.setInterval = originalInterval;
    global.setTimeout = originalTimeout;
  }
});

test('runAgent ignores rejected interrupt and grace-close cleanup', async () => {
  const originalNow = Date.now;
  const originalInterval = global.setInterval;
  const originalTimeout = global.setTimeout;
  let now = 0;
  let expireGrace;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  Date.now = () => now;
  global.setInterval = (callback) => {
    queueMicrotask(() => {
      now = 20;
      callback();
      expireGrace();
      resolveCompletion({ ok: false, output: null, timedOut: false, stalled: false });
    });
    return {};
  };
  global.setTimeout = (callback) => {
    expireGrace = callback;
    return {};
  };
  try {
    const outcome = await runAgent({
      backend: {
        id: 'claude', capabilities: { maxTurns: false, resumeSession: false },
        async discover() {}, async listModels() { return []; }, async probe() { return { ok: true }; },
        async openSession() {
          return {
            async interrupt() { throw new Error('interrupt failed'); },
            async close() { throw new Error('close failed'); },
            completion: () => completion
          };
        }
      },
      spec: spec(),
      ...paths()
    });
    assert.equal(outcome.timedOut, true);
  } finally {
    Date.now = originalNow;
    global.setInterval = originalInterval;
    global.setTimeout = originalTimeout;
  }
});
