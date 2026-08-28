import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  validateIntegrationResult,
  validateLeadResult,
  validateReviewResult
} from '../src/core/validation.ts';

function task(id, overrides = {}) {
  return {
    id,
    title: id,
    description: `Implement ${id}`,
    dependsOn: [],
    allowedPaths: [`src/${id}/**`],
    blockedPaths: [],
    acceptance: ['works'],
    verificationCommands: [],
    ...overrides
  };
}

function lead(tasks) {
  return { version: 1, title: 'Plan', summary: 'Summary', tasks };
}

test('covers lead result defaults and invalid task field branches', () => {
  assert.throws(() => validateLeadResult(lead([task('T001', { id: undefined })])), /Invalid task id/);
  assert.throws(() => validateLeadResult(lead([task('T001', { title: undefined })])), /requires title and description/);
  assert.throws(() => validateLeadResult(lead([task('T001', { description: undefined })])), /requires title and description/);

  const minimal = task('T001');
  delete minimal.blockedPaths;
  delete minimal.dependsOn;
  delete minimal.verificationCommands;
  assert.deepEqual(validateLeadResult(lead([minimal])).tasks[0], task('T001'));
});

test('covers graph revisits and path-overlap prefix branches', () => {
  assert.doesNotThrow(() => validateLeadResult(lead([
    task('T004'),
    task('T002', { dependsOn: ['T004'] }),
    task('T003', { dependsOn: ['T004'] }),
    task('T001', { dependsOn: ['T002', 'T003'] }),
    task('T005')
  ])));

  assert.throws(() => validateLeadResult(lead([
    task('T001', { allowedPaths: ['src/shared/**'] }),
    task('T002', { allowedPaths: ['src/shared/**'] })
  ])), /overlap writable paths/);

  assert.doesNotThrow(() => validateLeadResult(lead([
    task('T001', { allowedPaths: ['src/file.ts'] }),
    task('T002', { allowedPaths: ['lib/file.ts'] })
  ])));

  assert.doesNotThrow(() => validateLeadResult(lead([
    task('T001', { allowedPaths: ['src/*'] }),
    task('T002', { allowedPaths: ['lib/*'] })
  ])));

  assert.throws(() => validateLeadResult(lead([
    task('T001', { allowedPaths: ['*'] }),
    task('T002', { allowedPaths: ['lib/*'] })
  ])), /overlap writable paths/);
});

test('covers review and integration result fallback and rejection branches', () => {
  assert.deepEqual(validateReviewResult({ decision: 'approved' }).findings, []);
  assert.deepEqual(validateReviewResult({
    decision: 'approved',
    findings: [{ severity: 'low', file: 'file.ts' }]
  }).findings, [{ severity: 'low', file: 'file.ts', message: '' }]);
  assert.deepEqual(validateReviewResult({
    decision: 'approved',
    findings: [{ severity: 'low', file: 'file.ts', line: 1, message: 'Note' }]
  }).findings, [{ severity: 'low', file: 'file.ts', line: 1, message: 'Note' }]);
  assert.deepEqual(validateReviewResult({
    decision: 'approved',
    findings: [{ severity: 'low', message: 'Note' }]
  }).findings, [{ severity: 'low', file: '', message: 'Note' }]);
  assert.throws(() => validateReviewResult({ decision: 'rejected' }), /Invalid review decision/);
  assert.throws(() => validateIntegrationResult({ status: 'unknown' }), /Invalid integration status/);
});
