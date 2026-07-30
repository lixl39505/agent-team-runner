import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPaths, globMatch } from '../dist/core/path-policy.js';

test('globMatch handles recursive and single-segment wildcards', () => {
  assert.equal(globMatch('apps/api/src/order/export.ts', 'apps/api/**'), true);
  assert.equal(globMatch('apps/api/src/order/export.ts', 'apps/*/src/**'), true);
  assert.equal(globMatch('apps/web/src/order.ts', 'apps/api/**'), false);
});

test('blocked paths take precedence', () => {
  const result = checkPaths(
    ['apps/api/src/order.ts', 'package.json'],
    ['apps/api/**', 'package.json'],
    ['package.json']
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocked, ['package.json']);
});
