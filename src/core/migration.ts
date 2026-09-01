import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { AgentTeamHome } from './home.js';

const TERMINAL_RUN_STATUSES = new Set(['done', 'failed', 'cancelled']);
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface LegacyMigrationPlan {
  sourceRepo: string;
  sourceRoot: string;
  stateRuns: number;
  runArtifacts: number;
  preservedWorktrees: number;
}

function assertRegularTree(path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
    throw new Error(`Migration source contains an unsupported file type: ${path}`);
  }
  if (!entry.isDirectory()) return;
  for (const child of readdirSync(path)) assertRegularTree(join(path, child));
}

function stateRuns(path: string): Array<{ id: string; status: string }> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined;
    if (check?.quick_check !== 'ok') throw new Error(`Legacy state database failed quick_check: ${path}`);
    return db.prepare('SELECT id, status FROM runs ORDER BY id').all() as Array<{ id: string; status: string }>;
  } catch (error) {
    throw new Error(`Legacy state database is not a supported SQLite state database: ${path}`, { cause: error });
  } finally {
    db.close();
  }
}

/**
 * Validates the legacy project-local state that can be moved without changing Git worktree registration.
 * Active runs are rejected because their worktrees cannot be safely relocated by a filesystem copy.
 */
export function preflightLegacyMigration(sourceRepo: string, home: AgentTeamHome): LegacyMigrationPlan {
  const repo = resolve(sourceRepo);
  const sourceRoot = join(repo, '.agent-team');
  const sourceState = join(sourceRoot, 'state.sqlite');
  if (resolve(sourceRoot) === resolve(home.root)) {
    throw new Error('Legacy source and AGENT_TEAM_HOME must be different directories');
  }
  if (!existsSync(sourceState) || !lstatSync(sourceState).isFile()) {
    throw new Error(`Legacy state database not found: ${sourceState}`);
  }
  if (existsSync(home.stateDb) || existsSync(`${home.stateDb}-wal`) || existsSync(`${home.stateDb}-shm`)) {
    throw new Error(`Global state database already exists and will not be merged or overwritten: ${home.stateDb}`);
  }

  const runs = stateRuns(sourceState);
  for (const run of runs) {
    if (!RUN_NAME.test(run.id)) throw new Error(`Legacy state database has an unsafe run id: ${run.id}`);
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`Run ${run.id} is ${run.status}; only terminal runs can be migrated safely because worktrees are not moved`);
    }
  }

  const sourceRuns = join(sourceRoot, 'runs');
  const artifacts = existsSync(sourceRuns) ? readdirSync(sourceRuns, { withFileTypes: true }) : [];
  const knownRunIds = new Set(runs.map((run) => run.id));
  for (const artifact of artifacts) {
    if (!artifact.isDirectory() || artifact.isSymbolicLink() || !RUN_NAME.test(artifact.name)) {
      throw new Error(`Legacy run artifact is not a safe run directory: ${join(sourceRuns, artifact.name)}`);
    }
    if (!knownRunIds.has(artifact.name)) {
      throw new Error(`Legacy run artifact has no matching state record: ${artifact.name}`);
    }
    if (existsSync(join(home.runsDir, artifact.name))) {
      throw new Error(`Global run artifact already exists and will not be overwritten: ${artifact.name}`);
    }
    assertRegularTree(join(sourceRuns, artifact.name));
  }

  const sourceWorktrees = join(sourceRoot, 'worktrees');
  const preservedWorktrees = existsSync(sourceWorktrees)
    ? readdirSync(sourceWorktrees, { withFileTypes: true }).length
    : 0;
  return { sourceRepo: repo, sourceRoot, stateRuns: runs.length, runArtifacts: artifacts.length, preservedWorktrees };
}

export async function migrateLegacyProjectState(sourceRepo: string, home: AgentTeamHome, dryRun = false): Promise<LegacyMigrationPlan> {
  const plan = preflightLegacyMigration(sourceRepo, home);
  if (dryRun) return plan;

  const sourceState = join(plan.sourceRoot, 'state.sqlite');
  mkdirSync(home.root, { recursive: true });
  const staging = join(home.root, `.migration-${randomUUID()}`);
  const stagedState = join(staging, 'state.sqlite');
  const sourceRuns = join(plan.sourceRoot, 'runs');
  try {
    mkdirSync(staging, { recursive: false });
    const sourceDb = new DatabaseSync(sourceState, { readOnly: true });
    try {
      await backup(sourceDb, stagedState);
    } finally {
      sourceDb.close();
    }

    for (const artifact of existsSync(sourceRuns) ? readdirSync(sourceRuns, { withFileTypes: true }) : []) {
      const stagedRun = join(staging, 'runs', artifact.name);
      cpSync(join(sourceRuns, artifact.name), stagedRun, { recursive: true, force: false, errorOnExist: true });
    }

    // Re-check immediately before publication; neither state nor run artifacts are replaced.
    if (existsSync(home.stateDb)) throw new Error(`Global state database already exists and will not be overwritten: ${home.stateDb}`);
    mkdirSync(home.runsDir, { recursive: true });
    for (const artifact of existsSync(join(staging, 'runs')) ? readdirSync(join(staging, 'runs'), { withFileTypes: true }) : []) {
      const destination = join(home.runsDir, artifact.name);
      if (existsSync(destination)) throw new Error(`Global run artifact already exists and will not be overwritten: ${artifact.name}`);
      // mkdir is fail-if-exists, so publishing a run cannot replace an existing directory.
      mkdirSync(destination);
      for (const child of readdirSync(join(staging, 'runs', artifact.name))) {
        renameSync(join(staging, 'runs', artifact.name, child), join(destination, child));
      }
    }
    // link(2) is fail-if-exists, unlike rename(2), so it cannot replace a concurrently-created state database.
    linkSync(stagedState, home.stateDb);
    unlinkSync(stagedState);
    return plan;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
