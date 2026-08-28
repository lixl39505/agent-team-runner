import { test } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { StateDatabase } from '../src/core/db.ts';
import { currentHead, git } from '../src/core/git.ts';
import { snapshotAgents } from '../src/agent/registry.ts';
import { runOrchestrator } from '../src/core/orchestrator.ts';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function repository(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'feature.txt'), 'base\n', 'utf8');
  writeFileSync(join(root, 'goal.md'), '# Goal\n', 'utf8');
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'test']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'base']);
  return root;
}

function configFor(repoRoot, overrides = {}) {
  const { workspace, retry, status, ...rest } = overrides;
  const name = basename(repoRoot);
  return {
    ...DEFAULT_CONFIG,
    workspace: { ...DEFAULT_CONFIG.workspace, repoRoot, stateDir: join(tmpdir(), `${name}-state`), worktreesDir: join(tmpdir(), `${name}-worktrees`), ...workspace },
    retry: { ...DEFAULT_CONFIG.retry, ...retry },
    status: { ...DEFAULT_CONFIG.status, ...status },
    concurrency: 1,
    verification: { ...DEFAULT_CONFIG.verification, globalCommands: [] },
    ...rest
  };
}

function task(id, dependsOn = [], extra = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: `Implement ${id}.`,
    dependsOn,
    allowedPaths: ['src/**'],
    blockedPaths: [],
    acceptance: ['implementation is present'],
    verificationCommands: [],
    ...extra
  };
}

class FixedBackend {
  id = 'codex';
  capabilities = { maxTurns: true, resumeSession: true };
  specs = [];
  disposeCalls = 0;

  async discover() { return { backend: this.id, installed: true, authed: true }; }
  async listModels() { return []; }
  async probe() { return { ok: true, latencyMs: 0 }; }
  dispose() { this.disposeCalls += 1; }

  async openSession(spec) {
    this.specs.push(spec);
    return {
      async interrupt() {},
      async close() {},
      completion: async () => {
        if (spec.role === 'worker') {
          writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'worker complete\n', 'utf8');
          return {
            ok: true,
            output: { status: 'completed', summary: 'implemented', testsRun: [], knownRisks: [], architectureImpact: 'none', progressImpact: 'none' },
            timedOut: false,
            stalled: false
          };
        }
        if (spec.role === 'reviewer') {
          return { ok: true, output: { decision: 'approved', summary: 'reviewed', findings: [], requiredChanges: [] }, timedOut: false, stalled: false };
        }
        return { ok: true, output: { status: 'completed', summary: 'integrated', testsRun: [], documentationUpdated: [], knownRisks: [] }, timedOut: false, stalled: false };
      }
    };
  }
}

async function committedDependency(repoRoot, branch, file, content) {
  const worktree = mkdtempSync(join(tmpdir(), 'agent-team-final-dependency-'));
  rmSync(worktree, { recursive: true, force: true });
  await git(repoRoot, ['worktree', 'add', '-q', '-b', branch, worktree, 'HEAD']);
  writeFileSync(join(worktree, 'src', file), content, 'utf8');
  await git(worktree, ['add', '-A']);
  await git(worktree, ['commit', '-q', '-m', branch]);
  return await currentHead(worktree);
}

