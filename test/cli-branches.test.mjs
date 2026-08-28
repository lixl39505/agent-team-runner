import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { StateDatabase } from '../src/core/db.ts';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-cli-branches-'));
  const initialized = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  return root;
}

function startCli(args) {
  const child = spawn(process.execPath, [cliPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, output: () => ({ stdout, stderr }) };
}

async function cli(args) {
  const run = startCli(args);
  const timeout = setTimeout(() => run.child.kill('SIGKILL'), 10_000);
  try {
    const result = await run.exited;
    return { ...result, ...run.output() };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForOutput(run, expression) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`CLI did not print ${expression}: ${run.output().stdout}${run.output().stderr}`));
    }, 5_000);
    const onData = () => {
      if (!expression.test(run.output().stdout)) return;
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`CLI exited before printing ${expression}: ${run.output().stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      run.child.stdout.off('data', onData);
      run.child.off('close', onClose);
    };
    run.child.stdout.on('data', onData);
    run.child.once('close', onClose);
    onData();
  });
}

async function stop(run, signal = 'SIGTERM') {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill(signal);
  return await run.exited;
}

function populateRuns(repo, stateDir = join(repo, '.agent-team')) {
  const db = new StateDatabase(join(stateDir, 'state.sqlite'));
  try {
    db.createRun({ id: 'other-run', repoRoot: repo, goalFile: 'other.md', baseRef: 'HEAD', baseSha: '0123456789abcdef', adapter: 'claude' });
    db.updateRun('other-run', { status: 'done' });
    db.createRun({ id: 'watched-run', repoRoot: repo, goalFile: 'watched.md', baseRef: 'HEAD', baseSha: 'fedcba9876543210', adapter: 'codex' });
    db.updateRun('watched-run', { status: 'running' });
  } finally {
    db.close();
  }
}

test('CLI lists persisted runs and stops status watch cleanly on SIGTERM', async () => {
  const repo = repository();
  try {
    populateRuns(repo);

    const listed = await cli(['list', '--repo', repo]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /^other-run\tdone\t/m);
    assert.match(listed.stdout, /^watched-run\trunning\t/m);

    const selected = await cli(['status', 'watched-run', '--repo', repo]);
    assert.equal(selected.code, 0, selected.stderr);
    assert.match(selected.stdout, /^RUN watched-run$/m);
    assert.match(selected.stdout, /^Status: running$/m);
    assert.doesNotMatch(selected.stdout, /^RUN other-run$/m);

    const watch = startCli(['status', 'watched-run', '--watch', '--repo', repo]);
    try {
      await waitForOutput(watch, /RUN watched-run/);
      const stopped = await stop(watch);
      assert.equal(stopped.code, 0);
      assert.equal(stopped.signal, null);
      assert.match(watch.output().stdout, /\x1BcRUN watched-run/);
    } finally {
      await stop(watch, 'SIGKILL');
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI applies repeated overrides, rejects malformed overrides, and displays unavailable doctor commands', async () => {
  const repo = repository();
  const alternateStateDir = join(repo, 'alternate-state');
  try {
    populateRuns(repo, alternateStateDir);

    const repeated = await cli([
      'list', '--repo', repo,
      '-c', `stateDir=${join(repo, 'unused-state')}`,
      '-c', `stateDir=${alternateStateDir}`
    ]);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /^watched-run\trunning\t/m);

    const malformed = await cli(['list', '--repo', repo, '-c', 'stateDir']);
    assert.notEqual(malformed.code, 0);
    assert.match(malformed.stderr, /Invalid -c override "stateDir": expected <path>=<value>/);

    const missingCommand = `agent-team-missing-${process.pid}`;
    const configDir = join(repo, '.agent-team');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      stateDir: alternateStateDir,
      backends: {
        claude: { command: missingCommand },
        codex: { command: missingCommand },
        opencode: { command: missingCommand }
      }
    }), 'utf8');

    const doctor = await cli(['doctor', '--repo', repo]);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.match(doctor.stdout, /Backends:/);
    assert.match(doctor.stdout, new RegExp(`claude: unavailable \\(failed to spawn ${missingCommand}\\)`));
    assert.match(doctor.stdout, new RegExp(`codex: unavailable \\(failed to spawn ${missingCommand}\\)`));
    assert.match(doctor.stdout, new RegExp(`opencode: unavailable \\(failed to spawn ${missingCommand}\\)`));
    assert.match(doctor.stdout, /Models:/);
    assert.match(doctor.stdout, /enumeration failed/);
    assert.doesNotMatch(doctor.stdout, /Probes:/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
