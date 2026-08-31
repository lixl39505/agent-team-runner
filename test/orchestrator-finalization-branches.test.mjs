import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { StateDatabase } from '../src/core/db.ts';
import { currentHead, git } from '../src/core/git.ts';
import { snapshotAgents } from '../src/agent/registry.ts';
import { runOrchestrator } from '../src/core/orchestrator.ts';

async function repository(scripts = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-orchestrator-finalization-'));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, 'docs'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'feature.txt'), 'base\n', 'utf8');
  writeFileSync(join(repoRoot, 'goal.md'), '# Goal\n', 'utf8');
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, scripts }), 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'test']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  return repoRoot;
}

function configFor(repoRoot, overrides = {}) {
  const { integration, verification, workspace, retry, status, ...rest } = overrides;
  const name = basename(repoRoot);
  return {
    ...DEFAULT_CONFIG,
    workspace: { ...DEFAULT_CONFIG.workspace, repoRoot, stateDir: join(tmpdir(), `${name}-state`), worktreesDir: join(tmpdir(), `${name}-worktrees`), ...workspace },
    retry: { ...DEFAULT_CONFIG.retry, ...retry },
    status: { ...DEFAULT_CONFIG.status, ...status },
    concurrency: 1,
    integration: { ...DEFAULT_CONFIG.integration, allowedPaths: ['docs/**'], ...integration },
    verification: { ...DEFAULT_CONFIG.verification, globalCommands: [], ...verification },
    ...rest
  };
}

function task() {
  return {
    id: 'T001',
    title: 'Change feature',
    description: 'Update the feature file.',
    dependsOn: [],
    allowedPaths: ['src/**'],
    blockedPaths: [],
    acceptance: ['feature is updated'],
    verificationCommands: []
  };
}

function integrationResult(status = 'completed', summary = 'finalized') {
  return { status, summary, testsRun: [], documentationUpdated: [], knownRisks: [] };
}

class ScriptBackend {
  id = 'claude';
  capabilities = { maxTurns: true, resumeSession: true };
  specs = [];

  constructor(handler) {
    this.handler = handler;
  }

  async discover() { return { backend: this.id, installed: true, authed: true }; }
  async listModels() { return []; }
  async probe() { return { ok: true, latencyMs: 1 }; }

  async openSession(spec) {
    this.specs.push(spec);
    return {
      async interrupt() {},
      async close() {},
      completion: async () => {
        const response = await this.handler(spec);
        return response && Object.hasOwn(response, 'ok')
          ? response
          : { ok: true, output: response, timedOut: false, stalled: false };
      }
    };
  }
}

function backendPool(backend) {
  return { claude: backend, codex: backend, opencode: backend };
}

function eventTypes(db, runId) {
  return db.db.prepare('SELECT event_type FROM events WHERE run_id = ? ORDER BY id').all(runId).map((row) => row.event_type);
}

async function createApprovedRun(db, config, id = 'run') {
  const baseSha = await currentHead(config.workspace.repoRoot);
  const manifest = { version: 1, title: 'Run', summary: 'test run', tasks: [task()] };
  db.createRun({ id, repoRoot: config.workspace.repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha, adapter: 'claude' });
  db.insertTask(id, task());
  db.updateRun(id, {
    status: 'planned', manifestJson: JSON.stringify(manifest), rolesJson: JSON.stringify(snapshotAgents(config))
  });
  mkdirSync(join(config.workspace.stateDir, 'runs', id), { recursive: true });

  const seed = mkdtempSync(join(tmpdir(), 'agent-team-finalization-seed-'));
  const worktree = join(seed, 'task');
  await git(config.workspace.repoRoot, ['worktree', 'add', '-q', '-b', `seed-${basename(seed)}`, worktree, baseSha]);
  writeFileSync(join(worktree, 'src', 'feature.txt'), 'implemented\n', 'utf8');
  await git(worktree, ['add', 'src/feature.txt']);
  await git(worktree, ['commit', '-q', '-m', 'task implementation']);
  const commitSha = await currentHead(worktree);
  db.updateTask(id, 'T001', { status: 'approved', phase: 'done', commitSha });
  return { commitSha, runDir: join(config.workspace.stateDir, 'runs', id) };
}

