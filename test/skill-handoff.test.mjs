import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import { listProjectSkills, localSkillRoots, resolveTaskSkills, snapshotTaskSkills } from '../src/core/skill-handoff.ts';
import { validateTaskSpec } from '../src/core/validation.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-skill-handoff-'));
  const project = join(directory, 'project');
  const user = join(directory, 'user');
  mkdirSync(project);
  mkdirSync(user);
  return {
    directory,
    project,
    user,
    roots: [{ source: 'project', path: project }, { source: 'user', path: user }],
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

function writeSkill(root, name, content) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), content, 'utf8');
}

test('resolves project and user skills with UTF-8 content and SHA-256 digests', () => {
  const state = fixture();
  try {
    writeSkill(state.project, 'tdd', 'Project skill: 测试优先\n');
    writeSkill(state.user, 'review', 'User review skill\n');

    const skills = resolveTaskSkills([
      { name: 'tdd', role: 'worker', required: true, source: 'project' },
      { name: 'review', role: 'reviewer', required: true, source: 'user' }
    ], state.roots);

    assert.deepEqual(skills, [
      {
        name: 'tdd',
        role: 'worker',
        source: 'project',
        path: join(state.project, 'tdd', 'SKILL.md'),
        sha256: createHash('sha256').update('Project skill: 测试优先\n', 'utf8').digest('hex'),
        content: 'Project skill: 测试优先\n'
      },
      {
        name: 'review',
        role: 'reviewer',
        source: 'user',
        path: join(state.user, 'review', 'SKILL.md'),
        sha256: createHash('sha256').update('User review skill\n', 'utf8').digest('hex'),
        content: 'User review skill\n'
      }
    ]);
    assert.ok(Object.isFrozen(skills));
    assert.ok(Object.isFrozen(skills[0]));
  } finally {
    state.cleanup();
  }
});

test('derives fixed safe local roots and lists project Skill metadata', () => {
  const state = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'agent-team-outside-skill-root-'));
  try {
    const projectRoot = join(state.directory, '.agents', 'skills');
    writeSkill(projectRoot, 'tdd', 'Project skill');
    writeSkill(join(state.user, '.agents', 'skills'), 'personal', 'User skill');

    assert.deepEqual(localSkillRoots(state.directory, state.user), [
      { source: 'project', path: projectRoot },
      { source: 'user', path: join(state.user, '.agents', 'skills') }
    ]);
    assert.deepEqual(listProjectSkills(state.directory), [{
      name: 'tdd', source: 'project', path: join(projectRoot, 'tdd', 'SKILL.md'),
      sha256: createHash('sha256').update('Project skill', 'utf8').digest('hex')
    }]);

    rmSync(join(state.directory, '.agents'), { recursive: true, force: true });
    mkdirSync(join(outside, 'skills'));
    symlinkSync(outside, join(state.directory, '.agents'));
    assert.deepEqual(localSkillRoots(state.directory, state.user).filter((root) => root.source === 'project'), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    state.cleanup();
  }
});

test('deduplicates matching requirements and preserves required semantics', () => {
  const state = fixture();
  try {
    writeSkill(state.project, 'tdd', 'content');
    const skills = resolveTaskSkills([
      { name: 'tdd', role: 'worker', required: false, source: 'project' },
      { name: 'tdd', role: 'worker', required: true, source: 'project' }
    ], state.roots);
    assert.equal(skills.length, 1);
    assert.equal(resolveTaskSkills([
      { name: 'tdd', role: 'worker', required: false, source: 'project' },
      { name: 'tdd', role: 'worker', required: false, source: 'project' }
    ], state.roots).length, 1);

    assert.throws(() => resolveTaskSkills([
      { name: 'missing', role: 'worker', required: false, source: 'project' },
      { name: 'missing', role: 'worker', required: true, source: 'project' }
    ], state.roots), /Required project skill is missing: missing/);
  } finally {
    state.cleanup();
  }
});

test('uses SkillRequirement validation defaults', () => {
  const task = {
    id: 'T001',
    title: 'Task',
    description: 'Task description',
    dependsOn: [],
    allowedPaths: ['src/**'],
    acceptance: ['works'],
    implementationSkills: [{ name: 'tdd', required: true }]
  };
  assert.deepEqual(validateTaskSpec(task, 0).implementationSkills, [
    { name: 'tdd', role: 'worker', required: true, source: 'project' }
  ]);
  assert.throws(() => validateTaskSpec({ ...task, implementationSkills: [{ required: true }] }, 0), /invalid implementation skill name/);
});

