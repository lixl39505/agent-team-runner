import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateDatabase } from '../src/core/db.ts';
import { runCliCommand } from './fixtures/run-cli.mjs';

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-cli-success-final-'));
  const initialized = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  mkdirSync(join(root, '.agent-team'), { recursive: true });
  writeFileSync(join(root, '.agent-team', 'config.json'), JSON.stringify({ version: 3, workspace: {}, retry: {}, status: {} }));
  return root;
}

const cli = runCliCommand;

function createRun(repo, id, status = 'planned') {
  const db = new StateDatabase(join(repo, '.agent-team', 'state.sqlite'));
  try {
    db.createRun({ id, repoRoot: repo, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: '0123456789abcdef', adapter: 'codex' });
    db.updateRun(id, { status });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function writeLocalCodex(repo, command = join(repo, 'local-codex.mjs'), {
  version = 'local-codex-1',
  models = [{ id: 'local-model', displayName: 'Local model' }]
} = {}) {
  writeFileSync(command, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(version)} + '\\n');
  process.exit(0);
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    const result = request.method === 'model/list'
      ? { data: ${JSON.stringify(models)} }
      : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
  }
});
`, 'utf8');
  chmodSync(command, 0o755);
  return command;
}

function writeConfig(repo, codexCommand, model) {
  const stateDir = join(repo, '.agent-team');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    version: 3,
    workspace: { stateDir: '.agent-team' },
    retry: {},
    status: {},
    defaultAgent: 'local-agent',
    agents: { 'local-agent': { backend: 'codex', ...(model ? { model } : {}) } },
    roles: {},
    backends: {
      claude: { command: `agent-team-missing-claude-${process.pid}` },
      codex: { command: codexCommand },
      opencode: { command: `agent-team-missing-opencode-${process.pid}` }
    }
  }), 'utf8');
}

function cacheLocalCodex(repo) {
  writeFileSync(join(repo, '.agent-team', 'preflight-cache.json'), JSON.stringify({
    entries: {
      'codex|<backend-default>|local-codex-1': { ok: true, latencyMs: 0, checkedAt: Date.now() }
    }
  }), 'utf8');
}

test('doctor reports local backend and model success without probing', async () => {
  const repo = repository();
  try {
    const command = writeLocalCodex(repo);
    writeConfig(repo, command);

    const result = await cli(['doctor', '--repo', repo]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Node: v/m);
    assert.match(result.stdout, new RegExp(`^Repository: ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(result.stdout, /^Backends:$/m);
    assert.match(result.stdout, /^  codex: local-codex-1$/m);
    assert.match(result.stdout, /^Models:$/m);
    assert.match(result.stdout, /^  codex: 1 models \u2014 local-model$/m);
    assert.match(result.stdout, /^Agents:$/m);
    assert.match(result.stdout, /^  local-agent: codex$/m);
    assert.match(result.stdout, /^Roles:$/m);
    assert.match(result.stdout, /^  lead: local-agent . codex \[defaultAgent\]$/m);
    assert.doesNotMatch(result.stdout, /^Probes:$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('doctor renders available backends without versions and truncates long model lists', async () => {
  const repo = repository();
  try {
    const models = Array.from({ length: 7 }, (_, index) => ({ id: `model-${index + 1}` }));
    const command = writeLocalCodex(repo, undefined, { version: '', models });
    writeConfig(repo, command, 'model-1');

    const result = await cli(['doctor', '--repo', repo]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^  codex: available$/m);
    assert.match(result.stdout, /^  codex: 7 models . model-1, model-2, model-3, model-4, model-5, model-6, .$/m);
    assert.match(result.stdout, /^  local-agent: codex \(model-1\)$/m);
    assert.match(result.stdout, /^  lead: local-agent . codex \(model-1\) \[defaultAgent\]$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('list and status render persisted runs and task errors together', async () => {
  const repo = repository();
  try {
    const db = createRun(repo, 'failed-run', 'failed');
    try {
      db.updateRun('failed-run', { error: 'integration failed' });
      db.insertTask('failed-run', { id: 'T1', title: 'Broken task', dependencies: [], verificationCommands: [] });
      db.updateTask('failed-run', 'T1', { status: 'failed', attempts: 2, lastError: 'local command failed' });
      db.createRun({ id: 'done-run', repoRoot: repo, goalFile: 'done.md', baseRef: 'HEAD', baseSha: 'fedcba9876543210', adapter: 'claude' });
      db.updateRun('done-run', { status: 'done' });
    } finally {
      db.close();
    }

    const listed = await cli(['list', '--repo', repo]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^failed-run\tfailed\t/m);
    assert.match(listed.stdout, /^done-run\tdone\t/m);

    const status = await cli(['status', 'failed-run', '--repo', repo]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^RUN failed-run$/m);
    assert.match(status.stdout, /^Status: failed$/m);
    assert.match(status.stdout, /^T1    failed             Broken task attempt=2$/m);
    assert.match(status.stdout, /^      local command failed$/m);
    assert.match(status.stdout, /^Run error: integration failed$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('init preserves an existing configuration and skills handles unknown and extra arguments', async () => {
  const repo = repository();
  try {
    const configDir = join(repo, '.agent-team');
    const existing = 'version: 3\nworkspace: {}\nretry: {}\nstatus: {}\ndefaultAgent: existing-agent\n';
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yml'), existing, 'utf8');

    const initialized = await cli(['init', repo]);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /Initialized: .*\.agent-team\/config\.yml/);
    assert.equal(readFileSync(join(configDir, 'config.yml'), 'utf8'), existing);
    assert.equal(existsSync(join(repo, '.claude', 'skills', 'team-lead', 'SKILL.md')), true);

    const unknown = await cli(['skills', 'unknown', '--repo', repo]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Usage: agent-team skills sync/);

    const extra = await cli(['skills', 'sync', 'ignored-argument', '--repo', repo]);
    assert.equal(extra.status, 0, extra.stderr);
    assert.match(extra.stdout, /team-lead/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('plan and run stop after successful local preflight or before execution on local failure', async () => {
  const repo = repository();
  try {
    const command = writeLocalCodex(repo);
    writeConfig(repo, command);
    cacheLocalCodex(repo);
    const db = createRun(repo, 'local-run');
    db.close();

    for (const args of [
      ['plan', 'goal.md', '--repo', repo],
      ['run', 'local-run', '--repo', repo]
    ]) {
      const result = await cli(args);
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /Planning and running require an interactive terminal/);
      assert.doesNotMatch(result.stderr, /Agent preflight failed/);
    }

    const missing = `agent-team-missing-codex-${process.pid}`;
    writeConfig(repo, missing);
    for (const args of [
      ['plan', 'goal.md', '--repo', repo],
      ['run', 'local-run', '--repo', repo]
    ]) {
      const result = await cli(args);
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /Agent preflight failed:/);
      assert.match(result.stderr, new RegExp(`backend "codex" is not available locally \\(failed to spawn ${missing}\\)`));
      assert.doesNotMatch(result.stderr, /Planning and running require an interactive terminal/);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
