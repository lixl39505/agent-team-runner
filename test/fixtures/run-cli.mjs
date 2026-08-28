import { runCli } from '../../src/cli.ts';
import { vi } from 'vitest';

export async function runCliCommand(args, { cwd } = {}) {
  const stdout = [];
  const stderr = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value = '') => stdout.push(String(value)));
  const error = vi.spyOn(console, 'error').mockImplementation((value = '') => stderr.push(String(value)));
  const currentDirectory = cwd === undefined ? undefined : vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  try {
    await runCli(args);
    return { status: 0, stdout: stdout.length === 0 ? '' : `${stdout.join('\n')}\n`, stderr: stderr.join('\n') };
  } catch (failure) {
    console.error(failure instanceof Error ? failure.message : String(failure));
    return { status: 1, stdout: stdout.length === 0 ? '' : `${stdout.join('\n')}\n`, stderr: stderr.join('\n') };
  } finally {
    currentDirectory?.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }
}
