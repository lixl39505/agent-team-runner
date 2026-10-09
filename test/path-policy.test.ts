import { describe, expect, test } from 'bun:test';
import { globToRegex, globsIntersect, isPathAllowed, matchPath, normalizePath, ownershipConflict } from '../src/core/path-policy.ts';

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

  // R4-02: witness sampling missed constructible overlaps — the NFA product
  // must decide these exactly.
  test('wildcard overlap hidden from fixed witnesses is detected (R4-02)', () => {
    // both match src/abc — no fixed witness pair reveals it
    expect(ownershipConflict(['src/a?c'], ['src/ab?'])).toBe(true);
    expect(globsIntersect('src/a?c', 'src/ab?')).toBe(true);
    expect(ownershipConflict(['a?c'], ['?bc'])).toBe(true);
    expect(ownershipConflict(['x?'], ['?y'])).toBe(true); // xy
  });

  test('truly disjoint wildcards do not conflict', () => {
    expect(ownershipConflict(['src/a?c'], ['src/xyz'])).toBe(false);
    expect(ownershipConflict(['a?c'], ['xy?'])).toBe(false); // a?c needs 3 chars ending c; xy? ends any
    expect(ownershipConflict(['??'], ['???'])).toBe(false); // length mismatch
    expect(ownershipConflict(['src/?'], ['src/ab'])).toBe(false);
  });

  test('star overlap is decided by first/last literal pins, not sampling', () => {
    expect(ownershipConflict(['a*c'], ['ab*'])).toBe(true); // abc
    expect(ownershipConflict(['a*c'], ['*b'])).toBe(false); // would have to end with c AND b
    expect(ownershipConflict(['a*b'], ['b*a'])).toBe(false); // first char would need to be a AND b
    expect(ownershipConflict(['*x/*'], ['*/y*'])).toBe(true); // ax/yb
  });

  test('literal directory semantics in intersection', () => {
    // literal `src` matches src/** too, so it collides with any src child
    expect(ownershipConflict(['src'], ['src/*.ts'])).toBe(true);
    expect(ownershipConflict(['src'], ['srcx/**'])).toBe(false);
    expect(ownershipConflict(['src/a'], ['src/**'])).toBe(true);
    expect(ownershipConflict(['docs'], ['doc?/**'])).toBe(true); // docs/docx both
  });

  test('globstar segment semantics in intersection', () => {
    expect(ownershipConflict(['**/x.ts'], ['a/**/x.ts'])).toBe(true);
    expect(ownershipConflict(['**/x.ts'], ['a/**/y.ts'])).toBe(false);
    expect(ownershipConflict(['src/**/a.ts'], ['src/b/**'])).toBe(true); // src/b/a.ts
    // literal src/b/c is directory-like → src/b/c/a.ts matches BOTH
    expect(ownershipConflict(['src/**/a.ts'], ['src/b/c'])).toBe(true);
    expect(ownershipConflict(['src/**/a.ts'], ['web/b/c'])).toBe(false); // disjoint prefixes
    expect(ownershipConflict(['a/**'], ['a'])).toBe(true); // literal a matches itself+below; a/** needs a child → common child a/x
  });

  test('exact witness agree with matchPath on shared samples', () => {
    // if the decider says intersect, a concrete witness must exist per matchPath
    const samples = ['a', 'a/b', 'a/b/c.ts', 'ab', 'abc', 'axb', 'ba', 'bxa', 'xy', 'src/abc', 'src/axc', 'src/abx', 'src/b/a.ts', 'src/b/c', 'docs', 'docx', 'src/a.ts'];
    const patterns = ['src/a?c', 'src/ab?', 'a?c', 'xy?', '??', '???', 'src/*', 'src/**', '**/a.ts', 'a/**', 'a', 'docs', 'doc?/**', 'src/*/a.ts'];
    for (const p1 of patterns) {
      for (const p2 of patterns) {
        const claimed = globsIntersect(p1, p2);
        const witnessed = samples.some((s) => matchPath(p1, s) && matchPath(p2, s));
        // claimed=false with a witness would be a false negative (unsound permissiveness)
        expect(claimed || !witnessed).toBe(true);
      }
    }
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
