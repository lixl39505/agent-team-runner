import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';

const sqliteRace = vi.hoisted(() => ({ afterBackup: undefined, quickCheckFailure: false }));

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal();
  class DatabaseSync {
    constructor(...args) {
      this.database = new actual.DatabaseSync(...args);
    }

    exec(...args) {
      return this.database.exec(...args);
    }

    prepare(sql) {
      if (sqliteRace.quickCheckFailure && sql === 'PRAGMA quick_check') {
        return { get: () => ({ quick_check: 'corrupt' }) };
      }
      return this.database.prepare(sql);
    }

    close() {
      return this.database.close();
    }
  }

  return {
    ...actual,
    DatabaseSync,
    backup: async (source, destination) => {
      await actual.backup(source.database ?? source, destination);
      sqliteRace.afterBackup?.();
    }
  };
});

const { DatabaseSync } = await import('node:sqlite');
const { migrateLegacyProjectState, preflightLegacyMigration } = await import('../src/core/migration.ts');

function legacyFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-migration-race-repo-'));
  const sourceRoot = join(repo, '.agent-team');
  mkdirSync(join(sourceRoot, 'runs', 'legacy-run'), { recursive: true });
  const sourceDb = new DatabaseSync(join(sourceRoot, 'state.sqlite'));
  sourceDb.exec("CREATE TABLE runs (id TEXT, status TEXT); INSERT INTO runs VALUES ('legacy-run', 'done');");
  sourceDb.close();
  writeFileSync(join(sourceRoot, 'runs', 'legacy-run', 'handoff.json'), '{}');
  return repo;
}

function targetHome() {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-migration-race-home-'));
  return { root, stateDb: join(root, 'state.sqlite'), runsDir: join(root, 'runs') };
}

test('migration reports a failed SQLite quick check as an unsupported legacy database', () => {
  const repo = legacyFixture();
  const home = targetHome();
  sqliteRace.quickCheckFailure = true;
  try {
    assert.throws(() => preflightLegacyMigration(repo, home), /not a supported SQLite state database/);
  } finally {
    sqliteRace.quickCheckFailure = false;
    rmSync(repo, { recursive: true, force: true });
    rmSync(home.root, { recursive: true, force: true });
  }
});

test('migration rechecks state and artifact destinations immediately before publication', async () => {
  const stateRepo = legacyFixture();
  const stateHome = targetHome();
  try {
    sqliteRace.afterBackup = () => writeFileSync(stateHome.stateDb, 'concurrently created');
    await assert.rejects(migrateLegacyProjectState(stateRepo, stateHome), /Global state database already exists/);
  } finally {
    sqliteRace.afterBackup = undefined;
    rmSync(stateRepo, { recursive: true, force: true });
    rmSync(stateHome.root, { recursive: true, force: true });
  }

  const artifactRepo = legacyFixture();
  const artifactHome = targetHome();
  try {
    sqliteRace.afterBackup = () => mkdirSync(join(artifactHome.runsDir, 'legacy-run'), { recursive: true });
    await assert.rejects(migrateLegacyProjectState(artifactRepo, artifactHome), /Global run artifact already exists/);
  } finally {
    sqliteRace.afterBackup = undefined;
    rmSync(artifactRepo, { recursive: true, force: true });
    rmSync(artifactHome.root, { recursive: true, force: true });
  }
});
