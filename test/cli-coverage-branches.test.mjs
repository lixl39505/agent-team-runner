import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const loaderPath = fileURLToPath(new URL('./fixtures/cli-coverage-loader.mjs', import.meta.url));

function mockedCli(args, env = {}) {
  const result = spawnSync(process.execPath, ['--experimental-loader', loaderPath, cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  assert.equal(result.error?.code, undefined, result.error?.message);
  return result;
}

test('doctor renders every optional diagnostic outcome', () => {
  const result = mockedCli(['doctor', '--probe', '--repo', '/tmp/cli-coverage']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claude: available \(not authenticated\)/);
  assert.match(result.stdout, /codex: new-codex/);
  assert.match(result.stdout, /opencode: unavailable/);
  assert.match(result.stdout, /generated for "old-codex"/);
  assert.match(result.stdout, /claude: 7 models . model-0, model-1, model-2, model-3, model-4, model-5, ./);
  assert.match(result.stdout, /codex: enumeration failed \(string enumeration failure\)/);
  assert.match(result.stdout, /with-model: claude \(alpha\)/);
  assert.match(result.stdout, /lead: with-model . claude \(alpha\) \[mock\]/);
  assert.match(result.stdout, /error: syntax error/);
  assert.match(result.stdout, /warn: availability warning/);
  assert.match(result.stdout, /claude\/alpha: ok \(0ms\)/);
  assert.match(result.stdout, /codex: FAILED — probe failed/);
  assert.match(result.stdout, /opencode: FAILED/);
});

test('CLI formats non-Error top-level failures', () => {
  const result = mockedCli(['list', '--repo', '/tmp/cli-coverage'], { AGENT_TEAM_CLI_THROW_STRING: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mock string failure/);
});

test('CLI uses saved-role fallbacks and an Error message when no stack is available', () => {
  const run = mockedCli(['run', 'run', '-c', 'roles.worker=with-model', '--repo', '/tmp/cli-coverage']);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Planning and running require an interactive terminal/);

  const error = mockedCli(['list', '--repo', '/tmp/cli-coverage'], { AGENT_TEAM_CLI_THROW_MESSAGE: '1' });
  assert.notEqual(error.status, 0);
  assert.match(error.stderr, /mock error message/);
});
