import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalQueue } from '../src/agent/approval.ts';
import { killProcessTree } from '../src/agent/process-tree.ts';
import { runAgent } from '../src/agent/supervise.ts';

function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-supervise-branches-'));
  return { logPath: join(dir, 'agent.log'), outputPath: join(dir, 'result.json') };
}

function spec(overrides = {}) {
  return {
    role: 'lead',
    cwd: '/repo',
    prompt: 'test',
    schema: { type: 'object' },
    access: 'read-only',
    timeoutMs: 60_000,
    staleAfterMs: 60_000,
    ...overrides
  };
}

function backend(openSession) {
  return {
    id: 'claude',
    capabilities: { maxTurns: false, resumeSession: false },
    async discover() { throw new Error('not used'); },
    async listModels() { throw new Error('not used'); },
    async probe() { throw new Error('not used'); },
    openSession
  };
}

function approvalRequest(overrides = {}) {
  return {
    backend: 'codex',
    role: 'worker',
    label: 'feature',
    cwd: '/repo',
    kind: 'command',
    tool: 'Bash',
    input: { command: 'npm test' },
    allowSession: true,
    ...overrides
  };
}

test('runAgent merges backend timeout and stall terminal flags', async () => {
  const { logPath, outputPath } = paths();
  const outcome = await runAgent({
    backend: backend(async () => ({
      async interrupt() {},
      async close() {},
      completion: async () => ({ ok: true, output: { ignored: true }, timedOut: true, stalled: true })
    })),
    spec: spec(),
    logPath,
    outputPath
  });

  assert.deepEqual(outcome, { ok: false, output: null, timedOut: true, stalled: true });
  assert.equal(existsSync(outputPath), false);
});

test('runAgent resumes its clock only after nested interactions finish', async () => {
  const { logPath, outputPath } = paths();
  let resolveApproval;
  let resolveInput;
  let interactionsStarted;
  const started = new Promise((resolve) => { interactionsStarted = resolve; });
  const approval = new Promise((resolve) => { resolveApproval = resolve; });
  const input = new Promise((resolve) => { resolveInput = resolve; });
  const agent = backend(async (sessionSpec) => {
    const completion = (async () => {
      const waitingForApproval = sessionSpec.requestApproval(approvalRequest());
      const waitingForInput = sessionSpec.requestUserInput({
        backend: 'claude', role: 'lead', cwd: '/repo', questions: [{ id: 'answer', question: 'Continue?' }]
      });
      interactionsStarted();
      await waitingForApproval;
      await waitingForInput;
      return { ok: true, output: { complete: true }, timedOut: false, stalled: false };
    })();
    return { async interrupt() {}, async close() {}, completion: () => completion };
  });

  const running = runAgent({
    backend: agent,
    spec: spec({ requestApproval: async () => await approval, requestUserInput: async () => await input }),
    logPath,
    outputPath
  });
  await started;
  resolveApproval('once');
  await Promise.resolve();
  assert.doesNotMatch(readFileSync(logPath, 'utf8'), /\[interaction\] resumed/);
  resolveInput({ answer: ['yes'] });

  assert.equal((await running).ok, true);
  assert.equal((readFileSync(logPath, 'utf8').match(/\[interaction\] resumed/g) ?? []).length, 1);
});

test('ApprovalQueue formats approvals and accepts decision aliases', async () => {
  const output = [];
  const answers = ['once', 'always', 'reject'];
  const queue = new ApprovalQueue(async () => answers.shift(), (text) => output.push(text));

  assert.equal(await queue.request(approvalRequest({
    title: 'Run test suite?', description: 'Executes the unit tests.', reason: 'Required before merge'
  })), 'once');
  assert.equal(await queue.request(approvalRequest()), 'session');
  assert.equal(await queue.request(approvalRequest()), 'deny');

  const text = output.join('');
  assert.match(text, /\[Approval\] codex \/ worker \/ feature/);
  assert.match(text, /Run test suite\?/);
  assert.match(text, /Reason: Required before merge/);
  assert.match(text, /Working directory: \/repo/);
  assert.match(text, /Executes the unit tests\./);
});

test('ApprovalQueue uses its default error when an active prompt is aborted', async () => {
  let asking;
  let abortListener;
  const asked = new Promise((resolve) => { asking = resolve; });
  const queue = new ApprovalQueue(async () => {
    asking();
    return await new Promise(() => {});
  }, () => {});
  // Native AbortController supplies an AbortError; this signal covers the no-reason fallback.
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(_event, listener) { abortListener = listener; },
    removeEventListener() {}
  };
  const pending = queue.request(approvalRequest(), signal);
  await asked;
  signal.aborted = true;
  abortListener();

  await assert.rejects(pending, /approval cancelled/);
});

test('killProcessTree ignores children without a pid', () => {
  const originalKill = process.kill;
  let calls = 0;
  try {
    process.kill = () => { calls += 1; };
    killProcessTree({ pid: undefined }, 'SIGTERM');
    assert.equal(calls, 0);
  } finally {
    process.kill = originalKill;
  }
});

const posixTest = process.platform === 'win32' ? test.skip : test;

posixTest('killProcessTree signals the POSIX process group', () => {
  const originalKill = process.kill;
  const calls = [];
  try {
    process.kill = (pid, signal) => { calls.push([pid, signal]); };
    killProcessTree({ pid: 4321 }, 'SIGKILL');
    assert.deepEqual(calls, [[-4321, 'SIGKILL']]);
  } finally {
    process.kill = originalKill;
  }
});
