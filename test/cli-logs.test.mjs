import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
  db.close();

  const output = [];
  let printedLog = false;
  const log = vi.spyOn(console, 'log').mockImplementation((value = '') => output.push(String(value)));
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await runCli(['logs', 'demo', '--list', '--repo', repo]);
    await runCli(['logs', 'demo', 'lead-1', '--repo', repo]);
    printedLog = write.mock.calls.some(([value]) => String(value).includes('[session] opened'));
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
  assert.match(output.join('\n'), /lead-1\tlead\tclaude\/sonnet\trunning/);
  assert.equal(printedLog, true);
});
