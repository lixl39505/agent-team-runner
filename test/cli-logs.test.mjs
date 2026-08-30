import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { StateDatabase } from '../src/core/db.ts';
import { runCli } from '../src/cli.ts';

test('logs lists tracked Agent executions and prints a selected log', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-cli-logs-'));
  const stateDir = join(repo, '.agent-team');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ version: 3, workspace: { stateDir: '.agent-team' }, retry: {}, status: {} }));
  const logPath = join(stateDir, 'runs', 'demo', 'logs', 'lead-1.log');
  mkdirSync(join(stateDir, 'runs', 'demo', 'logs'), { recursive: true });
  writeFileSync(logPath, '[session] opened\n', 'utf8');
  const db = new StateDatabase(join(stateDir, 'state.sqlite'));
  db.createRun({ id: 'demo', repoRoot: repo, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'claude' });
  db.startAgentExecution({ runId: 'demo', agentId: 'lead-1', role: 'lead', backend: 'claude', model: 'sonnet', logPath });
  db.startAgentExecution({ runId: 'demo', agentId: 'worker-1', role: 'worker', backend: 'codex', logPath: join(stateDir, 'missing.log') });
  db.close();

  const output = [];
  let printedLog = false;
  const log = vi.spyOn(console, 'log').mockImplementation((value = '') => output.push(String(value)));
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await runCli(['logs', 'demo', '--list', '--repo', repo]);
    await runCli(['logs', 'demo', 'lead-1', '--repo', repo]);
    await runCli(['logs', 'demo', 'worker-1', '--repo', repo]);
    await assert.rejects(runCli(['logs', 'demo', 'worker-1', '--follow', '--repo', repo]), /ENOENT/);
    printedLog = write.mock.calls.some(([value]) => String(value).includes('[session] opened'));
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
  assert.match(output.join('\n'), /lead-1\tlead\tclaude\/sonnet\trunning/);
  assert.match(output.join('\n'), /worker-1\tworker\tcodex\trunning/);
  assert.equal(printedLog, true);
});

test('logs follow prints appended and truncated content until interrupted', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-cli-follow-'));
  const stateDir = join(repo, '.agent-team');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ version: 3, workspace: { stateDir: '.agent-team' }, retry: {}, status: {} }));
  const logPath = join(stateDir, 'agent.log');
  writeFileSync(logPath, 'initial\n', 'utf8');
  const db = new StateDatabase(join(stateDir, 'state.sqlite'));
  db.createRun({ id: 'demo', repoRoot: repo, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'claude' });
  db.startAgentExecution({ runId: 'demo', agentId: 'lead-1', role: 'lead', backend: 'claude', logPath });
  db.close();

  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((value) => { output += String(value); return true; });
  try {
    const following = runCli(['logs', 'demo', 'lead-1', '--follow', '--repo', repo]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    appendFileSync(logPath, 'append\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    truncateSync(logPath, 0);
    appendFileSync(logPath, 'replaced\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    unlinkSync(logPath);
    await new Promise((resolve) => setTimeout(resolve, 30));
    process.emit('SIGINT');
    await following;
  } finally {
    write.mockRestore();
  }
  assert.match(output, /initial/);
  assert.match(output, /append/);
  assert.match(output, /replaced/);
});

test('logs reports invalid argument combinations before reading state', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-cli-logs-errors-'));
  mkdirSync(join(repo, '.agent-team'), { recursive: true });
  writeFileSync(join(repo, '.agent-team', 'config.json'), JSON.stringify({ version: 3, workspace: { stateDir: '.agent-team' }, retry: {}, status: {} }));
  await assert.rejects(runCli(['logs', '--repo', repo]), /Usage:/);
  await assert.rejects(runCli(['logs', 'demo', '--repo', repo]), /requires an agent ID/);
  await assert.rejects(runCli(['logs', 'demo', 'lead-1', '--list', '--repo', repo]), /does not accept an agent ID/);
  await assert.rejects(runCli(['logs', 'demo', '--list', '--unknown', '--repo', repo]), /Unknown logs option/);
});
