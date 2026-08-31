import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config.ts';
import { validateAgents } from '../src/core/agent-config.ts';

test('loadConfig requires an explicit v3 version', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-config-version-'));
  try {
    mkdirSync(join(repo, '.agent-team'));
    writeFileSync(join(repo, '.agent-team', 'config.yml'), 'workspace: {}\nretry: {}\nstatus: {}\n');
    assert.throws(() => loadConfig(repo), /must declare version: 3/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('validateAgents ignores unassigned roles', () => {
  const result = validateAgents({
    defaultAgent: 'worker',
    agents: { worker: { backend: 'claude' } },
    roles: { worker: '' }
  });
  assert.equal(result.ok, true);
});
