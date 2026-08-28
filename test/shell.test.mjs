import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { assertAllowedCommand, runCommand, splitCommand } from '../src/core/shell.ts';

const spawn = vi.hoisted(() => vi.fn());

vi.mock('cross-spawn', () => ({ default: spawn }));

test('splits quoted command arguments', () => {
  assert.deepEqual(splitCommand('pnpm test "order export"'), ['pnpm', 'test', 'order export']);
});

test('preserves Windows paths and quoted executable paths', () => {
  assert.deepEqual(
    splitCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\work dir\\check.js" C:\\repo\\src', 'win32'),
    ['C:\\Program Files\\nodejs\\node.exe', 'C:\\work dir\\check.js', 'C:\\repo\\src']
  );
  assert.doesNotThrow(() => assertAllowedCommand('C:\\tools\\pnpm.cmd test', ['C:\\tools\\pnpm.cmd test'], 'win32'));
  assert.throws(() => splitCommand('pnpm test ^& del C:\\repo', 'win32'), /Unsafe/);
});

test('rejects shell operators and unlisted commands', () => {
  assert.throws(() => splitCommand('pnpm test && rm -rf /'), /Unsafe/);
  assert.throws(() => splitCommand('echo $(whoami)'), /Unsafe/);
  assert.throws(() => assertAllowedCommand('node destructive.js', ['pnpm test']), /allowlisted/);
  assert.doesNotThrow(() => assertAllowedCommand('pnpm test order', ['pnpm test']));
});

test('handles escapes, Windows quote escaping, and empty parser states', () => {
  assert.deepEqual(splitCommand('pnpm test escaped\\ space'), ['pnpm', 'test', 'escaped space']);
  assert.deepEqual(splitCommand(String.raw`echo '\path'`), ['echo', '\\path']);
  assert.deepEqual(splitCommand(String.raw`"say \"hi\""`, 'win32'), ['say "hi"']);
  assert.deepEqual(splitCommand(String.raw`"path\\"`, 'win32'), ['path\\']);
  assert.deepEqual(splitCommand('  pnpm    test '), ['pnpm', 'test']);
  assert.throws(() => splitCommand("pnpm 'test"), /Unclosed quote/);
  assert.throws(() => splitCommand('pnpm test\\'), /Unclosed quote/);
  assert.throws(() => splitCommand('   '), /Command is empty/);
});

test('rejects capability-bearing arguments on otherwise allowed commands', () => {
  const cases = [
    ['git diff --output=outside.txt HEAD', ['git diff']],
    ['git diff --ext-diff HEAD', ['git diff']],
    ['git show --show-signature HEAD', ['git show']],
    ["rg --pre 'sh payload.sh' needle .", ['rg']],
    ['find src -delete', ['find']],
    ['find src -exec rm {} +', ['find']],
    ['sort input -o outside.txt', ['sort']],
    ['sort input -ooutside.txt', ['sort']],
    ['npm test --prefix ../outside', ['npm test']],
    ['pnpm test --dir ../outside', ['pnpm test']],
    ['yarn test --cwd ../outside', ['yarn test']],
    ['go test -exec ./wrapper ./...', ['go test']],
    ['go test -C ../outside ./...', ['go test']],
    ['bun test --preload ./payload.ts', ['bun test']],
    ['bun test --cwd ../outside', ['bun test']],
    ['cargo test --target-dir ../outside', ['cargo test']],
    ['make test -f ../payload.mk', ['make test']]
  ];
  for (const [command, prefixes] of cases) {
    assert.throws(() => assertAllowedCommand(command, prefixes), /Unsafe command arguments/, command);
  }
});

test('allows non-escalating arguments', () => {
  assert.doesNotThrow(() => assertAllowedCommand('git', ['git']));
  assert.doesNotThrow(() => assertAllowedCommand('git status --porcelain', ['git status']));
  assert.doesNotThrow(() => assertAllowedCommand('rg TODO src', ['rg']));
  assert.doesNotThrow(() => assertAllowedCommand('go test ./...', ['go test']));
});

test('runs commands through the isolated environment and handles spawn lifecycles', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  spawn.mockReturnValueOnce(child);

  const lines = [];
  const result = runCommand('node --version', process.cwd(), (line) => lines.push(line));
  child.stdout.emit('data', Buffer.from('stdout'));
  child.stderr.emit('data', Buffer.from('stderr'));
  child.emit('close', 0);

  assert.equal(await result, 0);
  assert.deepEqual(lines, ['stdout', 'stderr']);
  const home = spawn.mock.calls[0][2].env.HOME;
  assert.equal(existsSync(home), false);

  const signalChild = new EventEmitter();
  signalChild.stdout = new EventEmitter();
  signalChild.stderr = new EventEmitter();
  spawn.mockReturnValueOnce(signalChild);
  const signalResult = runCommand('node --version', process.cwd());
  signalChild.emit('close', null);
  assert.equal(await signalResult, 1);

  const failedChild = new EventEmitter();
  failedChild.stdout = new EventEmitter();
  failedChild.stderr = new EventEmitter();
  spawn.mockReturnValueOnce(failedChild);
  const failure = runCommand('node --version', process.cwd());
  const failedHome = spawn.mock.calls[2][2].env.HOME;
  failedChild.emit('error', new Error('spawn failed'));
  await assert.rejects(failure, /spawn failed/);
  assert.equal(existsSync(failedHome), false);
});
