import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { StateDatabase } from '../src/core/db.ts';
import { migrateLegacyProjectState, preflightLegacyMigration } from '../src/core/migration.ts';
import { resolveAgentTeamHome } from '../src/core/home.ts';
import { runCli } from '../src/cli.ts';

function fixture(status = 'done') {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-migrate-repo-'));
  const legacy = join(repo, '.agent-team');
  const db = new StateDatabase(join(legacy, 'state.sqlite'));
  db.createRun({ id: 'legacy-run', repoRoot: repo, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'abc', adapter: 'claude' });
  db.updateRun('legacy-run', { status });
  db.close();
  mkdirSync(join(legacy, 'runs', 'legacy-run'), { recursive: true });
  writeFileSync(join(legacy, 'runs', 'legacy-run', 'handoff.json'), '{}');
  mkdirSync(join(legacy, 'worktrees', 'kept'), { recursive: true });
  return repo;
}

function home() {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-migrate-home-'));
  return resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: root } });
}

test('the isolated legacy reader verifies terminal project state without writing', async () => {
  const repo = fixture();
  const target = home();
  const plan = await migrateLegacyProjectState(repo, target, true);
  assert.deepEqual({ runs: plan.stateRuns, artifacts: plan.runArtifacts, worktrees: plan.preservedWorktrees }, { runs: 1, artifacts: 1, worktrees: 1 });
  assert.equal(existsSync(target.stateDb), false);
  assert.equal(existsSync(join(target.runsDir, 'legacy-run')), false);
});

test('migrate CLI accepts an explicit repository and reports dry-run scope', async () => {
  const output = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value = '') => output.push(String(value)));
  try {
    await runCli(['migrate', '--repo', fixture(), '--home', home().root, '--dry-run']);
  } finally {
    log.mockRestore();
  }
  assert.match(output.join('\n'), /Migration preflight passed \(dry run\): 1 state run\(s\), 1 run artifact\(s\)/);
  assert.match(output.join('\n'), /Worktrees were not migrated/);
});

test('migration snapshots state and run artifacts without moving worktrees', async () => {
  const repo = fixture();
  const target = home();
  await migrateLegacyProjectState(repo, target);
  const migrated = new StateDatabase(target.stateDb);
  try {
    assert.equal(migrated.getRun('legacy-run').status, 'done');
  } finally {
    migrated.close();
  }
  assert.equal(existsSync(join(target.runsDir, 'legacy-run', 'handoff.json')), true);
  assert.equal(existsSync(join(repo, '.agent-team', 'worktrees', 'kept')), true);
  assert.equal(existsSync(join(repo, '.agent-team', 'state.sqlite')), true);
});

test('migration rejects existing global state, run collisions, and active runs', () => {
  const repo = fixture();
  const target = home();
  writeFileSync(target.stateDb, 'existing');
  assert.throws(() => preflightLegacyMigration(repo, target), /will not be merged or overwritten/);

  const collisionHome = home();
  mkdirSync(join(collisionHome.runsDir, 'legacy-run'), { recursive: true });
  assert.throws(() => preflightLegacyMigration(repo, collisionHome), /will not be overwritten/);

  const activeRepo = fixture('running');
  assert.throws(() => preflightLegacyMigration(activeRepo, home()), /only terminal runs can be migrated safely/);
});

test('migration preflight rejects invalid sources and unsafe artifacts before copying', () => {
  const missing = mkdtempSync(join(tmpdir(), 'agent-team-migrate-missing-'));
  assert.throws(() => preflightLegacyMigration(missing, home()), /Legacy state database not found/);

  const invalidDatabase = mkdtempSync(join(tmpdir(), 'agent-team-migrate-invalid-db-'));
  mkdirSync(join(invalidDatabase, '.agent-team'), { recursive: true });
  writeFileSync(join(invalidDatabase, '.agent-team', 'state.sqlite'), 'not sqlite');
  assert.throws(() => preflightLegacyMigration(invalidDatabase, home()), /not a supported SQLite state database/);

  const repo = fixture();
  const legacy = join(repo, '.agent-team');
  try {
    assert.throws(
      () => preflightLegacyMigration(repo, resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: legacy } })),
      /must be different directories/
    );
    writeFileSync(join(legacy, 'runs', 'not-a-directory'), 'nope');
    assert.throws(() => preflightLegacyMigration(repo, home()), /not a safe run directory/);
    rmSync(join(legacy, 'runs', 'not-a-directory'));
    mkdirSync(join(legacy, 'runs', 'orphan'));
    assert.throws(() => preflightLegacyMigration(repo, home()), /no matching state record/);
    rmSync(join(legacy, 'runs', 'orphan'), { recursive: true });
    symlinkSync(join(legacy, 'runs', 'legacy-run'), join(legacy, 'runs', 'linked'));
    assert.throws(() => preflightLegacyMigration(repo, home()), /not a safe run directory/);
    rmSync(join(legacy, 'runs', 'linked'), { recursive: true, force: true });
    symlinkSync(join(legacy, 'runs', 'legacy-run', 'handoff.json'), join(legacy, 'runs', 'legacy-run', 'linked.json'));
    assert.throws(() => preflightLegacyMigration(repo, home()), /unsupported file type/);
  } finally {
    rmSync(missing, { recursive: true, force: true });
    rmSync(invalidDatabase, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('migration supports terminal state without optional artifact or worktree directories', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-migrate-state-only-'));
  const legacy = join(repo, '.agent-team');
  const db = new StateDatabase(join(legacy, 'state.sqlite'));
  db.createRun({ id: 'state-only', repoRoot: repo, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'abc', adapter: 'claude' });
  db.updateRun('state-only', { status: 'done' });
  db.close();
  const target = home();
  try {
    assert.deepEqual(preflightLegacyMigration(repo, target), {
      sourceRepo: repo, sourceRoot: legacy, stateRuns: 1, runArtifacts: 0, preservedWorktrees: 0
    });
    await migrateLegacyProjectState(repo, target);
    const migrated = new StateDatabase(target.stateDb);
    try {
      assert.equal(migrated.getRun('state-only').status, 'done');
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(target.root, { recursive: true, force: true });
  }
});

test('migration rejects unsafe state run identifiers', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-migrate-unsafe-id-'));
  const legacy = join(repo, '.agent-team');
  const db = new StateDatabase(join(legacy, 'state.sqlite'));
  db.createRun({ id: '../unsafe', repoRoot: repo, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'abc', adapter: 'claude' });
  db.updateRun('../unsafe', { status: 'done' });
  db.close();
  const target = home();
  try {
    assert.throws(() => preflightLegacyMigration(repo, target), /unsafe run id/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(target.root, { recursive: true, force: true });
  }
});
