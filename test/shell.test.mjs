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
