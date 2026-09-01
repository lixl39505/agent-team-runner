import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/core/defaults.ts';
import { StateDatabase } from '../src/core/db.ts';
import { createExecutionRun } from '../src/core/execution-run.ts';

function repository() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-execution-run-'));
  writeFileSync(join(repoRoot, 'README.md'), '# Test\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Tests'], { cwd: repoRoot });
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repoRoot });
  return repoRoot;
}

function configFor(repoRoot, overrides = {}) {
  const { workspace, verification, ...rest } = overrides;
  return {
    ...DEFAULT_CONFIG,
    workspace: {
      ...DEFAULT_CONFIG.workspace,
      repoRoot,
      stateDir: join(repoRoot, '.state'),
      worktreesDir: join(repoRoot, '.worktrees'),
      ...workspace
    },
    verification: { ...DEFAULT_CONFIG.verification, globalCommands: [], ...verification },
    ...rest
  };
}

function contract(repoRoot, overrides = {}) {
  return {
    version: 1,
    project: { id: 'external-project', repoRoot, baseRef: 'HEAD' },
    target: {},
    tasks: [{
      id: 'T001',
      title: 'Create feature',
      description: 'Implement the feature.',
      dependsOn: [],
      allowedPaths: ['src/**'],
      blockedPaths: [],
      acceptance: ['feature works'],
      verificationCommands: ['npm test']
    }],
    ...overrides
  };
}

function events(db, runId) {
  return db.db.prepare('SELECT event_type FROM events WHERE run_id = ? ORDER BY id').all(runId).map((row) => row.event_type);
}

function writeSkill(root, name, content) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), content, 'utf8');
}

