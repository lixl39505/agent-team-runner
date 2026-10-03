import { describe, expect, test } from 'bun:test';
import { globToRegex, isPathAllowed, matchPath, normalizePath, ownershipConflict } from '../src/core/path-policy.ts';

describe('normalizePath', () => {
  test('converts separators and strips trailing slash', () => {
    expect(normalizePath('a\\b\\c/')).toBe('a/b/c');
  });
});

describe('matchPath', () => {
  test('literal pattern matches itself and descendants', () => {
    expect(matchPath('src', 'src')).toBe(true);
    expect(matchPath('src', 'src/a.ts')).toBe(true);
    expect(matchPath('src', 'srcx')).toBe(false);
    expect(matchPath('src', 'other/src')).toBe(false);
  });

  test('* stays inside one segment', () => {
    expect(matchPath('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchPath('src/*.ts', 'src/sub/a.ts')).toBe(false);
    expect(matchPath('src/*.ts', 'src/a.js')).toBe(false);
  });

  test('? matches exactly one char', () => {
    expect(matchPath('a?c', 'abc')).toBe(true);
    expect(matchPath('a?c', 'ac')).toBe(false);
  });

  test('** spans segments including zero', () => {
    expect(matchPath('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(matchPath('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(matchPath('**/x.ts', 'x.ts')).toBe(true);
    expect(matchPath('**/x.ts', 'a/b/x.ts')).toBe(true);
    expect(matchPath('src/**', 'src')).toBe(false);
    expect(matchPath('src/**', 'src/a')).toBe(true);
  });

  test('regex metachars in literals are escaped', () => {
    expect(matchPath('a(b).ts', 'a(b).ts')).toBe(true);
    expect(matchPath('a(b).ts', 'aab).ts')).toBe(false);
  });
});

describe('ownershipConflict', () => {
  test('identical patterns conflict', () => {
    expect(ownershipConflict(['src/**'], ['src/**'])).toBe(true);
  });

  test('disjoint trees do not conflict', () => {
    expect(ownershipConflict(['src/api/**'], ['src/web/**'])).toBe(false);
  });

  test('literal inside tree conflicts', () => {
    expect(ownershipConflict(['src/api/**'], ['src/api/index.ts'])).toBe(true);
  });

  test('parent literal conflicts with children', () => {
    expect(ownershipConflict(['src'], ['src/api/index.ts'])).toBe(true);
  });

  test('catch-all conflicts with anything', () => {
    expect(ownershipConflict(['**'], ['docs/a.md'])).toBe(true);
  });

  test('nested-star vs deep literal without overlap does not conflict', () => {
    expect(ownershipConflict(['src/*/*.ts'], ['src/a/b/c.ts'])).toBe(false);
  });

  test('star segment aligns with literal depth conflict', () => {
    expect(ownershipConflict(['src/*/x.ts'], ['src/a/x.ts'])).toBe(true);
  });
});

describe('isPathAllowed', () => {
  test('allowed + blocked interplay', () => {
    const task = { allowedPaths: ['src/**'], blockedPaths: ['src/generated/**'] };
    expect(isPathAllowed(task, 'src/a.ts')).toBe(true);
    expect(isPathAllowed(task, 'src/generated/a.ts')).toBe(false);
    expect(isPathAllowed(task, 'docs/a.md')).toBe(false);
  });
});
