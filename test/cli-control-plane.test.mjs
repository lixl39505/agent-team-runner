import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

vi.mock('../src/daemon-cli.ts', () => ({ runDaemonCli: vi.fn() }));
vi.mock('../src/mcp-cli.ts', () => ({ runMcpCli: vi.fn() }));

const { runDaemonCli } = await import('../src/daemon-cli.ts');
const { runMcpCli } = await import('../src/mcp-cli.ts');
const { runCli } = await import('../src/cli.ts');

test('runCli delegates control-plane commands without parsing their arguments', async () => {
  runDaemonCli.mockClear();
  runMcpCli.mockClear();

  await runCli(['start', '--home', '/tmp/daemon', '-c', 'roles.lead=codex']);
  await runCli(['mcp', '--home', '/tmp/mcp', '--unknown']);

  assert.deepEqual(runDaemonCli.mock.calls, [[['--home', '/tmp/daemon', '-c', 'roles.lead=codex']]]);
  assert.deepEqual(runMcpCli.mock.calls, [[['--home', '/tmp/mcp', '--unknown']]]);
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
});
