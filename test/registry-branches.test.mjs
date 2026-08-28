import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildBackends,
  disposeBackends,
  parseSnapshot,
  resolveAgent,
  resolveAgentWithSnapshot,
  resolveTaskAgent,
  snapshotAgents
} from '../src/agent/registry.ts';

function config(overrides = {}) {
  return {
    defaultAgent: 'general',
    agents: {
      general: { backend: 'claude', model: 'general-model' },
      specialist: { backend: 'codex', model: 'specialist-model', maxTurns: 3 }
    },
    roles: {
      lead: 'general',
      worker: 'specialist',
      reviewer: 'general',
      integrator: 'general'
    },
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    id: 'T001',
    title: 'task',
    description: 'task',
    dependsOn: [],
    allowedPaths: ['src/**'],
    blockedPaths: [],
    acceptance: [],
    verificationCommands: [],
    ...overrides
  };
}

test('registry snapshots retain role and named-task bindings after configuration changes', () => {
  const original = config();
  const snapshot = snapshotAgents(original);
  const changed = config({
    agents: { general: { backend: 'opencode', model: 'new-model' } },
    roles: { worker: 'general' }
  });
  const rolesJson = JSON.stringify(snapshot);

  assert.equal(resolveAgentWithSnapshot('worker', changed, rolesJson).agent, 'specialist');
  const assigned = resolveTaskAgent(task({ agent: 'specialist' }), changed, rolesJson);
  assert.deepEqual(
    { agent: assigned.agent, backend: assigned.backend, model: assigned.model, maxTurns: assigned.maxTurns },
    { agent: 'specialist', backend: 'codex', model: 'specialist-model', maxTurns: 3 }
  );
});

test('registry ignores unusable snapshots and handles legacy or empty values', () => {
  const value = config();
  assert.equal(parseSnapshot(null), null);
  assert.equal(parseSnapshot(''), null);
  assert.equal(parseSnapshot('{invalid'), null);

  const legacy = parseSnapshot(JSON.stringify({
    worker: { cli: 'codex', model: 'legacy-model', source: 'old-worker' },
    reviewer: { cli: 'unsupported', model: 'ignored' }
  }));
  assert.equal(legacy.version, 2);
  assert.equal(legacy.roles.worker.agent, 'old-worker');
  assert.equal(legacy.roles.worker.backend, 'codex');
  assert.equal(legacy.roles.reviewer, undefined);

  const legacyDefaults = parseSnapshot(JSON.stringify({
    lead: { cli: 'claude' },
    worker: null,
    reviewer: 'invalid-entry',
    integrator: {}
  }));
  assert.deepEqual(legacyDefaults.roles.lead, {
    agent: 'legacy-claude', backend: 'claude', source: 'legacy-snapshot'
  });

  const invalid = JSON.stringify({ version: 2, roles: { worker: { backend: 'unsupported' } }, agents: {} });
  assert.equal(resolveAgentWithSnapshot('worker', value, invalid).agent, 'specialist');
  assert.throws(() => resolveAgent('lead', config({ agents: {}, roles: { lead: 'missing' } })), /unknown agent "missing"/);
});

test('registry instantiates backends with and without configured commands', () => {
  const defaults = buildBackends({
    backends: { claude: {}, codex: {}, opencode: {} }
  });
  const configured = buildBackends({
    backends: {
      claude: { command: 'claude-custom' },
      codex: { command: 'codex-custom' },
      opencode: { command: 'opencode-custom' }
    }
  });
  disposeBackends(defaults);
  disposeBackends(configured);
});

test('registry disposal calls available cleanup hooks without constructing SDK backends', () => {
  const disposed = [];
  disposeBackends({
    claude: { dispose: () => disposed.push('claude') },
    codex: {},
    opencode: { dispose: () => disposed.push('opencode') }
  });
  assert.deepEqual(disposed, ['claude', 'opencode']);
});
