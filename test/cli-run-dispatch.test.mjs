import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';

const control = vi.hoisted(() => ({
  runOptions: [],
  runOutcome: null,
  cleaned: [],
  logs: []
}));

vi.mock('../src/core/run-execute.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    executeRunCommand: async (options) => {
      control.runOptions.push(options);
      if (control.runOutcome) return control.runOutcome;
      return {
        runId: 'r9', exitCode: 0, kind: 'done', runStatus: 'done', contractRevision: 1,
        integrationBranch: null, integrationCommit: null, tasks: [], pending: [], blockers: [],
        pendingPath: '/tmp/pending.json', handoffPath: null
      };
    }
  };
});

vi.mock('../src/core/run-clean.ts', () => ({
  cleanRunArtifacts: async (_db, runId) => {
    control.cleaned.push(runId);
    return { removedWorktrees: [`/wt/${runId}`], removedBranches: [`agent-team/${runId}/integration`] };
  }
}));

vi.mock('../src/core/agent-log.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readAgentLog: async (_db, _runsDir, runId, agentId, lines) => {
      control.logs.push({ runId, agentId, lines });
      return { runId, agentId, content: 'log line', lineCount: 1, byteCount: 8, truncated: false };
    }
  };
});

const recordedInstances = vi.hoisted(() => ({ list: [], emptyNext: false }));

vi.mock('../src/core/db.ts', () => ({
  StateDatabase: class {
    constructor(path) {
      this.path = path;
      this.closed = false;
      this.empty = recordedInstances.emptyNext;
      recordedInstances.list.push(this);
    }

    close() { this.closed = true; }

    listRuns() {
      if (this.empty) return [];
      return [{ id: 'latest', status: 'running', baseRef: 'HEAD', baseSha: 'abcdef123456', adapter: 'external', integrationBranch: null, integrationWorktree: null, integrationCommit: null, error: null }];
    }

    getRun(runId) {
      if (runId === 'missing') throw new Error(`Run not found: ${runId}`);
      return { id: runId, status: 'done', baseRef: 'HEAD', baseSha: 'abcdef123456', adapter: 'external', integrationBranch: 'agent-team/x/integration', integrationWorktree: null, integrationCommit: 'abc', error: null };
    }

    listTasks() {
      return [{ taskId: 'T001', status: 'approved', title: 'Task', attempts: 1, commitSha: 'abc123', lastError: null }];
    }
  }
}));

const { runCli } = await import('../src/cli.ts');

async function capture(args) {
  const output = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value = '') => output.push(String(value)));
  const previousExitCode = process.exitCode;
  try {
    await runCli(args);
    return { output, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
    log.mockRestore();
  }
}

test('run dispatches parsed options and reports summaries with the exit code', async () => {
  control.runOptions = [];
  control.runOutcome = {
    runId: 'r1', exitCode: 10, kind: 'needs_approval', runStatus: 'needs_attention', contractRevision: 2,
    integrationBranch: 'agent-team/r1/integration', integrationCommit: 'abc', tasks: [{ taskId: 'T001', status: 'blocked' }],
    pending: [{ id: 'p1' }], blockers: [{ taskId: 'T001', title: 't', attempts: 1, reason: 'r' }],
    pendingPath: '/tmp/p.json', handoffPath: '/tmp/handoff.json'
  };
  const { output, exitCode } = await capture([
    'run', '--contract', 'c.json', '--run-id', 'r1', '--grant', 'g.json',
    '--debounce-ms', '25', '--max-parallel', '2', '--exit-mode', 'quiescence', '--home', '/tmp/run-home'
  ]);
  assert.equal(exitCode, 10);
  expect(control.runOptions.at(-1)).toEqual({
    contractPath: 'c.json', runId: 'r1', grantPath: 'g.json',
    debounceMs: 25, maxParallel: 2, exitMode: 'quiescence',
    home: expect.objectContaining({ root: expect.stringContaining('run-home') })
  });
  assert.match(output.join('\n'), /Run r1: needs_approval \(exit 10\)/);
  assert.match(output.join('\n'), /Contract blockers: T001/);
  expect(JSON.parse(output.at(-1))).toMatchObject({ runId: 'r1', kind: 'needs_approval', exit: 10 });
});

