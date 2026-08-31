import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../src/core/project-registry.ts';

function projectInput(overrides = {}) {
  return {
    gitCommonDir: '/repos/example/.git',
    repoRoot: '/repos/example',
    displayName: 'Example',
    gitIdentity: { remote: 'git@github.com:example/repo.git' },
    policy: {
      baseRef: 'main',
      verificationAllowedCommandPrefixes: ['npm test'],
      baselinePathPolicy: { allowed: ['src/**'] },
      agentProfileMapping: { worker: 'codex.gpt-5' },
      backendPolicy: { codex: { network: false } }
    },
    ...overrides
  };
}

test('registers a project and its first policy revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-project-registry-'));
  const path = join(directory, 'nested', 'projects.sqlite');
  const registry = new ProjectRegistry(path);
  try {
    const project = registry.registerProject(projectInput());
    assert.equal(existsSync(path), true);
    assert.match(project.id, /^project-/);
    assert.equal(project.currentPolicyRevisionId, `${project.id}:r1`);
    assert.deepEqual(project.gitIdentity, { remote: 'git@github.com:example/repo.git' });
    assert.deepEqual(registry.getProject(project.id), project);
    assert.deepEqual(registry.getProject(project.gitCommonDir), project);
    assert.deepEqual(registry.getProjectPolicy(project.id), {
      id: `${project.id}:r1`,
      projectId: project.id,
      revision: 1,
      ...projectInput().policy,
      createdAt: registry.getProjectPolicy(project.id).createdAt
    });
    assert.deepEqual(
      registry.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'project_policy_revisions') ORDER BY name").all().map((row) => ({ ...row })),
      [{ name: 'project_policy_revisions' }, { name: 'projects' }]
    );
    assert.deepEqual(
      registry.db.prepare("SELECT name, strict FROM pragma_table_list WHERE name IN ('projects', 'project_policy_revisions') ORDER BY name").all().map((row) => ({ ...row })),
      [{ name: 'project_policy_revisions', strict: 1 }, { name: 'projects', strict: 1 }]
    );
  } finally {
    registry.close();
  }
});

test('re-registering updates project metadata without a new policy revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-project-registry-'));
  const registry = new ProjectRegistry(join(directory, 'projects.sqlite'));
  try {
    const first = registry.registerProject(projectInput());
    const second = registry.registerProject(projectInput({
      repoRoot: '/worktrees/example',
      displayName: 'Example worktree',
      gitIdentity: { remote: 'git@github.com:example/repo.git', user: 'Ada' }
    }));
    assert.equal(second.id, first.id);
    assert.equal(second.currentPolicyRevisionId, first.currentPolicyRevisionId);
    assert.equal(second.repoRoot, '/worktrees/example');
    assert.equal(second.displayName, 'Example worktree');
    assert.deepEqual(second.gitIdentity, { remote: 'git@github.com:example/repo.git', user: 'Ada' });
    assert.equal(registry.db.prepare('SELECT COUNT(*) AS count FROM project_policy_revisions').get().count, 1);
  } finally {
    registry.close();
  }
});

test('creates a revision only when the policy changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-project-registry-'));
  const registry = new ProjectRegistry(join(directory, 'projects.sqlite'));
  try {
    const first = registry.registerProject(projectInput());
    const second = registry.registerProject(projectInput({
      policy: {
        ...projectInput().policy,
        baseRef: 'release'
      }
    }));
    assert.equal(second.currentPolicyRevisionId, `${first.id}:r2`);
    assert.deepEqual(registry.getProjectPolicy(second.gitCommonDir), {
      id: `${first.id}:r2`,
      projectId: first.id,
      revision: 2,
      ...projectInput({ policy: { ...projectInput().policy, baseRef: 'release' } }).policy,
      createdAt: registry.getProjectPolicy(second.id).createdAt
    });
    assert.equal(registry.db.prepare('SELECT COUNT(*) AS count FROM project_policy_revisions').get().count, 2);
  } finally {
    registry.close();
  }
});

test('reports unknown projects and lists projects by display name', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-project-registry-'));
  const registry = new ProjectRegistry(join(directory, 'projects.sqlite'));
  try {
    assert.throws(() => registry.getProject('missing'), /Project not found: missing/);
    assert.throws(() => registry.getProjectPolicy('missing'), /Project not found: missing/);
    registry.registerProject(projectInput({
      gitCommonDir: '/repos/zebra/.git',
      displayName: 'Zebra'
    }));
    registry.registerProject(projectInput({
      gitCommonDir: '/repos/alpha/.git',
      displayName: 'Alpha'
    }));
    assert.deepEqual(registry.listProjects().map((project) => project.displayName), ['Alpha', 'Zebra']);
  } finally {
    registry.close();
  }
});
