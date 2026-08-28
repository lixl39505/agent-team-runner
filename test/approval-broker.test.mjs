import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ApprovalQueue } from '../src/agent/approval.ts';

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

test('ApprovalQueue serializes questions with approvals and returns structured answers', async () => {
  const answers = ['o', '1, 2', 'custom value'];
  const queue = new ApprovalQueue(async () => answers.shift(), () => {});
  assert.equal(await queue.request(request('approval')), 'once');
  assert.deepEqual(await queue.requestUserInput({
    backend: 'claude', role: 'worker', cwd: '/repo',
    questions: [
      {
        id: 'features', question: 'Which features?', multiple: true,
        options: [{ label: 'Auth' }, { label: 'Search' }]
      },
      {
        id: 'detail', question: 'Anything else?', options: [{ label: 'None' }], allowCustom: true
      }
    ]
  }), {
    features: ['Auth', 'Search'],
    detail: ['custom value']
  });
});

test('ApprovalQueue alerts only when an approval or question becomes active', async () => {
  const alerts = [];
  const queue = new ApprovalQueue(
    async () => 'o',
    () => {},
    (kind) => alerts.push(kind)
  );
  await queue.request(request('approval'));
  await queue.requestUserInput({
    backend: 'claude', role: 'worker', cwd: '/repo',
    questions: [{ id: 'continue', question: 'Continue?' }]
  });
  assert.deepEqual(alerts, ['approval', 'question']);
});

test('ApprovalQueue handles headings, invalid selections, custom input, and aborted active prompts', async () => {
  const answers = ['', '9', '2', 'custom', 'free text'];
  const output = [];
  const queue = new ApprovalQueue(async () => answers.shift(), (text) => output.push(text));
  assert.deepEqual(await queue.requestUserInput({
    backend: 'opencode', role: 'reviewer', label: 'review', cwd: '/repo',
    questions: [
      { id: 'choice', header: 'Pick', question: 'Choose', options: [{ label: 'One', description: 'first' }, { label: 'Two' }], allowCustom: false, secret: true },
      { id: 'custom', question: 'Custom', options: [{ label: 'Known' }], allowCustom: true },
      { id: 'free', question: 'Explain' }
    ]
  }), { choice: ['Two'], custom: ['custom'], free: ['free text'] });
  assert.match(output.join(''), /\[Question\] opencode \/ reviewer \/ review/);
  assert.match(output.join(''), /Note: this terminal input is not masked/);
  assert.match(output.join(''), /Enter an answer/);
  assert.match(output.join(''), /a valid option number/);

  const controller = new AbortController();
  const pending = new ApprovalQueue(async () => await new Promise(() => {}), () => {});
  const activeRequest = pending.request(request('active'), controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort(new Error('stopped'));
  await assert.rejects(activeRequest, /stopped/);
});
