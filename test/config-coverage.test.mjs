import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { loadConfig } from '../src/core/config.ts';

function repository(config) {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-config-coverage-'));
  const directory = join(root, '.agent-team');
  mkdirSync(directory);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ version: 3, workspace: {}, retry: {}, status: {}, ...config }));
  return root;
}

test('loadConfig normalizes invalid defaults and handles an empty custom registry', () => {
  const invalidDefault = repository({ defaultAgent: 7 });
  const emptyRegistry = repository({ agents: {} });
  try {
    assert.equal(loadConfig(invalidDefault).defaultAgent, 'default-claude');
    assert.equal(loadConfig(emptyRegistry).defaultAgent, 'default-claude');
  } finally {
    rmSync(invalidDefault, { recursive: true, force: true });
    rmSync(emptyRegistry, { recursive: true, force: true });
  }
});

test('loadConfig rejects invalid native Windows sandbox policies', () => {
  const root = repository({ backends: { claude: { nativeWindowsSandbox: 'invalid' } } });
  const nullPolicy = repository({ backends: { claude: { nativeWindowsSandbox: null } } });
  try {
    assert.throws(() => loadConfig(root), /backends\.claude\.nativeWindowsSandbox/);
    assert.throws(() => loadConfig(nullPolicy), /backends\.claude\.nativeWindowsSandbox/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(nullPolicy, { recursive: true, force: true });
  }
});

test('loadConfig falls back to defaults when no config file exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-config-missing-'));
  try {
    const config = loadConfig(root);
    assert.equal(config.defaultAgent, 'default-claude');
    assert.equal(config.workspace.repoRoot, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadConfig rejects the removed roles.lead key', () => {
  const root = repository({ roles: { lead: 'default-claude' } });
  try {
    assert.throws(() => loadConfig(root), /roles\.lead has been removed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
