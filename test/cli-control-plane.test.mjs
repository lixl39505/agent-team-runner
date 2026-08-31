import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

vi.mock('../src/daemon-cli.ts', () => ({ runDaemonCli: vi.fn() }));
vi.mock('../src/mcp-cli.ts', () => ({ runMcpCli: vi.fn() }));
vi.mock('../src/attach-cli.ts', () => ({ runAttachCli: vi.fn() }));

const { runDaemonCli } = await import('../src/daemon-cli.ts');
const { runMcpCli } = await import('../src/mcp-cli.ts');
const { runAttachCli } = await import('../src/attach-cli.ts');
const { runCli } = await import('../src/cli.ts');

test('runCli delegates control-plane commands without parsing their arguments', async () => {
  runDaemonCli.mockClear();
  runMcpCli.mockClear();
  runAttachCli.mockClear();

  await runCli(['start', '--home', '/tmp/daemon', '-c', 'roles.worker=codex']);
  await runCli(['mcp', '--home', '/tmp/mcp', '--unknown']);
  await runCli(['attach', 'run-1', '--home', '/tmp/attach']);

  assert.deepEqual(runDaemonCli.mock.calls, [[['--home', '/tmp/daemon', '-c', 'roles.worker=codex']]]);
  assert.deepEqual(runMcpCli.mock.calls, [[['--home', '/tmp/mcp', '--unknown']]]);
  assert.deepEqual(runAttachCli.mock.calls, [[['run-1', '--home', '/tmp/attach']]]);
});

test('runCli clears control-plane arguments between invocations and documents the commands', async () => {
  const output = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value = '') => output.push(String(value)));
  try {
    await runCli(['start', '--home', '/tmp/daemon']);
    await runCli(['help']);
  } finally {
    log.mockRestore();
  }

  assert.match(output.join('\n'), /start \[--home PATH\]/);
    assert.match(output.join('\n'), /mcp \[--home PATH\]/);
    assert.match(output.join('\n'), /attach <run-id> \[--home PATH\]/);
});
