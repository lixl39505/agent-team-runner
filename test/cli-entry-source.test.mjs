import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';
import { formatCliError } from '../src/cli.ts';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('CLI entry only runs when imported as the process main module', async () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    process.argv = [];
    await import('../src/cli.ts?module');

    process.argv = [process.execPath, cliPath, 'unknown-command'];
    await import('../src/cli.ts?main');
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(String(error.mock.calls.at(-1)?.[0]), /Unknown command/);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    error.mockRestore();
  }
});

test('formatCliError preserves Error messages and non-Error failures', () => {
  const withoutStack = new Error('message only');
  withoutStack.stack = undefined;
  assert.equal(formatCliError(withoutStack), 'message only');
  assert.equal(formatCliError('string failure'), 'string failure');
});
