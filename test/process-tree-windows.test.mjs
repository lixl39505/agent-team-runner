import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { killProcessTree } from '../src/agent/process-tree.ts';

const windowsTest = process.platform === 'win32' ? test : test.skip;
const execFileAsync = promisify(execFile);

async function waitForFile(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

windowsTest('taskkill terminates managed process descendants', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-process-tree-'));
  const descendantPidFile = join(dir, 'descendant.pid');
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);'
  ].join('\n');
  const parent = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  await waitForFile(descendantPidFile);
  const descendantPid = readFileSync(descendantPidFile, 'utf8').trim();
  const closed = new Promise((resolve) => parent.once('close', resolve));
  killProcessTree(parent, 'SIGTERM');
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `PID eq ${descendantPid}`, '/FO', 'CSV', '/NH']);
  assert.equal(stdout.includes(`"${descendantPid}"`), false, 'taskkill /T must terminate the child process too');
});
