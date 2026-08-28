import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

vi.mock('../src/core/config.ts', () => ({
  loadConfig(repoRoot) {
    return {
      repoRoot,
      stateDir: `${repoRoot}/state`,
      agents: {
        'with-model': { backend: 'claude', model: 'alpha' },
        'without-model': { backend: 'opencode' }
      },
      roles: {}
    };
  },
  applyOverrides: (config) => config,
  initConfig: (repoRoot) => `${repoRoot}/config.yml`
}));

vi.mock('../src/core/db.ts', () => ({
  StateDatabase: class {
    close() {}
    getRun() { return { id: 'run', rolesJson: null, manifestJson: null }; }
    listRuns() { return []; }
    listTasks() { return []; }
    updateRun() {}
  }
}));

vi.mock('../src/core/files.ts', () => ({ ensureGitignore() {}, syncSkills: () => ['skill'] }));
vi.mock('../src/core/planner.ts', () => ({ planRun: async () => 'run' }));
vi.mock('../src/core/orchestrator.ts', () => ({ runOrchestrator: async () => {} }));
vi.mock('../src/core/status.ts', () => ({ formatRunStatus: () => 'status' }));
vi.mock('../src/core/git.ts', () => ({ ensureGitRepo: async () => {}, execFile: async () => ({}) }));
vi.mock('../src/agent/codex/generated.ts', () => ({ generatedProtocolVersion: () => 'old-codex' }));
vi.mock('../src/core/agent-config.ts', () => ({
  backendCommand: () => '',
  validateAgents: () => ({ ok: true, errors: ['syntax error'], warnings: ['syntax warning'] })
}));
vi.mock('../src/core/preflight.ts', () => ({
  bindingsForRun: () => [],
  checkAgentAvailability: async () => ({ ok: true, errors: ['availability error'], warnings: ['availability warning'] }),
  probeAll: async () => [
    { backend: 'claude', model: 'alpha', ok: true },
    { backend: 'codex', ok: false, error: 'probe failed' },
    { backend: 'opencode', ok: false }
  ]
}));
vi.mock('../src/agent/approval.ts', () => ({
  TerminalApprovalBroker: class { request() {} requestUserInput() {} close() {} }
}));
vi.mock('../src/agent/registry.ts', () => {
  const backends = {
    claude: {
      discover: async () => ({ installed: true, authed: false }),
      listModels: async () => Array.from({ length: 7 }, (_, index) => ({ id: `model-${index}` }))
    },
    codex: {
      discover: async () => ({ installed: true, version: 'new-codex' }),
      listModels: async () => { throw 'string enumeration failure'; }
    },
    opencode: {
      discover: async () => ({ installed: false }),
      listModels: async () => []
    }
  };
  return {
    buildBackends: () => backends,
    disposeBackends() {},
    parseSnapshot: () => undefined,
    snapshotAgents: () => ({ roles: {
      lead: { agent: 'with-model', backend: 'claude', model: 'alpha', source: 'mock' },
      worker: { agent: 'without-model', backend: 'opencode', source: 'mock' }
    } })
  };
});

const { runCli } = await import('../src/cli.ts');

function terminalState(stdin, stdout) {
  const previousStdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const previousStdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdin });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdout });
  return () => {
    if (previousStdin) Object.defineProperty(process.stdin, 'isTTY', previousStdin);
    else delete process.stdin.isTTY;
    if (previousStdout) Object.defineProperty(process.stdout, 'isTTY', previousStdout);
    else delete process.stdout.isTTY;
  };
}

test('runCli renders all doctor diagnostic outcomes in process', async () => {
  const output = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value = '') => output.push(String(value)));
  try {
    await runCli(['doctor', '--probe', '--repo', '/tmp/cli-coverage']);
  } finally {
    log.mockRestore();
  }
  const rendered = output.join('\n');
  assert.match(rendered, /claude: available \(not authenticated\)/);
  assert.match(rendered, /codex: new-codex/);
  assert.match(rendered, /opencode: unavailable/);
  assert.match(rendered, /generated for "old-codex"/);
  assert.match(rendered, /enumeration failed \(string enumeration failure\)/);
  assert.match(rendered, /availability warning/);
  assert.match(rendered, /codex: FAILED — probe failed/);
});

test('runCli covers plan, launch, and role override flows in process', async () => {
  const restoreTerminal = terminalState(true, true);
  const output = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value = '') => output.push(String(value)));
  try {
    await runCli(['plan', 'goal.md', '--repo', '/tmp/cli-coverage']);
    await runCli(['launch', 'goal.md', '--run-id', 'launch-run', '--repo', '/tmp/cli-coverage']);
    await runCli(['run', 'run', '-c', 'roles.worker=with-model', '--repo', '/tmp/cli-coverage']);
    await runCli(['run', 'run', '-c', 'roles=ignored', '--repo', '/tmp/cli-coverage']);
  } finally {
    log.mockRestore();
    restoreTerminal();
  }
  assert.match(output.join('\n'), /Planned run: run/);
});

test('runCli rejects malformed config overrides and partially interactive terminals', async () => {
  await assert.rejects(runCli(['list', '-c', '=value', '--repo', '/tmp/cli-coverage']), /Invalid -c override/);
  const restoreTerminal = terminalState(true, false);
  try {
    await assert.rejects(
      runCli(['plan', 'goal.md', '--repo', '/tmp/cli-coverage']),
      /interactive terminal/
    );
  } finally {
    restoreTerminal();
  }
});
