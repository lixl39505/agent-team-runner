import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runCli } from '../src/cli.ts';

test('auth set rejects command-line keys before attempting terminal input', async () => {
  await assert.rejects(
    runCli(['auth', 'set', '--backend', 'codex', '--profile', 'work', '--key', 'secret']),
    /does not accept --key/
  );
});

test('auth login directs users to the backend native CLI', async () => {
  await assert.rejects(
    runCli(['auth', 'login', '--backend', 'opencode']),
    /OAuth login is not supported; use the opencode native CLI to log in/
  );
});
