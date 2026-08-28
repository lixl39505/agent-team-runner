import { test } from 'vitest';
import assert from 'node:assert/strict';
import { topologicalTasks, validateLeadResult } from '../src/core/validation.ts';

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

test('.git ownership is rejected in allowedPaths but allowed in blockedPaths', () => {
  assert.throws(() => validateLeadResult({
    version: 1,
    title: 'git',
    summary: 'git',
    tasks: [{ ...task('T001'), allowedPaths: ['.git/**'] }]
  }), /may not own .git paths/);
  // blockedPaths 里的 .git/** 是纯增强限制（Lead 的防御性输出），应当接受
  assert.doesNotThrow(() => validateLeadResult({
    version: 1,
    title: 'git',
    summary: 'git',
    tasks: [{ ...task('T001'), blockedPaths: ['.git/**', 'package.json'] }]
  }));
});

test('validates per-task agent names against the registry', () => {
  const withAgent = { ...task('T001'), agent: 'heavy' };
  assert.doesNotThrow(() => validateLeadResult({
    version: 1, title: 'agents', summary: 'agents', tasks: [withAgent]
  }, ['heavy', 'light']));
  assert.equal(validateLeadResult({
    version: 1, title: 'agents', summary: 'agents', tasks: [withAgent]
  }, ['heavy', 'light']).tasks[0].agent, 'heavy');
  assert.throws(() => validateLeadResult({
    version: 1, title: 'agents', summary: 'agents', tasks: [withAgent]
  }, ['light']), /unknown agent "heavy"/);
  // 未提供注册表时不校验成员关系（允许旧 manifest 读取路径）
  assert.doesNotThrow(() => validateLeadResult({
    version: 1, title: 'agents', summary: 'agents', tasks: [withAgent]
  }));
});

test('rejects the deprecated task.adapter field', () => {
  assert.throws(() => validateLeadResult({
    version: 1,
    title: 'legacy',
    summary: 'legacy',
    tasks: [{ ...task('T001'), adapter: 'codex' }]
  }), /deprecated "adapter" field/);
});
