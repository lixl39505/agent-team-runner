import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test, vi } from 'vitest';

const calls = vi.hoisted(() => []);
vi.mock('node:child_process', () => ({
  spawn: (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('error'));
    return child;
  }
}));

const { TerminalApprovalBroker } = await import('../src/agent/approval.ts');

test('terminal approval sends the default desktop attention notification', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  output.isTTY = true;
  const broker = new TerminalApprovalBroker(input, output);
  const approval = broker.request({ backend: 'claude', role: 'worker', cwd: '/tmp', kind: 'command', tool: 'Bash', input: {}, allowSession: false });
  await new Promise((resolve) => setImmediate(resolve));
  input.write('o\n');
  assert.equal(await approval, 'once');
  assert.equal(calls[0][0], 'osascript');
  broker.close();
});

test('terminal approval emits an OSC notification outside macOS', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  output.isTTY = true;
  const broker = new TerminalApprovalBroker(input, output);
  try {
    const approval = broker.request({ backend: 'claude', role: 'worker', cwd: '/tmp', kind: 'command', tool: 'Bash', input: {}, allowSession: false });
    await new Promise((resolve) => setImmediate(resolve));
    input.write('o\n');
    assert.equal(await approval, 'once');
    assert.ok(write.mock.calls.some(([value]) => String(value).includes('\x1b]9;Approval required. Agent Team Runner needs your input.\x07')));
  } finally {
    broker.close();
    write.mockRestore();
    if (platform) Object.defineProperty(process, 'platform', platform);
  }
});
