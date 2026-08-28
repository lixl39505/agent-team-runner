import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'vitest';
import { ApprovalQueue, TerminalApprovalBroker } from '../src/agent/approval.ts';

function request(overrides = {}) {
  return {
    backend: 'codex', role: 'worker', cwd: '/repo', kind: 'command', tool: 'Bash', input: {}, allowSession: true,
    ...overrides
  };
}

test('ApprovalQueue covers pre-cancelled fallback, multiple choice prompts, and empty details', async () => {
  const signal = {
    aborted: true,
    reason: undefined,
    addEventListener() {},
    removeEventListener() {}
  };
  const queue = new ApprovalQueue(async () => 'o', () => {});
  await assert.rejects(queue.request(request(), signal), /interaction cancelled|approval cancelled/);
  await Promise.resolve();

  const answers = ['1, 2', 'o', 'o'];
  const output = [];
  const choices = new ApprovalQueue(async () => answers.shift(), (text) => output.push(text));
  assert.deepEqual(await choices.requestUserInput({
    backend: 'claude', role: 'worker', cwd: '/repo',
    questions: [{ id: 'many', question: 'Choose', multiple: true, allowCustom: false, options: [{ label: 'One' }, { label: 'Two' }] }]
  }), { many: ['One', 'Two'] });
  assert.deepEqual(await choices.requestUserInput({
    backend: 'claude', role: 'worker', cwd: '/repo',
    questions: [{ id: 'custom-many', question: 'Choose', multiple: true, allowCustom: true, options: [{ label: 'One' }] }]
  }), { 'custom-many': ['o'] });
  await choices.request(request({ description: '', input: '' }));
  assert.doesNotMatch(output.join(''), /\n\n\n/);
});

test('TerminalApprovalBroker supports default streams and signal-aware readline prompts', async () => {
  const defaults = new TerminalApprovalBroker();
  defaults.close();

  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const broker = new TerminalApprovalBroker(input, output);
  const controller = new AbortController();
  try {
    const approval = broker.request(request(), controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    input.write('o\n');
    assert.equal(await approval, 'once');
  } finally {
    broker.close();
  }
});
