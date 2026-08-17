import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile, resolveRole, resolveRoleWithSnapshot, snapshotRoles, validateProfiles } from '../dist/core/profiles.js';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { StateDatabase } from '../dist/core/db.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function configWith(patch) {
  return structuredClone({ ...DEFAULT_CONFIG, ...patch });
}

test('parses cli.model profiles at the first dot', () => {
  const config = configWith({});
  const profile = parseProfile('codex.gpt-5.6-terra', config);
  assert.equal(profile.cli, 'codex');
  assert.equal(profile.model, 'gpt-5.6-terra');

  const slash = parseProfile('opencode.deepseek/v4-flash', config);
  assert.equal(slash.cli, 'opencode');
  assert.equal(slash.model, 'deepseek/v4-flash');
});

test('resolves model aliases from the models table', () => {
  const config = configWith({ models: { terra: 'gpt-5.6-terra' } });
  const profile = parseProfile('codex.terra', config);
  assert.equal(profile.cli, 'codex');
  assert.equal(profile.model, 'gpt-5.6-terra');
  // 未命中别名的短名按字面量使用
  assert.equal(parseProfile('codex.unknown', config).model, 'unknown');
});

test('rejects invalid profiles', () => {
  const config = configWith({});
  assert.throws(() => parseProfile('badcli.foo', config), /unknown cli/);
  assert.throws(() => parseProfile('codex', config), /expected format/);
  assert.throws(() => parseProfile('codex.', config), /model part is empty/);
});

test('resolves roles with fallback to defaultAdapter', () => {
  const config = configWith({
    models: { glm52: 'z-ai/glm-5.2' },
    roles: { reviewer: 'opencode.glm52' }
  });
  assert.equal(resolveRole('reviewer', config).model, 'z-ai/glm-5.2');
  // 未配置的角色回退 defaultAdapter + adapters.<cli>.model
  const fallback = resolveRole('worker', config);
  assert.equal(fallback.cli, config.defaultAdapter);
  assert.equal(fallback.model, config.adapters[config.defaultAdapter].model);
});

test('validateProfiles reports role syntax errors', () => {
  const bad = configWith({ roles: { lead: 'nope.foo' } });
  assert.equal(validateProfiles(bad).ok, false);
  assert.match(validateProfiles(bad).errors[0], /roles\.lead/);

  const good = configWith({
    models: { terra: 'gpt-5.6-terra' },
    roles: { lead: 'codex.terra', worker: 'opencode.deepseek/v4-flash' }
  });
  assert.equal(validateProfiles(good).ok, true);
});

test('snapshotRoles covers all four roles', () => {
  const snapshot = snapshotRoles(configWith({}));
  assert.deepEqual(Object.keys(snapshot).sort(), ['integrator', 'lead', 'reviewer', 'worker']);
});

test('resolveRoleWithSnapshot prefers the persisted snapshot', () => {
  const config = configWith({ roles: { lead: 'codex.gpt-5.6-terra' } });
  const snapshot = JSON.stringify(snapshotRoles(config));

  // 配置文件后来改了，快照仍然生效
  const changed = configWith({ roles: { lead: 'claude.sonnet-5' } });
  assert.equal(resolveRoleWithSnapshot('lead', changed, snapshot).model, 'gpt-5.6-terra');
  // 无快照时回退当前配置
  assert.equal(resolveRoleWithSnapshot('lead', changed, null).model, 'sonnet-5');
});

test('runs table persists roles_json snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-profiles-'));
  const db = new StateDatabase(join(dir, 'state.sqlite'));
  db.createRun({ id: 'demo', repoRoot: dir, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'abc', adapter: 'claude' });
  assert.equal(db.getRun('demo').rolesJson, null);
  db.updateRun('demo', { rolesJson: JSON.stringify(snapshotRoles(configWith({}))) });
  const parsed = JSON.parse(db.getRun('demo').rolesJson);
  assert.deepEqual(Object.keys(parsed).sort(), ['integrator', 'lead', 'reviewer', 'worker']);
  db.close();
});
