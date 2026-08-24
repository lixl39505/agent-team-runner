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

test('bare directory patterns match their subtree (lead-friendly semantics)', async () => {
  const { checkPaths } = await import('../dist/core/path-policy.js');
  // 裸目录名 'src' → 匹配子树；'package.json'（含点）→ 仅匹配自身
  const verdict = checkPaths(['src/a.ts', 'src/deep/b.ts', 'package.json', 'test/x.test.ts'], ['src', 'package.json'], []);
  assert.deepEqual(verdict.invalid, ['test/x.test.ts']);
  // blocked 对称适用
  const blocked = checkPaths(['src/secret.ts'], ['src/**'], ['src/secret.ts']);
  assert.deepEqual(blocked.blocked, ['src/secret.ts']);
});
