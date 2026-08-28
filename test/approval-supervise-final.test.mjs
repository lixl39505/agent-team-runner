import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { ApprovalQueue, TerminalApprovalBroker } from '../src/agent/approval.ts';
import { killProcessTree } from '../src/agent/process-tree.ts';
import { runAgent } from '../src/agent/supervise.ts';

function approvalRequest(overrides = {}) {
  return {
    backend: 'codex',
    role: 'worker',
    cwd: '/repo',
    kind: 'command',
    tool: 'Bash',
    input: { command: 'npm test' },
    allowSession: true,
    ...overrides
  };
}

function runPaths() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-approval-final-'));
  return { logPath: join(directory, 'agent.log'), outputPath: join(directory, 'result.json') };
}

function sessionSpec(overrides = {}) {
  return {
    role: 'lead',
    cwd: '/repo',
    prompt: 'test',
    schema: { type: 'object' },
    access: 'read-only',
    timeoutMs: 1,
    staleAfterMs: 1,
    ...overrides
  };
}

test('ApprovalQueue validates question boundaries and preserves selected labels', async () => {
  const answers = ['', '1, two, 9', '1,, TWO', 'free-form'];
  const output = [];
  const queue = new ApprovalQueue(async () => answers.shift(), (text) => output.push(text));

  assert.deepEqual(await queue.requestUserInput({
    backend: 'claude',
    role: 'lead',
    cwd: '/repo',
    questions: [
      {
        id: 'many',
        question: 'Pick choices',
        multiple: true,
        options: [{ label: 'One' }, { label: 'Two' }]
      },
      { id: 'free', question: 'Explain' }
    ]
  }), { many: ['One', 'Two'], free: ['free-form'] });

  assert.match(output.join(''), /Enter an answer/);
  assert.match(output.join(''), /one or more valid numbers separated by commas/);
});

test('ApprovalQueue formats string, unserializable, and truncated inputs safely', async () => {
  const output = [];
  const answers = ['o', 'o', 'o'];
  const queue = new ApprovalQueue(async () => answers.shift(), (text) => output.push(text));
  const circular = {};
  circular.self = circular;

  await queue.request(approvalRequest({ input: 'plain command' }));
  await queue.request(approvalRequest({ input: circular }));
  await queue.request(approvalRequest({ input: { text: 'x'.repeat(4_100) } }));

  const text = output.join('');
  assert.match(text, /plain command/);
  assert.match(text, /\[object Object\]/);
  assert.match(text, /\n\.\.\.\n/);
  assert.equal(text.includes('x'.repeat(4_001)), false, 'long JSON input is capped at 4KB');
});

test('TerminalApprovalBroker reads approvals and questions from terminal streams', async () => {
  const input = new PassThrough();
  let output = '';
  const terminalOutput = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  const broker = new TerminalApprovalBroker(input, terminalOutput);
  try {
    const approval = broker.request(approvalRequest());
    await new Promise((resolve) => setImmediate(resolve));
    input.write('o\n');
    assert.equal(await approval, 'once');

    const question = broker.requestUserInput({
      backend: 'opencode',
      role: 'reviewer',
      cwd: '/repo',
      questions: [{ id: 'note', question: 'Leave a note' }]
    });
    await new Promise((resolve) => setImmediate(resolve));
    input.write('looks good\n');
    assert.deepEqual(await question, { note: ['looks good'] });
    assert.match(output, /\[Approval\]/);
    assert.match(output, /\[Question\]/);
  } finally {
    broker.close();
  }
});

test('runAgent force-closes a transport that ignores its interrupt without waiting for grace', async () => {
  const { logPath, outputPath } = runPaths();
  const originalNow = Date.now;
  const originalInterval = global.setInterval;
  const originalTimeout = global.setTimeout;
  let now = 0;
  let closeCalls = 0;
  let interruptCalls = 0;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });

  Date.now = () => now;
  global.setInterval = (callback) => {
    queueMicrotask(() => {
      now = 2;
      callback();
    });
    return {};
  };
  global.setTimeout = (callback, delay, ...args) => {
    assert.equal(delay, 15_000);
    callback(...args);
    return {};
  };

  try {
    const outcome = await runAgent({
      backend: {
        id: 'claude',
        capabilities: { maxTurns: false, resumeSession: false },
        async discover() {},
        async listModels() { return []; },
        async probe() { return { ok: true }; },
        async openSession() {
          return {
            async interrupt() { interruptCalls += 1; },
            async close() {
              closeCalls += 1;
              resolveCompletion({ ok: false, output: null, timedOut: false, stalled: false });
            },
            completion: () => completion
          };
        }
      },
      spec: sessionSpec(),
      logPath,
      outputPath
    });

    assert.equal(interruptCalls, 1);
    assert.equal(closeCalls, 2, 'grace expiry and normal cleanup each close the session');
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.ok, false);
    assert.equal(existsSync(outputPath), false);
    assert.match(readFileSync(logPath, 'utf8'), /grace expired, closing transport/);
  } finally {
    Date.now = originalNow;
    global.setInterval = originalInterval;
    global.setTimeout = originalTimeout;
  }
});

test('killProcessTree covers Windows taskkill success and fallback paths', () => {
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const originalSpawn = childProcess.spawn;
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const calls = [];
  let taskkillError;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    childProcess.spawn = (command, args, options) => {
      calls.push([command, args, options]);
      return {
        once(event, listener) {
          assert.equal(event, 'error');
          taskkillError = listener;
        },
        unref() { calls.push('unref'); }
      };
    };
    syncBuiltinESMExports();

    const childSignals = [];
    killProcessTree({ pid: 12_345, kill(signal) { childSignals.push(signal); } }, 'SIGTERM');
    assert.deepEqual(calls, [['taskkill.exe', ['/PID', '12345', '/T', '/F'], { stdio: 'ignore', windowsHide: true }], 'unref']);
    taskkillError();
    assert.deepEqual(childSignals, ['SIGTERM']);
    assert.doesNotThrow(() => {
      killProcessTree({ pid: 12_346, kill() { throw new Error('already exited'); } }, 'SIGTERM');
      taskkillError();
    });

    childProcess.spawn = () => { throw new Error('taskkill unavailable'); };
    syncBuiltinESMExports();
    const fallbackSignals = [];
    killProcessTree({ pid: 99, kill(signal) { fallbackSignals.push(signal); } }, 'SIGKILL');
    assert.deepEqual(fallbackSignals, ['SIGKILL']);
    assert.doesNotThrow(() => killProcessTree({ pid: 100, kill() { throw new Error('already exited'); } }, 'SIGTERM'));
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', descriptor);
  }
});
