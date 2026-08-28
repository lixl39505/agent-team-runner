import assert from 'node:assert/strict';
import { test } from 'vitest';
import { migrateV1Fields } from '../src/core/agent-config.ts';

test('v1 migration handles omitted roles and default adapter fields', () => {
  const migrated = migrateV1Fields({ adapters: {} });
  assert.equal(migrated.defaultAgent, 'default-claude');
  assert.equal(migrated.v2Yaml.includes('roles:'), false);
});

test('v1 migration falls back to a stable slug for punctuation-only models', () => {
  const migrated = migrateV1Fields({
    defaultAdapter: 'claude',
    adapters: { claude: { model: '!!!' } }
  });
  assert.equal(migrated.defaultAgent, 'claude-model');
});
