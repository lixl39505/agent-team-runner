import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
      createdBy: 'system',
      note: '',
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
      createdBy: 'system',
      note: '',
      createdAt: registry.getProjectPolicy(second.id).createdAt
    });
    assert.deepEqual(registry.getProjectPolicyRevision(first.id, `${first.id}:r1`), {
      id: `${first.id}:r1`,
      projectId: first.id,
      revision: 1,
      ...projectInput().policy,
      createdBy: 'system',
      note: '',
      createdAt: registry.getProjectPolicyRevision(first.id, `${first.id}:r1`).createdAt
    });
    assert.equal(registry.db.prepare('SELECT COUNT(*) AS count FROM project_policy_revisions').get().count, 2);
  } finally {
    registry.close();
  }
});

test('rejects a policy revision belonging to another project', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-project-registry-'));
  const registry = new ProjectRegistry(join(directory, 'projects.sqlite'));
  try {
    const first = registry.registerProject(projectInput());
    const second = registry.registerProject(projectInput({
      gitCommonDir: '/repos/other/.git',
      repoRoot: '/repos/other',
      displayName: 'Other',
      gitIdentity: { remote: 'git@github.com:example/other.git' }
    }));
    assert.throws(
      () => registry.getProjectPolicyRevision(first.id, second.currentPolicyRevisionId),
      new RegExp(`Project policy revision ${second.currentPolicyRevisionId} does not belong to project: ${first.id}`)
    );
  } finally {
    registry.close();
  }
});

test('rejects an unknown policy revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-project-registry-'));
  const registry = new ProjectRegistry(join(directory, 'projects.sqlite'));
  try {
    const project = registry.registerProject(projectInput());
    assert.throws(
      () => registry.getProjectPolicyRevision(project.id, `${project.id}:r999`),
      new RegExp(`Project policy revision not found: ${project.id}:r999`)
    );
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
    assert.throws(() => registry.getProjectPolicyRevision('missing', 'revision'), /Project not found: missing/);
    registry.registerProject(projectInput({
      gitCommonDir: '/repos/zebra/.git',
      displayName: 'Zebra',
      gitIdentity: { remote: 'git@github.com:example/zebra.git' }
    }));
    registry.registerProject(projectInput({
      gitCommonDir: '/repos/alpha/.git',
      displayName: 'Alpha',
      gitIdentity: { remote: 'git@github.com:example/alpha.git' }
    }));
    assert.deepEqual(registry.listProjects().map((project) => project.displayName), ['Alpha', 'Zebra']);
  } finally {
    registry.close();
  }
});

test('updates a project when its unique non-empty git identity is registered at a new path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-project-registry-'));
  const registry = new ProjectRegistry(join(directory, 'projects.sqlite'));
  try {
    const first = registry.registerProject(projectInput());
    const moved = registry.registerProject(projectInput({
      gitCommonDir: '/moved/example/.git',
      repoRoot: '/moved/example',
      gitIdentity: { remote: 'git@github.com:example/repo.git' }
    }));
    assert.equal(moved.id, first.id);
    assert.equal(moved.gitCommonDir, '/moved/example/.git');
    assert.equal(moved.repoRoot, '/moved/example');
    assert.equal(registry.db.prepare('SELECT COUNT(*) AS count FROM projects').get().count, 1);
    assert.throws(() => registry.getProject('/repos/example/.git'), /Project not found/);
  } finally {
    registry.close();
  }
});

test('stores policy revision authorship and note with compatible defaults', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-project-registry-'));
  const registry = new ProjectRegistry(join(directory, 'projects.sqlite'));
  try {
    const first = registry.registerProject(projectInput());
    const revised = registry.registerProject(projectInput({
      createdBy: 'ada',
      note: 'Use the release branch.',
      policy: { ...projectInput().policy, baseRef: 'release' }
    }));
    assert.equal(registry.getProjectPolicyRevision(first.id, first.currentPolicyRevisionId).createdBy, 'system');
    assert.equal(registry.getProjectPolicyRevision(first.id, first.currentPolicyRevisionId).note, '');
    assert.equal(registry.getProjectPolicy(revised.id).createdBy, 'ada');
    assert.equal(registry.getProjectPolicy(revised.id).note, 'Use the release branch.');
  } finally {
    registry.close();
  }
});

test('archives projects and hides them unless includeArchived is requested', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-project-registry-'));
  const registry = new ProjectRegistry(join(directory, 'projects.sqlite'));
  try {
    const project = registry.registerProject(projectInput());
    const archived = registry.archiveProject(project.id);
    assert.match(archived.archivedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(registry.archiveProject(project.id).archivedAt, archived.archivedAt);
    assert.deepEqual(registry.listProjects(), []);
    assert.deepEqual(registry.listProjects({ includeArchived: true }).map((entry) => entry.id), [project.id]);
  } finally {
    registry.close();
  }
});

test('migrates project archival and policy revision audit columns', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-project-registry-'));
  const path = join(directory, 'projects.sqlite');
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      git_common_dir TEXT NOT NULL UNIQUE,
      repo_root TEXT NOT NULL,
      display_name TEXT NOT NULL,
      git_identity_json TEXT NOT NULL,
      current_policy_revision_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE project_policy_revisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      base_ref TEXT NOT NULL,
      verification_allowed_command_prefixes_json TEXT NOT NULL,
      baseline_path_policy_json TEXT NOT NULL,
      agent_profile_mapping_json TEXT NOT NULL,
      backend_policy_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (project_id, revision)
    ) STRICT;
  `);
  database.close();
  const registry = new ProjectRegistry(path);
  try {
    assert.deepEqual(
      registry.db.prepare("SELECT name FROM pragma_table_info('projects') WHERE name = 'archived_at'").all().map((row) => ({ ...row })),
      [{ name: 'archived_at' }]
    );
    assert.deepEqual(
      registry.db.prepare("SELECT name FROM pragma_table_info('project_policy_revisions') WHERE name IN ('created_by', 'note') ORDER BY name").all().map((row) => ({ ...row })),
      [{ name: 'created_by' }, { name: 'note' }]
    );
  } finally {
    registry.close();
  }
});

test('only associates a moved project with a unique, non-empty canonical git identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-project-registry-'));
  const registry = new ProjectRegistry(join(directory, 'projects.sqlite'));
  try {
    const empty = registry.registerProject(projectInput({ gitIdentity: null }));
    const anotherEmpty = registry.registerProject(projectInput({
      gitCommonDir: '/repos/empty/.git', repoRoot: '/repos/empty', displayName: 'Empty', gitIdentity: ''
    }));
    assert.notEqual(empty.id, anotherEmpty.id);

    const duplicate = registry.registerProject(projectInput({
      gitCommonDir: '/repos/duplicate/.git', repoRoot: '/repos/duplicate', displayName: 'Duplicate', gitIdentity: ['same']
    }));
    registry.db.prepare(`
      INSERT INTO projects (id, git_common_dir, repo_root, display_name, git_identity_json, current_policy_revision_id, archived_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run('manual-duplicate', '/repos/duplicate-two/.git', '/repos/duplicate-two', 'Duplicate two', JSON.stringify(['same']), duplicate.currentPolicyRevisionId, duplicate.createdAt, duplicate.updatedAt);
    const moved = registry.registerProject(projectInput({
      gitCommonDir: '/repos/moved/.git', repoRoot: '/repos/moved', displayName: 'Moved', gitIdentity: ['same']
    }));
    assert.equal(moved.gitCommonDir, '/repos/moved/.git');
    assert.equal(registry.listProjects({ includeArchived: true }).length, 5);
  } finally {
    registry.close();
  }
});
