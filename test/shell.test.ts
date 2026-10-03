import { describe, expect, test } from 'bun:test';
import { assertCommandAllowed, runArgv, runCommand, splitCommand } from '../src/core/shell.ts';

describe('splitCommand', () => {
  test('basic tokens', () => {
    expect(splitCommand('bun test src/x.ts')).toEqual(['bun', 'test', 'src/x.ts']);
  });

  test('quoted tokens with spaces', () => {
    expect(splitCommand('npm run "my script" --silent')).toEqual(['npm', 'run', 'my script', '--silent']);
  });

  test('single quotes and escaped quotes', () => {
    expect(splitCommand(`echo 'a b' "c\\"d"`)).toEqual(['echo', 'a b', 'c"d']);
  });

  test('unterminated quote throws', () => {
    expect(() => splitCommand('echo "oops')).toThrow(/unterminated/);
  });
});

describe('assertCommandAllowed', () => {
  const allowlist = ['bun', 'npm *', 'git status', 'cargo *'];

  test('bare executable entry', () => {
    expect(() => assertCommandAllowed('bun test', allowlist)).not.toThrow();
  });

  test('wildcard prefix entry', () => {
    expect(() => assertCommandAllowed('npm run build --silent', allowlist)).not.toThrow();
  });

  test('exact multi-token entry', () => {
    expect(() => assertCommandAllowed('git status --short', allowlist)).not.toThrow();
    expect(() => assertCommandAllowed('git push origin main', allowlist)).toThrow(/not allowed/);
  });

  test('unknown command rejected', () => {
    expect(() => assertCommandAllowed('curl http://evil', allowlist)).toThrow(/not allowed/);
    expect(() => assertCommandAllowed('', allowlist)).toThrow(/empty/);
  });
});

describe('runArgv / runCommand', () => {
  test('captures stdout', async () => {
    const res = await runArgv(['git', '--version']);
    expect(res.ok).toBe(true);
    expect(res.stdout).toMatch(/^git version/);
  });

  test('nonzero exit is reported', async () => {
    const res = await runArgv(['git', 'definitely-not-a-command']);
    expect(res.ok).toBe(false);
  });

  test('runCommand tokenizes and checks allowlist', async () => {
    const res = await runCommand('git --version', { allowlist: ['git'] });
    expect(res.ok).toBe(true);
    await expect(runCommand('curl example.com', { allowlist: ['git'] })).rejects.toThrow(/not allowed/);
  });

  test('timeout kills the process', async () => {
    if (process.platform === 'win32') {
      // sleep is a cmd builtin; use bun itself to block
      const res = await runArgv([process.execPath, '-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 300 });
      expect(res.ok).toBe(false);
      expect(res.timedOut).toBe(true);
    } else {
      const res = await runArgv(['sleep', '60'], { timeoutMs: 300 });
      expect(res.ok).toBe(false);
      expect(res.timedOut).toBe(true);
    }
  });
});
