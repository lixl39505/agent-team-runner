import { test } from 'vitest';
import assert from 'node:assert/strict';
import { validateExecutionContract, validateTaskSpec } from '../src/core/validation.ts';

function task(overrides = {}) {
  return {
    id: 'T001',
    title: 'Export orders',
    description: 'Implement the export endpoint.',
    dependsOn: [],
    allowedPaths: ['src/orders/**'],
    blockedPaths: [],
    acceptance: ['exports CSV'],
    verificationCommands: ['npm test'],
    ...overrides
  };
}

function contract(overrides = {}) {
  return {
    version: 1,
    project: { id: 'project-1', repoRoot: '/repo', baseRef: 'dev' },
    target: { integrationBranch: 'agent-team/export' },
    provenance: { documents: [{ kind: 'ticket', locator: 'opaque:42', revision: 'abc123' }] },
    tasks: [task()],
    ...overrides
  };
}

test('validates a complete external execution contract and task skill handoff', () => {
  const result = validateExecutionContract(contract({
    tasks: [task({
      externalId: 'TICKET-42',
      implementationGuidance: ['Use a red-green-refactor loop.'],
      implementationSkills: [{ name: 'tdd', role: 'worker', required: true, source: 'project' }]
    })]
  }));

  assert.deepEqual(result, contract({
    tasks: [task({
      externalId: 'TICKET-42',
      implementationGuidance: ['Use a red-green-refactor loop.'],
      implementationSkills: [{ name: 'tdd', role: 'worker', required: true, source: 'project' }]
    })]
  }));
});

test('normalizes optional contract fields and validates named agents', () => {
  const input = contract({ target: {}, tasks: [task({ agent: 'careful', implementationSkills: [] })] });
  delete input.provenance;
  assert.deepEqual(validateExecutionContract(input, ['careful']), {
    ...input,
    target: {},
    tasks: [task({ agent: 'careful', implementationSkills: [] })]
  });
  assert.throws(() => validateExecutionContract(input, ['other']), /unknown agent/);
});

test('rejects invalid contract envelopes and provenance', () => {
  assert.throws(() => validateExecutionContract(null), /must be an object/);
  assert.throws(() => validateExecutionContract(contract({ version: 2 })), /version/);
  assert.throws(() => validateExecutionContract(contract({ project: {} })), /requires id/);
  assert.throws(() => validateExecutionContract(contract({ target: { integrationBranch: '' } })), /integrationBranch/);
  assert.throws(() => validateExecutionContract(contract({ tasks: [] })), /at least one task/);
  assert.throws(() => validateExecutionContract(contract({ provenance: {} })), /documents/);
  assert.throws(() => validateExecutionContract(contract({ provenance: { documents: [{}] } })), /requires kind/);
});

test('rejects invalid task skill handoff fields', () => {
  assert.throws(() => validateTaskSpec(task({ externalId: '' }), 0), /externalId/);
  assert.throws(() => validateTaskSpec(task({ implementationGuidance: 'tdd' }), 0), /implementationGuidance/);
  assert.throws(() => validateTaskSpec(task({ implementationSkills: {} }), 0), /must be an array/);
  assert.throws(() => validateTaskSpec(task({ implementationSkills: [null] }), 0), /must be an object/);
  assert.throws(() => validateTaskSpec(task({ implementationSkills: [{ name: 'bad skill', role: 'worker', required: true, source: 'project' }] }), 0), /invalid implementation skill name/);
  assert.throws(() => validateTaskSpec(task({ implementationSkills: [{ name: 'tdd', role: 'lead', required: true, source: 'project' }] }), 0), /invalid implementation skill role/);
  assert.throws(() => validateTaskSpec(task({ implementationSkills: [{ name: 'tdd', role: 'worker', required: 'yes', source: 'project' }] }), 0), /boolean required/);
  assert.throws(() => validateTaskSpec(task({ implementationSkills: [{ name: 'tdd', role: 'worker', required: true, source: 'remote' }] }), 0), /invalid implementation skill source/);
});
