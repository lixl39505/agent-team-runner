import { describe, expect, test } from 'bun:test';
import { compareVersions, detectCapabilities, extractMethodNames, isVersionAtLeast, parseVersion } from '../src/herdr/versions.ts';

describe('version comparison', () => {
  test('parseVersion', () => {
    expect(parseVersion('herdr 1.2.3 (abc)')).toEqual([1, 2, 3]);
    expect(parseVersion('nonsense')).toBeNull();
  });

  test('compareVersions ordering', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.8.0', '0.7.0')).toBeGreaterThan(0);
    expect(compareVersions('0.7.10', '0.7.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });

  test('isVersionAtLeast', () => {
    expect(isVersionAtLeast('0.7.0', '0.7.0')).toBe(true);
    expect(isVersionAtLeast('0.6.9', '0.7.0')).toBe(false);
  });
});

describe('capability detection', () => {
  test('extracts dotted method names recursively', () => {
    const names = extractMethodNames({
      methods: ['worktree.create', 'agent.start', 'not-a-method'],
      nested: { 'session.snapshot': { params: {} } },
    });
    expect(names.has('worktree.create')).toBe(true);
    expect(names.has('session.snapshot')).toBe(true);
    expect(names.has('not-a-method')).toBe(false);
  });

  test('detectCapabilities full matrix', () => {
    const full = {
      m: ['worktree.create', 'worktree.open', 'worktree.remove', 'agent.start', 'agent.prompt', 'agent.wait', 'agent.get',
        'session.snapshot', 'pane.report_agent', 'plugin.link', 'plugin.action.list'],
    };
    const caps = detectCapabilities(full);
    expect(caps.worktree).toBe(true);
    expect(caps.agent).toBe(true);
    expect(caps.sessionSnapshot).toBe(true);
    expect(caps.reportAgent).toBe(true);
    expect(caps.plugin).toBe(true);

    const partial = detectCapabilities({ m: ['agent.start', 'agent.prompt', 'agent.wait', 'agent.get'] });
    expect(partial.agent).toBe(true);
    expect(partial.worktree).toBe(false);
    expect(partial.sessionSnapshot).toBe(false);
  });
});