test('skips missing optional skills and snapshots TaskSpec requirements', () => {
  const state = fixture();
  try {
    assert.deepEqual(resolveTaskSkills([{ name: 'optional', role: 'worker', required: false, source: 'project' }], state.roots), []);
    writeSkill(state.project, 'tdd', 'snapshot');
    assert.deepEqual(snapshotTaskSkills({ implementationSkills: [{ name: 'tdd', role: 'worker', required: true, source: 'project' }] }, state.roots), [
      {
        name: 'tdd', role: 'worker', source: 'project', path: join(state.project, 'tdd', 'SKILL.md'),
        sha256: createHash('sha256').update('snapshot', 'utf8').digest('hex'), content: 'snapshot'
      }
    ]);
  } finally {
    state.cleanup();
  }
});

test('rejects missing required skills, invalid requirements, and invalid roots', () => {
  const state = fixture();
  try {
    assert.throws(() => resolveTaskSkills([{ name: 'missing', role: 'worker', required: true, source: 'project' }], state.roots), /Required project skill is missing/);
    assert.throws(() => resolveTaskSkills([{ name: '../outside', role: 'worker', required: true, source: 'project' }], state.roots), /Invalid skill name/);
    assert.throws(() => resolveTaskSkills([{ name: 'tdd', role: 'lead', required: true, source: 'project' }], state.roots), /Invalid skill role/);
    assert.throws(() => resolveTaskSkills([{ name: 'tdd', role: 'worker', required: 'true', source: 'project' }], state.roots), /boolean required/);
    assert.throws(() => resolveTaskSkills([{ name: 'tdd', role: 'worker', required: true, source: 'remote' }], state.roots), /Invalid skill source/);
    assert.throws(() => resolveTaskSkills([{ name: 'tdd', role: 'worker', required: true, source: 'user' }], [{ source: 'project', path: state.project }]), /No user skill root/);
    assert.throws(() => resolveTaskSkills({}, state.roots), /requirements must be an array/);
    assert.throws(() => resolveTaskSkills([{ name: 'tdd', role: 'worker', required: true, source: 'project' }], {}), /Skill roots must be an array/);
    assert.throws(() => resolveTaskSkills([{ name: 'tdd', role: 'worker', required: true, source: 'project' }], [{ source: 'remote', path: state.project }]), /invalid source/);
    assert.throws(() => resolveTaskSkills([{ name: 'tdd', role: 'worker', required: true, source: 'project' }], [{ source: 'project', path: '' }]), /must have a path/);
    assert.throws(() => resolveTaskSkills([{ name: 'tdd', role: 'worker', required: true, source: 'project' }], [{ source: 'project', path: join(state.directory, 'missing-root') }]), /Cannot access project skill root/);
    assert.throws(() => resolveTaskSkills([{ name: 'tdd', role: 'worker', required: true, source: 'project' }], [{ source: 'project', path: state.project }, { source: 'project', path: state.user }]), /Duplicate project skill root/);
  } finally {
    state.cleanup();
  }
});

test('rejects skills that escape their root through symbolic links and handles no requirements', () => {
  const state = fixture();
  try {
    const outside = join(state.directory, 'outside');
    writeSkill(outside, 'escaped', 'outside');
    symlinkSync(join(outside, 'escaped'), join(state.project, 'escaped'));
    assert.throws(() => resolveTaskSkills([{ name: 'escaped', role: 'worker', required: true, source: 'project' }], state.roots), /outside the project root/);
    assert.deepEqual(resolveTaskSkills(undefined, state.roots), []);
    assert.deepEqual(snapshotTaskSkills({}, state.roots), []);
  } finally {
    state.cleanup();
  }
});

test('propagates non-missing skill path errors and rejects non-directory roots', () => {
  const state = fixture();
  try {
    const brokenDirectory = join(state.project, 'broken');
    mkdirSync(brokenDirectory);
    symlinkSync('SKILL.md', join(brokenDirectory, 'SKILL.md'));
    assert.throws(() => resolveTaskSkills([{ name: 'broken', role: 'worker', required: true, source: 'project' }], state.roots), /ELOOP/);

    const fileRoot = join(state.directory, 'not-a-directory');
    writeFileSync(fileRoot, 'not a directory');
    assert.throws(() => resolveTaskSkills([{ name: 'tdd', role: 'worker', required: true, source: 'project' }], [{ source: 'project', path: fileRoot }]), /is not a directory/);
  } finally {
    state.cleanup();
  }
});

test('lists no skills without a local root and ignores unsafe directory entries', () => {
  const state = fixture();
  try {
    assert.deepEqual(listProjectSkills(state.directory), []);
    const root = join(state.directory, '.agents', 'skills');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'plain-file'), 'not a skill');
    mkdirSync(join(root, 'invalid_name'));
    assert.deepEqual(listProjectSkills(state.directory), []);
  } finally {
    state.cleanup();
  }
});
