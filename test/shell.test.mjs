import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedCommand, splitCommand } from '../dist/core/shell.js';

test('splits quoted command arguments', () => {
  assert.deepEqual(splitCommand('pnpm test "order export"'), ['pnpm', 'test', 'order export']);
});

test('rejects shell operators and unlisted commands', () => {
  assert.throws(() => splitCommand('pnpm test && rm -rf /'), /Unsafe/);
  assert.throws(() => assertAllowedCommand('node destructive.js', ['pnpm test']), /allowlisted/);
  assert.doesNotThrow(() => assertAllowedCommand('pnpm test order', ['pnpm test']));
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
  assert.doesNotThrow(() => assertAllowedCommand('git status --porcelain', ['git status']));
  assert.doesNotThrow(() => assertAllowedCommand('rg TODO src', ['rg']));
  assert.doesNotThrow(() => assertAllowedCommand('go test ./...', ['go test']));
});
