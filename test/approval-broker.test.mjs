import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalQueue } from '../dist/agent/approval.js';

function request(label, allowSession = true) {
  return {
    backend: 'codex', role: 'worker', label, cwd: '/repo',
    kind: 'command', tool: 'Bash', input: { command: 'npm test' }, allowSession
  };
}

test('ApprovalQueue serializes concurrent requests in FIFO order', async () => {
  const asked = [];
  const pending = [];
  const queue = new ApprovalQueue(
    async (prompt) => await new Promise((resolve) => { asked.push(prompt); pending.push(resolve); }),
    () => {}
  );
  const first = queue.request(request('first'));
  const second = queue.request(request('second'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(asked.length, 1);
  pending.shift()('o');
  assert.equal(await first, 'once');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(asked.length, 2);
  pending.shift()('s');
  assert.equal(await second, 'session');
});

test('ApprovalQueue retries invalid choices and omits session when unavailable', async () => {
  const answers = ['s', 'wat', 'd'];
  const output = [];
  const queue = new ApprovalQueue(async () => answers.shift(), (text) => output.push(text));
  assert.equal(await queue.request(request('no-session', false)), 'deny');
  assert.ok(output.join('').includes('Enter o, d'));
});

test('ApprovalQueue does not prompt an already aborted request', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  let prompted = false;
  const queue = new ApprovalQueue(async () => { prompted = true; return 'o'; }, () => {});
  await assert.rejects(queue.request(request('aborted'), controller.signal), /cancelled/);
  assert.equal(prompted, false);
});

test('ApprovalQueue cancels a queued request without breaking FIFO ownership', async () => {
  const asked = [];
  const pending = [];
  const queue = new ApprovalQueue(
    async () => await new Promise((resolve) => { asked.push('asked'); pending.push(resolve); }),
    () => {}
  );
  const first = queue.request(request('first'));
  const controller = new AbortController();
  const second = queue.request(request('second'), controller.signal);
  const third = queue.request(request('third'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(new Error('session closed'));
  await assert.rejects(second, /session closed/);
  assert.equal(asked.length, 1);
  pending.shift()('o');
  assert.equal(await first, 'once');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(asked.length, 2, 'aborted second request was skipped before the third prompt');
  pending.shift()('d');
  assert.equal(await third, 'deny');
});