test('orchestrator finalizes without documentation changes and writes the terminal summary', async () => {
  const repoRoot = await repository({ verify: 'node -e ""' });
  const config = configFor(repoRoot, { verification: { globalCommands: ['npm run verify'] } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((spec) => {
    assert.equal(spec.role, 'integrator');
    assert.match(spec.label, /finalize$/);
    return integrationResult();
  });
  try {
    const { runDir } = await createApprovedRun(db, config);
    const events = [];
    await runOrchestrator({
      config,
      db,
      runId: 'run',
      backends: backendPool(backend),
      onAgentEvent: (execution, event) => events.push([execution.role, event.type])
    });

    const run = db.getRun('run');
    assert.equal(run.status, 'done');
    assert.equal(run.integrationCommit, await currentHead(run.integrationWorktree));
    assert.equal(backend.specs.length, 1);
    assert.deepEqual(events, [['integrator', 'activity']]);
    assert.equal(readFileSync(join(runDir, 'summary.txt'), 'utf8'), `Run run completed\nBranch: ${run.integrationBranch}\nCommit: ${run.integrationCommit}\n`);
    assert.match(readFileSync(join(runDir, 'logs', 'integration-verification.log'), 'utf8'), /\$ npm run verify/);
    assert.deepEqual(eventTypes(db, 'run').slice(-2), ['INTEGRATION_COMPLETED', 'RUN_COMPLETED']);
  } finally {
    db.close();
  }
});

test('orchestrator revalidates and commits permitted finalizer documentation', async () => {
  const repoRoot = await repository({ verify: 'node -e ""' });
  const config = configFor(repoRoot, { verification: { globalCommands: ['npm run verify'] } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((spec) => {
    assert.equal(spec.role, 'integrator');
    mkdirSync(join(spec.cwd, 'docs'), { recursive: true });
    writeFileSync(join(spec.cwd, 'docs', 'progress.md'), '# Progress\nIntegrated\n', 'utf8');
    return integrationResult();
  });
  try {
    const { commitSha, runDir } = await createApprovedRun(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    const run = db.getRun('run');
    assert.equal(run.status, 'done');
    assert.notEqual(run.integrationCommit, commitSha);
    assert.equal(readFileSync(join(run.integrationWorktree, 'docs', 'progress.md'), 'utf8'), '# Progress\nIntegrated\n');
    assert.equal((await git(run.integrationWorktree, ['log', '-1', '--format=%s'])).stdout.trim(), '[integration] update architecture and progress documentation');
    assert.match(readFileSync(join(runDir, 'logs', 'integration-verification.log'), 'utf8'), /\$ npm run verify/);
    assert.match(readFileSync(join(runDir, 'logs', 'integration-verification-after-docs.log'), 'utf8'), /\$ npm run verify/);
  } finally {
    db.close();
  }
});

test('orchestrator rejects finalizer documentation outside the integration policy', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((spec) => {
    writeFileSync(join(spec.cwd, 'outside.md'), 'not allowed\n', 'utf8');
    return integrationResult();
  });
  try {
    await createApprovedRun(db, config);
    await assert.rejects(
      runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) }),
      /Integrator modified paths outside policy: outside\.md/
    );
    assert.equal(db.getRun('run').status, 'failed');
  } finally {
    db.close();
  }
});

test('orchestrator stops before finalization when initial global verification fails', async () => {
  const repoRoot = await repository({ fail: 'node -e "process.exit(1)"' });
  const config = configFor(repoRoot, { verification: { globalCommands: ['npm run fail'] } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend(() => {
    throw new Error('finalizer must not start after failed global verification');
  });
  try {
    const { runDir } = await createApprovedRun(db, config);
    await assert.rejects(
      runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) }),
      /Global verification failed \(1\): npm run fail/
    );
    assert.equal(db.getRun('run').status, 'failed');
    assert.equal(backend.specs.length, 0);
    assert.match(readFileSync(join(runDir, 'logs', 'integration-verification.log'), 'utf8'), /\$ npm run fail/);
  } finally {
    db.close();
  }
});

test('orchestrator rejects documentation when post-finalization global verification fails', async () => {
  const repoRoot = await repository({
    verify: 'node -e "process.exit(require(\'node:fs\').existsSync(\'docs/progress.md\') ? 1 : 0)"'
  });
  const config = configFor(repoRoot, { verification: { globalCommands: ['npm run verify'] } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((spec) => {
    mkdirSync(join(spec.cwd, 'docs'), { recursive: true });
    writeFileSync(join(spec.cwd, 'docs', 'progress.md'), 'needs verification\n', 'utf8');
    return integrationResult();
  });
  try {
    const { runDir } = await createApprovedRun(db, config);
    await assert.rejects(
      runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) }),
      /Global verification failed \(1\): npm run verify/
    );
    const run = db.getRun('run');
    assert.equal(run.status, 'failed');
    assert.match((await git(run.integrationWorktree, ['status', '--porcelain'])).stdout, /^\?\? docs\//);
    assert.match(readFileSync(join(runDir, 'logs', 'integration-verification-after-docs.log'), 'utf8'), /\$ npm run verify/);
  } finally {
    db.close();
  }
});

