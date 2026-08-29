import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateDatabase } from '../src/core/db.ts';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-cli-terminal-final-'));
  const initialized = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  mkdirSync(join(root, '.agent-team'), { recursive: true });
  writeFileSync(join(root, '.agent-team', 'config.json'), JSON.stringify({ version: 3, workspace: {}, retry: {}, status: {} }));
  return root;
}

function writeLocalCodex(repo) {
  const command = join(repo, 'local-codex.mjs');
  const modelCalls = join(repo, 'model-calls.log');
  writeFileSync(command, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('tty-local-codex-1\\n');
  process.exit(0);
}

process.stdin.setEncoding('utf8');
let buffer = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') reply(request.id, {});
    else if (request.method === 'model/list') reply(request.id, { data: [] });
    else if (request.method === 'thread/start' || request.method === 'turn/start') {
      appendFileSync(${JSON.stringify(modelCalls)}, request.method + '\\n');
      reply(request.id, {});
    } else if (request.id !== undefined) reply(request.id, {});
  }
});
`, 'utf8');
  chmodSync(command, 0o755);
  return { command, modelCalls };
}

function writeConfig(repo, command) {
  const stateDir = join(repo, '.agent-team');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    version: 3,
    workspace: { stateDir: '.agent-team' },
    retry: {},
    status: {},
    defaultAgent: 'local-agent',
    agents: { 'local-agent': { backend: 'codex' } },
    roles: {},
    backends: { codex: { command } }
  }), 'utf8');
  // The cached successful probe lets these CLI paths test terminal behavior only.
  writeFileSync(join(stateDir, 'preflight-cache.json'), JSON.stringify({
    entries: {
      'codex:shared|<backend-default>|tty-local-codex-1': { ok: true, latencyMs: 0, checkedAt: Date.now() }
    }
  }), 'utf8');
}

function createRun(repo, id, status) {
  const db = new StateDatabase(join(repo, '.agent-team', 'state.sqlite'));
  try {
    db.createRun({ id, repoRoot: repo, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'codex' });
    db.updateRun(id, { status });
  } finally {
    db.close();
  }
}

function cli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error?.code, undefined, result.error?.message);
  return result;
}

function ptyCli(args) {
  const result = spawnSync('expect', [
    '-c',
    'set timeout 10; spawn -noecho sh -c $env(AGENT_TEAM_TTY_COMMAND); expect eof; set result [wait]; exit [lindex $result 3]'
  ], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      AGENT_TEAM_TTY_COMMAND: [process.execPath, cliPath, ...args].map((value) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`).join(' ')
    }
  });
  assert.equal(result.error?.code, undefined, result.error?.message);
  return result;
}

function stdinTtyCli(args) {
  const command = [process.execPath, cliPath, ...args].map((value) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`).join(' ');
  const result = spawnSync('expect', [
    '-c',
    'set timeout 10; spawn -noecho sh -c $env(AGENT_TEAM_TTY_COMMAND); expect eof; set result [wait]; exit [lindex $result 3]'
  ], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, AGENT_TEAM_TTY_COMMAND: `${command} >/dev/null` }
  });
  assert.equal(result.error?.code, undefined, result.error?.message);
  return result;
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

async function waitForOutput(run, expression) {
  await new Promise((resolve, reject) => {
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

test('status watch clears the terminal and exits cleanly on SIGINT', async () => {
  const repo = repository();
  try {
    createRun(repo, 'watched', 'running');
    const watch = startCli(['status', 'watched', '--watch', '--repo', repo]);
    try {
       await waitForOutput(watch, /RUN watched/);
       assert.equal(watch.child.kill('SIGINT'), true);
       const result = await watch.exited;
       assert.ok(result.code === 0 || result.signal === 'SIGINT');
      assert.match(watch.output().stdout, /\x1BcRUN watched/);
    } finally {
      if (watch.child.exitCode === null) watch.child.kill('SIGKILL');
      await watch.exited;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('run and launch require a TTY but accept one without starting a model turn', () => {
  const repo = repository();
  try {
    const { command, modelCalls } = writeLocalCodex(repo);
    writeConfig(repo, command);
    createRun(repo, 'finished-run', 'done');

    const rejectedRun = cli(['run', 'finished-run', '--repo', repo]);
    assert.notEqual(rejectedRun.status, 0);
    assert.match(rejectedRun.stderr, /Planning and running require an interactive terminal/);

    const stdoutRedirectedRun = stdinTtyCli(['run', 'finished-run', '--repo', repo]);
    assert.notEqual(stdoutRedirectedRun.status, 0);
    assert.match(stdoutRedirectedRun.stdout + stdoutRedirectedRun.stderr, /Planning and running require an interactive terminal/);

    const acceptedRun = ptyCli(['run', 'finished-run', '--repo', repo]);
    assert.equal(acceptedRun.status, 0, acceptedRun.stderr);
    assert.match(acceptedRun.stdout, /RUN finished-run/);
    assert.doesNotMatch(acceptedRun.stdout, /Planning and running require an interactive terminal/);

    const rejectedLaunch = cli(['launch', 'missing-goal.md', '--repo', repo]);
    assert.notEqual(rejectedLaunch.status, 0);
    assert.match(rejectedLaunch.stderr, /Planning and running require an interactive terminal/);
    assert.doesNotMatch(rejectedLaunch.stderr, /missing-goal\.md/);

    const acceptedLaunch = ptyCli(['launch', 'missing-goal.md', '--repo', repo]);
    assert.notEqual(acceptedLaunch.status, 0);
    assert.match(acceptedLaunch.stdout + acceptedLaunch.stderr, /missing-goal\.md/);
    assert.doesNotMatch(acceptedLaunch.stdout + acceptedLaunch.stderr, /Planning and running require an interactive terminal/);
    assert.equal(existsSync(modelCalls), false, 'TTY and preflight paths must not start an agent turn');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
