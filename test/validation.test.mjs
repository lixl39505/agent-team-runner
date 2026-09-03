import { test } from 'vitest';
import assert from 'node:assert/strict';
import { topologicalTasks, validateExecutionContract } from '../src/core/validation.ts';

const task = (id, dependsOn = []) => ({
  id,
  title: id,
  description: `Implement ${id}`,
  dependsOn,
  allowedPaths: [`src/${id}/**`],
  blockedPaths: [],
  acceptance: ['works'],
  verificationCommands: []
});

const contract = (tasks) => ({
  version: 1,
  project: { id: 'project', repoRoot: '/repo', baseRef: 'HEAD' },
  tasks
});

test('validates and sorts an execution task DAG', () => {
  const execution = validateExecutionContract(contract([task('T002', ['T001']), task('T001')]));
  assert.deepEqual(topologicalTasks(execution.tasks).map((item) => item.id), ['T001', 'T002']);
});

test('rejects cycles and overlapping writable paths for parallel tasks', () => {
  assert.throws(() => validateExecutionContract(contract([task('T001', ['T002']), task('T002', ['T001'])])), /cycle/);
  assert.throws(() => validateExecutionContract(contract([
    { ...task('T001'), allowedPaths: ['src/api/**'] },
    { ...task('T002'), allowedPaths: ['src/api/order/**'] }
  ])), /overlap writable paths/);
  assert.doesNotThrow(() => validateExecutionContract(contract([
    { ...task('T001'), allowedPaths: ['src/api/**'] },
    { ...task('T002', ['T001']), allowedPaths: ['src/api/order/**'] }
  ])));
});

test('rejects unsafe task paths and validates registered task agents', () => {
  assert.throws(() => validateExecutionContract(contract([{ ...task('T001'), allowedPaths: ['../outside/**'] }])), /escapes the repository/);
  assert.throws(() => validateExecutionContract(contract([{ ...task('T001'), allowedPaths: ['.git/**'] }])), /may not own .git paths/);
  assert.doesNotThrow(() => validateExecutionContract(contract([{ ...task('T001'), blockedPaths: ['.git/**', 'package.json'] }])));
  const withAgent = { ...task('T001'), agent: 'heavy' };
  assert.equal(validateExecutionContract(contract([withAgent]), ['heavy']).tasks[0].agent, 'heavy');
  assert.throws(() => validateExecutionContract(contract([withAgent]), ['light']), /unknown agent "heavy"/);
  assert.throws(() => validateExecutionContract(contract([{ ...task('T001'), adapter: 'codex' }])), /removed "adapter" field/);
});