test('orchestrator rejects a blocked finalizer result', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend(() => ({
    ...integrationResult('blocked', 'documentation needs a decision'),
    blockedReason: 'documentation needs a decision'
  }));
  try {
    await createApprovedRun(db, config);
    await assert.rejects(
      runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) }),
      /documentation needs a decision/
    );
    assert.equal(db.getRun('run').status, 'failed');
  } finally {
    db.close();
  }
});

test('orchestrator records a failed run when finalizer transport returns no result', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend(() => ({
    ok: false, output: null, error: 'finalizer transport closed', timedOut: false, stalled: false
  }));
  try {
    await createApprovedRun(db, config);
    await assert.rejects(
      runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) }),
      /Integrator finalization failed: finalizer transport closed/
    );
    assert.equal(db.getRun('run').status, 'failed');
  } finally {
    db.close();
  }
});

test('orchestrator rebuilds an interrupted integration worktree before finalization resumes', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const exitCode = process.exitCode;
  const interruptedBackend = new ScriptBackend((spec) => {
    assert.equal(spec.role, 'integrator');
    process.emit('SIGINT');
    return integrationResult();
  });
  const resumedBackend = new ScriptBackend((spec) => {
    assert.equal(spec.role, 'integrator');
    mkdirSync(join(spec.cwd, 'docs'), { recursive: true });
    writeFileSync(join(spec.cwd, 'docs', 'progress.md'), 'resumed\n', 'utf8');
    return integrationResult();
  });
  try {
    const { runDir } = await createApprovedRun(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(interruptedBackend) });

    assert.equal(db.getRun('run').status, 'running');
    assert.equal(existsSync(join(runDir, 'summary.txt')), false);

    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(resumedBackend) });

    const run = db.getRun('run');
    assert.equal(run.status, 'done');
    assert.equal(readFileSync(join(run.integrationWorktree, 'docs', 'progress.md'), 'utf8'), 'resumed\n');
    assert.equal(resumedBackend.specs.length, 1);
    assert.match(readFileSync(join(runDir, 'summary.txt'), 'utf8'), /Run run completed/);
  } finally {
    process.exitCode = exitCode;
    db.close();
  }
});

test('orchestrator records daemon aborts without setting the process exit code', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const controller = new AbortController();
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  let interrupted = 0;
  const backend = new ScriptBackend((spec) => {
    assert.equal(spec.role, 'worker');
    controller.abort();
    return { status: 'completed', summary: 'too late', testsRun: [], knownRisks: [], architectureImpact: 'none', progressImpact: 'none' };
  });
  const originalOpenSession = backend.openSession.bind(backend);
  backend.openSession = async (spec) => {
    const session = await originalOpenSession(spec);
    return { ...session, interrupt: async () => { interrupted += 1; } };
  };
  try {
    await createApprovedRun(db, config);
    db.updateTask('run', 'T001', { status: 'pending', phase: 'pending', commitSha: null });
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend), signal: controller.signal });

    assert.equal(interrupted, 1);
    assert.equal(process.exitCode, undefined);
    assert.equal(db.getRun('run').status, 'running');
    assert.equal(db.getRun('run').error, 'Interrupted by daemon; run again to resume.');
    assert.equal(eventTypes(db, 'run').includes('RUN_INTERRUPTED'), true);
  } finally {
    process.exitCode = exitCode;
    db.close();
  }
});

test('orchestrator handles an already aborted daemon signal without opening a session', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const controller = new AbortController();
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  controller.abort();
  const backend = new ScriptBackend(() => {
    throw new Error('agent must not start');
  });
  try {
    await createApprovedRun(db, config);
    db.updateTask('run', 'T001', { status: 'pending', phase: 'pending', commitSha: null });
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend), signal: controller.signal });

    assert.equal(backend.specs.length, 0);
    assert.equal(process.exitCode, undefined);
    assert.equal(db.getRun('run').error, 'Interrupted by daemon; run again to resume.');
  } finally {
    process.exitCode = exitCode;
    db.close();
  }
});
