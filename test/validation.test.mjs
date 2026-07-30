import test from 'node:test';
import assert from 'node:assert/strict';
import { topologicalTasks, validateLeadResult } from '../dist/core/validation.js';

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

test('validates and sorts a task DAG', () => {
  const manifest = validateLeadResult({
    version: 1,
    title: 'demo',
    summary: 'demo',
    tasks: [task('T002', ['T001']), task('T001')]
  });
  assert.deepEqual(topologicalTasks(manifest.tasks).map((item) => item.id), ['T001', 'T002']);
});

test('rejects cycles', () => {
  assert.throws(() => validateLeadResult({
    version: 1,
    title: 'cycle',
    summary: 'cycle',
    tasks: [task('T001', ['T002']), task('T002', ['T001'])]
  }), /cycle/);
});


test('rejects overlapping writable paths for parallel tasks', () => {
  assert.throws(() => validateLeadResult({
    version: 1,
    title: 'overlap',
    summary: 'overlap',
    tasks: [
      { ...task('T001'), allowedPaths: ['src/api/**'] },
      { ...task('T002'), allowedPaths: ['src/api/order/**'] }
    ]
  }), /overlap writable paths/);
});

test('allows overlapping writable paths when ordered by dependency', () => {
  assert.doesNotThrow(() => validateLeadResult({
    version: 1,
    title: 'ordered',
    summary: 'ordered',
    tasks: [
      { ...task('T001'), allowedPaths: ['src/api/**'] },
      { ...task('T002', ['T001']), allowedPaths: ['src/api/order/**'] }
    ]
  }));
});

test('rejects repository escaping paths', () => {
  assert.throws(() => validateLeadResult({
    version: 1,
    title: 'escape',
    summary: 'escape',
    tasks: [{ ...task('T001'), allowedPaths: ['../outside/**'] }]
  }), /escapes the repository/);
});
