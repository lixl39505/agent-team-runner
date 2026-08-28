// Real backend integration test; enabled only with local Claude authentication.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ClaudeBackend } from '../src/agent/claude/sdk.ts';
import { runAgent } from '../src/agent/supervise.ts';

const maybeTest = process.env.AGENT_TEAM_INTEGRATION === '1' ? test : test.skip;

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-claude-spike-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'other'), { recursive: true });
  writeFileSync(join(dir, 'src', 'allowed.txt'), 'base\n', 'utf8');
  writeFileSync(join(dir, 'other', 'denied.txt'), 'base\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

maybeTest('Claude SDK routes native tool permissions through the Runner handler', { timeout: 120_000 }, async () => {
  const cwd = tempWorkspace();
  const approvals = [];
  const backend = new ClaudeBackend();
  const outcome = await runAgent({
    backend,
    spec: {
      role: 'worker', label: 'integration worker', cwd,
      prompt: [
        "Edit src/allowed.txt and append 'changed'.",
        "Attempt to edit other/denied.txt and continue if permission is denied.",
        'Return JSON {"done": true}.'
      ].join('\n'),
      schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
      access: 'workspace-write',
      requestApproval: async (request) => {
        approvals.push(request);
        return JSON.stringify(request.input).includes('other/denied.txt') ? 'deny' : 'once';
      },
      timeoutMs: 100_000,
      staleAfterMs: 60_000
    },
    logPath: join(cwd, 'claude-spike.log'),
    outputPath: join(cwd, 'claude-spike.json')
  });
  assert.equal(outcome.ok, true, outcome.error);
  assert.ok(approvals.some((request) => request.kind === 'file-change'));
  assert.match(readFileSync(join(cwd, 'src', 'allowed.txt'), 'utf8'), /changed/);
  assert.equal(readFileSync(join(cwd, 'other', 'denied.txt'), 'utf8'), 'base\n');
});