test('creates an executable planned run from an external contract', async () => {
  const repoRoot = repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  try {
    const executionContract = contract(repoRoot);
    const runId = await createExecutionRun({
      config,
      db,
      contract: executionContract,
      projectPolicyRevisionId: 'policy-revision-42',
      runId: 'external-run'
    });
    const run = db.getRun(runId);
    const manifest = JSON.parse(run.manifestJson);

    assert.equal(run.status, 'planned');
    assert.equal(run.repoRoot, repoRoot);
    assert.equal(run.goalFile, '<execution-contract>');
    assert.equal(run.adapter, 'external');
    assert.equal(run.baseRef, 'HEAD');
    assert.match(run.baseSha, /^[0-9a-f]{40}$/);
    assert.equal(run.projectId, 'external-project');
    assert.equal(run.projectPolicyRevisionId, 'policy-revision-42');
    assert.deepEqual(JSON.parse(run.executionContractJson), executionContract);
    assert.deepEqual(manifest.tasks, executionContract.tasks);
    assert.equal(JSON.parse(run.rolesJson).version, 2);
    assert.deepEqual(db.listTasks(runId).map((task) => task.taskId), ['T001']);
    assert.deepEqual(JSON.parse(readFileSync(join(config.workspace.stateDir, 'runs', runId, 'contract.json'), 'utf8')), contract(repoRoot));
    assert.match(readFileSync(join(config.workspace.stateDir, 'runs', runId, 'tasks', 'T001.md'), 'utf8'), /基础提交: [0-9a-f]{40}/);
    assert.deepEqual(events(db, runId), ['RUN_CREATED', 'TASK_CREATED', 'EXECUTION_CONTRACT_CREATED']);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('snapshots required project and user implementation Skills before creating tasks', async () => {
  const repoRoot = repository();
  const userHome = mkdtempSync(join(tmpdir(), 'agent-team-user-skills-'));
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  try {
    writeSkill(join(repoRoot, '.agents', 'skills'), 'tdd', 'Project snapshot');
    writeSkill(join(userHome, '.agents', 'skills'), 'domain', 'User snapshot');
    const runId = await createExecutionRun({
      config,
      db,
      userHome,
      runId: 'skill-snapshots',
      contract: contract(repoRoot, { tasks: [{
        ...contract(repoRoot).tasks[0],
        implementationSkills: [
          { name: 'tdd', role: 'worker', required: true, source: 'project' },
          { name: 'domain', role: 'worker', required: true, source: 'user' }
        ]
      }] })
    });
    assert.deepEqual(JSON.parse(db.getTask(runId, 'T001').resolvedSkillsJson), [
      {
        name: 'tdd', role: 'worker', source: 'project', path: join(repoRoot, '.agents', 'skills', 'tdd', 'SKILL.md'),
        sha256: createHash('sha256').update('Project snapshot', 'utf8').digest('hex'), content: 'Project snapshot'
      },
      {
        name: 'domain', role: 'worker', source: 'user', path: join(userHome, '.agents', 'skills', 'domain', 'SKILL.md'),
        sha256: createHash('sha256').update('User snapshot', 'utf8').digest('hex'), content: 'User snapshot'
      }
    ]);

    await assert.rejects(createExecutionRun({
      config, db, runId: 'missing-required-skill',
      contract: contract(repoRoot, { tasks: [{
        ...contract(repoRoot).tasks[0],
        implementationSkills: [{ name: 'missing', role: 'worker', required: true, source: 'project' }]
      }] })
    }), /Required project skill is missing/);
    assert.equal(db.listRuns().some((run) => run.id === 'missing-required-skill'), false);
  } finally {
    db.close();
    rmSync(userHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('uses a safe unique generated id and accepts an injected clock', async () => {
  const repoRoot = repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  try {
    const runId = await createExecutionRun({
      config,
      db,
      contract: contract(repoRoot),
      now: () => new Date('2026-08-30T12:34:56.000Z')
    });
    assert.match(runId, /^execution-20260830123456-[0-9a-f]{8}$/);
    const defaultRunId = await createExecutionRun({ config, db, contract: contract(repoRoot) });
    assert.match(defaultRunId, /^execution-[0-9]{14}-[0-9a-f]{8}$/);
    assert.notEqual(defaultRunId, runId);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('rejects unsafe supplied run ids before creating a run', async () => {
  const repoRoot = repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  try {
    await assert.rejects(
      createExecutionRun({ config, db, contract: contract(repoRoot), runId: '../escape' }),
      /Invalid run id/
    );
    assert.equal(db.listRuns().length, 0);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('rejects contracts for a different repository before creating a run', async () => {
  const repoRoot = repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  try {
    await assert.rejects(
      createExecutionRun({ config, db, contract: contract(join(repoRoot, 'other')), runId: 'wrong-repo' }),
      /does not match configured workspace/
    );
    assert.equal(db.listRuns().length, 0);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('rejects commands outside the configured allowlist before creating a run', async () => {
  const repoRoot = repository();
  const config = configFor(repoRoot, { verification: { allowedCommandPrefixes: ['npm test'], globalCommands: [] } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  try {
    await assert.rejects(
      createExecutionRun({
        config,
        db,
        contract: contract(repoRoot, { tasks: [{ ...contract(repoRoot).tasks[0], verificationCommands: ['rm -rf build'] }] }),
        runId: 'bad-command'
      }),
      /not allowlisted/
    );
    assert.equal(db.listRuns().length, 0);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('rejects invalid contracts before creating a run', async () => {
  const repoRoot = repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  try {
    await assert.rejects(
      createExecutionRun({ config, db, contract: contract(repoRoot, { tasks: [] }), runId: 'invalid-contract' }),
      /at least one task/
    );
    assert.equal(db.listRuns().length, 0);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('marks a created run failed when contract files cannot be written', async () => {
  const repoRoot = repository();
  const stateFile = join(repoRoot, 'state-file');
  writeFileSync(stateFile, 'not a directory', 'utf8');
  const config = configFor(repoRoot, { workspace: { stateDir: stateFile } });
  const db = new StateDatabase(join(repoRoot, 'state.sqlite'));
  try {
    await assert.rejects(
      createExecutionRun({ config, db, contract: contract(repoRoot), runId: 'write-failure' }),
      /ENOTDIR/
    );
    assert.equal(db.getRun('write-failure').status, 'failed');
    assert.match(db.getRun('write-failure').error, /ENOTDIR/);
    assert.deepEqual(events(db, 'write-failure'), ['RUN_CREATED', 'EXECUTION_CONTRACT_FAILED']);
    assert.equal(existsSync(join(stateFile, 'runs', 'write-failure', 'contract.json')), false);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('marks a created run failed when its agent snapshot cannot be created', async () => {
  const repoRoot = repository();
  const config = configFor(repoRoot, { roles: { worker: 'missing-agent' } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  try {
    await assert.rejects(
      createExecutionRun({ config, db, contract: contract(repoRoot), runId: 'snapshot-failure' }),
      /roles\.worker: unknown agent/
    );
    assert.equal(db.getRun('snapshot-failure').status, 'failed');
    assert.deepEqual(events(db, 'snapshot-failure'), ['RUN_CREATED', 'TASK_CREATED', 'EXECUTION_CONTRACT_FAILED']);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