test('run reports a completed run and accepts positional contract files', async () => {
  control.runOptions = [];
  control.runOutcome = null;
  const { output, exitCode } = await capture(['run', 'positional-contract.json']);
  assert.equal(exitCode, 0);
  assert.equal(control.runOptions.at(-1).contractPath, 'positional-contract.json');
  assert.match(output.join('\n'), /Run r9: done \(exit 0\)/);
});

test('run rejects unknown options and malformed values', async () => {
  control.runOptions = [];
  await assert.rejects(runCli(['run', '--nope']), /Unknown run option/);
  await assert.rejects(runCli(['run', '--debounce-ms']), /requires a value/);
  await assert.rejects(runCli(['run', '--exit-mode', 'nope', '--contract', 'c.json']), /must be "eager" or "quiescence"/);
  await assert.rejects(runCli(['run', '--max-parallel', '0', '--contract', 'c.json']), /positive integer/);
  await assert.rejects(runCli(['run', '--debounce-ms', '-1', '--contract', 'c.json']), /non-negative integer/);
  await assert.rejects(runCli(['run']), /requires --contract/);
  assert.equal(control.runOptions.length, 0);
});

test('status renders the latest or an explicit run', async () => {
  const latest = await capture(['status']);
  assert.match(latest.output.join('\n'), /RUN latest/);
  const explicit = await capture(['status', 'r2', '--home', '/tmp/status-home']);
  assert.match(explicit.output.join('\n'), /RUN r2/);
  await assert.rejects(runCli(['status', 'missing']), /Run not found/);
  await assert.rejects(runCli(['status', 'latest', 'extra']), /Unknown status argument/);
  recordedInstances.emptyNext = true;
  await assert.rejects(runCli(['status']), /No runs found/);
  recordedInstances.emptyNext = false;
});

test('log tails a recorded agent log with bounds validation', async () => {
  control.logs = [];
  const { output } = await capture(['log', 'r1', 'w1', '--lines', '5', '--home', '/tmp/log-home']);
  assert.deepEqual(control.logs.at(-1), { runId: 'r1', agentId: 'w1', lines: 5 });
  assert.deepEqual(output, ['log line']);
  const defaulted = await capture(['log', 'r1', 'w1', '--home', '/tmp/log-home']);
  assert.deepEqual(control.logs.at(-1), { runId: 'r1', agentId: 'w1', lines: 100 });
  assert.deepEqual(defaulted.output, ['log line']);
  await assert.rejects(runCli(['log', 'r1']), /Usage:/);
  await assert.rejects(runCli(['log', 'r1', 'w1', '--lines', '0']), /positive integer/);
  await assert.rejects(runCli(['log', 'r1', 'w1', '--lines']), /requires a value/);
});

test('clean removes run artifacts through the core cleaner', async () => {
  control.cleaned = [];
  const { output } = await capture(['clean', 'r1', '--home', '/tmp/clean-home']);
  assert.deepEqual(control.cleaned, ['r1']);
  assert.match(output.join('\n'), /Removed 1 worktree\(s\) and 1 branch\(es\) for run r1\./);
  await assert.rejects(runCli(['clean']), /Usage:/);
  await assert.rejects(runCli(['clean', 'r1', 'extra']), /Unknown clean argument/);
});

test('help prints the CLI surface including run', async () => {
  const { output } = await capture(['help']);
  assert.match(output.join('\n'), /run --contract PATH/);
  assert.match(output.join('\n'), /clean RUN_ID/);
  assert.match(output.join('\n'), /exit codes/);
});