test('orchestrator injects recursive dependencies, records bound agents, and disposes supplied backends', async () => {
  const repoRoot = await repository('agent-team-orchestrator-cli-final-');
  const config = configFor(repoRoot, {
    agents: {
      'default-codex': { backend: 'codex' },
      'task-codex': { backend: 'codex', model: 'mock-model' }
    },
    defaultAgent: 'default-codex',
    integration: { ...DEFAULT_CONFIG.integration, runAgentAfterCherryPick: true }
  });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new FixedBackend();
  try {
    const baseSha = await currentHead(repoRoot);
    const firstCommit = await committedDependency(repoRoot, 'final-dependency-one', 'one.txt', 'one\n');
    const secondCommit = await committedDependency(repoRoot, 'final-dependency-two', 'two.txt', 'two\n');
    const tasks = [task('T01'), task('T02', ['T01']), task('T03', ['T02'], { agent: 'task-codex' })];
    const manifest = { version: 1, title: 'Recursive dependencies', summary: 'test', tasks };
    db.createRun({ id: 'run', repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha, adapter: 'codex' });
    for (const spec of tasks) db.insertTask('run', spec);
    db.updateRun('run', { status: 'planned', manifestJson: JSON.stringify(manifest), rolesJson: JSON.stringify(snapshotAgents(config)) });
    db.updateTask('run', 'T01', { status: 'approved', phase: 'done', commitSha: firstCommit });
    db.updateTask('run', 'T02', { status: 'approved', phase: 'done', commitSha: secondCommit });

    await runOrchestrator({
      config,
      db,
      runId: 'run',
      backends: { claude: backend, codex: backend, opencode: backend },
      requestApproval: async () => 'once',
      requestUserInput: async () => ({})
    });

    assert.equal(db.getRun('run').status, 'done');
    assert.equal(db.getTask('run', 'T03').status, 'approved');
    const worker = backend.specs.find((spec) => spec.role === 'worker');
    assert.equal(worker.model, 'mock-model');
    assert.equal(worker.requestApproval instanceof Function, true);
    assert.equal(worker.requestUserInput instanceof Function, true);
    const started = db.db.prepare("SELECT payload_json FROM events WHERE run_id = ? AND event_type = 'WORKER_STARTED'").get('run');
    assert.match(started.payload_json, /"agent":"task-codex"/);
    assert.match(started.payload_json, /"model":"mock-model"/);
    assert.ok(backend.specs.some((spec) => spec.role === 'reviewer'));
    assert.ok(backend.specs.some((spec) => spec.role === 'integrator'));
    assert.ok(backend.disposeCalls >= 3);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

function writeMockCodex(repoRoot) {
  const command = join(repoRoot, 'mock-codex.mjs');
  writeFileSync(command, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  process.stdout.write('mock-codex-1\\n');
  process.exit(0);
}

let nextThread = 0;
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ method, params }) + '\\n');
const manifest = {
  version: 1,
  title: 'Mock launch',
  summary: 'local-only',
  tasks: [{ id: 'T001', title: 'Mock task', description: 'Write a fixture.', dependsOn: [], allowedPaths: ['src/**'], blockedPaths: [], acceptance: ['fixture exists'], verificationCommands: [] }]
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') return reply(request.id, {});
  if (request.method === 'model/list') return reply(request.id, { data: [] });
  if (request.method === 'thread/start') return reply(request.id, { thread: { id: 'thread-' + (++nextThread) } });
  if (request.method !== 'turn/start') return reply(request.id, {});

  const schema = request.params.outputSchema || {};
  let output = 'ok';
  if (schema.properties?.tasks) output = manifest;
  else if (schema.properties?.architectureImpact) {
    writeFileSync(join(request.params.cwd, 'src', 'feature.txt'), 'launched locally\\n', 'utf8');
    output = { status: 'completed', summary: 'worker complete', testsRun: [], knownRisks: [], architectureImpact: 'none', progressImpact: 'none' };
  } else if (schema.properties?.decision) output = { decision: 'approved', summary: 'review complete', findings: [], requiredChanges: [] };
  else if (schema.properties?.documentationUpdated) output = { status: 'completed', summary: 'integration complete', testsRun: [], documentationUpdated: [], knownRisks: [] };
  reply(request.id, {});
  setTimeout(() => {
    notify('item/completed', { threadId: request.params.threadId, item: { id: 'message', type: 'agentMessage', text: JSON.stringify(output) } });
    notify('turn/completed', { threadId: request.params.threadId, turn: { status: 'completed', error: null } });
  }, 5);
});
`, 'utf8');
  chmodSync(command, 0o755);
  return command;
}

function writeCliConfig(repoRoot, command) {
  mkdirSync(join(repoRoot, '.agent-team'), { recursive: true });
  writeFileSync(join(repoRoot, '.agent-team', 'config.json'), JSON.stringify({
    version: 3,
    workspace: { stateDir: '.agent-team' },
    retry: {},
    status: {},
    defaultAgent: 'mock-agent',
    agents: { 'mock-agent': { backend: 'codex' } },
    roles: {},
    backends: {
      claude: { command: `missing-claude-${process.pid}` },
      codex: { command },
      opencode: { command: `missing-opencode-${process.pid}` }
    },
    verification: { globalCommands: [] }
  }), 'utf8');
}

function ptyCli(args) {
  return spawnSync('expect', [
    '-c',
    'set timeout 20; spawn -noecho sh -c $env(AGENT_TEAM_TTY_COMMAND); expect eof; set result [wait]; exit [lindex $result 3]'
  ], {
    encoding: 'utf8',
    timeout: 25_000,
    env: {
      ...process.env,
      AGENT_TEAM_TTY_COMMAND: [process.execPath, cliPath, ...args].map((value) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`).join(' ')
    }
  });
}

test('CLI probes and launches through a temporary local backend without real AI', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-cli-final-'));
  try {
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'feature.txt'), 'base\n', 'utf8');
    writeFileSync(join(repoRoot, 'goal.md'), '# Mock goal\n', 'utf8');
    assert.equal(spawnSync('git', ['init', '-q', repoRoot], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', repoRoot, 'config', 'user.name', 'test'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', repoRoot, 'add', '-A'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', repoRoot, 'commit', '-q', '-m', 'base'], { encoding: 'utf8' }).status, 0);
    writeCliConfig(repoRoot, writeMockCodex(repoRoot));

    const doctor = ptyCli(['doctor', '--probe', '--repo', repoRoot]);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /Probes:/);
    assert.match(doctor.stdout, /codex: ok \(/);

    const launch = ptyCli(['launch', 'goal.md', '--run-id', 'mock-launch', '--repo', repoRoot]);
    assert.equal(launch.status, 0, launch.stderr);
    assert.match(launch.stdout, /Planned run: mock-launch/);
    const db = new StateDatabase(join(repoRoot, '.agent-team', 'state.sqlite'));
    try {
      assert.equal(db.getRun('mock-launch').status, 'done', launch.stdout);
      assert.equal(db.getTask('mock-launch', 'T001').status, 'approved');
    } finally {
      db.close();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
