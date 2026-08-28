import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateDatabase } from '../src/core/db.ts';
import { runCliCommand } from './fixtures/run-cli.mjs';

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-cli-plan-run-'));
  const initialized = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  return root;
}

const cli = runCliCommand;

function writeUnavailableConfig(repo) {
  const command = `agent-team-no-backend-${process.pid}`;
  const stateDir = join(repo, '.agent-team');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    stateDir: '.agent-team',
    defaultAgent: 'default-agent',
    agents: {
      'default-agent': { backend: 'claude' },
      'override-agent': { backend: 'codex' }
    },
    roles: {},
    backends: {
      claude: { command },
      codex: { command },
      opencode: { command }
    }
  }), 'utf8');
  return command;
}

function createRun(repo, id, rolesJson) {
  const db = new StateDatabase(join(repo, '.agent-team', 'state.sqlite'));
  try {
    db.createRun({ id, repoRoot: repo, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'claude' });
    db.updateRun(id, { status: 'planned', rolesJson });
  } finally {
    db.close();
  }
}

function readRun(repo, id) {
  const db = new StateDatabase(join(repo, '.agent-team', 'state.sqlite'));
  try {
    return db.getRun(id);
  } finally {
    db.close();
  }
}

test('plan and launch fail before model work for invalid agents, unavailable backends, and missing option values', async () => {
  const repo = repository();
  try {
    const command = writeUnavailableConfig(repo);

    for (const [commandName, runId] of [['plan', 'plan-safe'], ['launch', 'launch-safe']]) {
      const result = await cli([commandName, 'goal.md', '--run-id', runId, '--repo', repo]);
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /Agent preflight failed:/);
      assert.match(result.stderr, new RegExp(`backend "claude" is not available locally \\(failed to spawn ${command}\\)`));
      assert.doesNotMatch(result.stderr, /Planning and running require an interactive terminal/);
    }

    const invalidAgent = await cli(['plan', 'goal.md', '--agent', 'unknown-agent', '--repo', repo]);
    assert.notEqual(invalidAgent.status, 0);
    assert.match(invalidAgent.stderr, /defaultAgent "unknown-agent" is not defined in the agents registry/);

    for (const args of [
      ['plan', 'goal.md', '--run-id', '--repo', repo],
      ['launch', 'goal.md', '--agent', '--repo', repo]
    ]) {
      const result = await cli(args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /requires a value/);
    }

    const db = new StateDatabase(join(repo, '.agent-team', 'state.sqlite'));
    try {
      assert.equal(db.listRuns().length, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('run retains saved roles, persists only valid role overrides, and rejects unknown options before orchestration', async () => {
  const repo = repository();
  try {
    const command = writeUnavailableConfig(repo);
    const savedRoles = {
      version: 2,
      agents: { 'saved-agent': { backend: 'claude' } },
      roles: Object.fromEntries(['lead', 'worker', 'reviewer', 'integrator'].map((role) => [role, {
        agent: 'saved-agent', backend: 'claude', source: 'saved snapshot'
      }]))
    };
    createRun(repo, 'saved-run', JSON.stringify(savedRoles));

    const overridden = await cli([
      'run', 'saved-run', '-c', 'roles.worker=override-agent', '--repo', repo
    ]);
    assert.notEqual(overridden.status, 0, overridden.stderr);
    assert.match(overridden.stderr, /Agent preflight failed:/);
    assert.match(overridden.stderr, new RegExp(`backend "codex" is not available locally \\(failed to spawn ${command}\\)`));
    assert.doesNotMatch(overridden.stderr, /Planning and running require an interactive terminal/);

    const updated = JSON.parse(readRun(repo, 'saved-run').rolesJson);
    assert.equal(updated.roles.worker.agent, 'override-agent');
    for (const role of ['lead', 'reviewer', 'integrator']) {
      assert.equal(updated.roles[role].agent, 'saved-agent');
    }

    const unknownOption = await cli(['run', 'saved-run', '--detach', '--repo', repo]);
    assert.notEqual(unknownOption.status, 0);
    assert.match(unknownOption.stderr, /Unknown run option: --detach/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('plan refuses non-TTY execution after a cached local preflight without contacting a model', async () => {
  const repo = repository();
  try {
    const stateDir = join(repo, '.agent-team');
    const fakeClaude = join(repo, 'fake-claude.mjs');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(fakeClaude, `#!/usr/bin/env node
if (process.argv.includes('--version')) process.stdout.write('fake-1\\n');
process.exit(process.argv.includes('--version') ? 0 : 1);
`, 'utf8');
    chmodSync(fakeClaude, 0o755);
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      stateDir: '.agent-team',
      defaultAgent: 'local-agent',
      agents: { 'local-agent': { backend: 'claude' } },
      roles: {},
      backends: { claude: { command: fakeClaude } }
    }), 'utf8');
    writeFileSync(join(stateDir, 'preflight-cache.json'), JSON.stringify({
      entries: {
        'claude|<backend-default>|fake-1': { ok: true, latencyMs: 0, checkedAt: Date.now() }
      }
    }), 'utf8');

    const result = await cli(['plan', 'goal.md', '--repo', repo]);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /Planning and running require an interactive terminal/);
    assert.doesNotMatch(result.stdout, /Planned run:/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
