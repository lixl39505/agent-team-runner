import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/core/defaults.ts';
import { ProjectRegistry } from '../src/core/project-registry.ts';
import { runnerConfigFromProjectPolicy } from '../src/core/project-runtime.ts';

const project = {
  id: 'project-1',
  gitCommonDir: '/repos/example/.git',
  repoRoot: '/repos/example',
  displayName: 'Example',
  gitIdentity: {},
  currentPolicyRevisionId: 'project-1:r1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const home = {
  root: '/state/agent-team',
  stateDb: '/state/agent-team/state.sqlite',
  runsDir: '/state/agent-team/runs',
  worktreesDir: '/state/agent-team/worktrees'
};

function policy(overrides = {}) {
  return {
    id: 'project-1:r1',
    projectId: 'project-1',
    revision: 1,
    baseRef: 'main',
    verificationAllowedCommandPrefixes: ['npm test'],
    baselinePathPolicy: {},
    agentProfileMapping: {
      defaultAgent: 'worker',
      agents: { worker: { backend: 'codex' } }
    },
    backendPolicy: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('converts a complete project policy into an isolated runner config', () => {
  const input = policy({
    agentProfileMapping: {
      defaultAgent: 'worker',
      agents: {
        worker: { backend: 'codex', model: 'gpt-5.6-terra', maxTurns: 8 },
        reviewer: { backend: 'claude', authIsolation: 'isolated' }
      },
      roles: { worker: 'worker', reviewer: 'reviewer' }
    },
    backendPolicy: {
      backends: { codex: { command: 'codex-team', nativeWindowsSandbox: 'allow-degraded' } },
      concurrency: 5,
      staleAfterMs: 100,
      taskTimeoutMs: 200,
      retry: { maxWorkerAttempts: 4, maxReviewCycles: 5 }
    }
  });
  const config = runnerConfigFromProjectPolicy(input, project, home);

  assert.deepEqual(config.workspace, {
    repoRoot: project.repoRoot,
    stateDir: home.root,
    worktreesDir: home.worktreesDir,
    baseRef: 'main',
    branchPrefix: 'agent-team'
  });
  assert.deepEqual(config.verification, { allowedCommandPrefixes: ['npm test'] });
  assert.deepEqual(config.agents.worker, { backend: 'codex', model: 'gpt-5.6-terra', maxTurns: 8 });
  assert.deepEqual(config.roles, { worker: 'worker', reviewer: 'reviewer' });
  assert.equal(config.backends.codex.command, 'codex-team');
  assert.equal(config.backends.codex.nativeWindowsSandbox, 'allow-degraded');
  assert.deepEqual(
    [config.concurrency, config.staleAfterMs, config.taskTimeoutMs, config.retry],
    [5, 100, 200, { maxWorkerAttempts: 4, maxReviewCycles: 5 }]
  );
  assert.throws(() => runnerConfigFromProjectPolicy({ ...input, backendPolicy: { ...input.backendPolicy, status: { pollIntervalMs: 300 } } }, project, home), /status is not allowed/);
  assert.throws(() => runnerConfigFromProjectPolicy({ ...input, backendPolicy: { ...input.backendPolicy, interactionAlert: {} } }, project, home), /interactionAlert is not allowed/);
  // 已移除的策略键（旧字段）必须被拒绝，而不是被静默吞掉。
  assert.throws(() => runnerConfigFromProjectPolicy({ ...input, backendPolicy: { ...input.backendPolicy, integration: { allowedPaths: ['src/**'] } } }, project, home), /integration is not allowed/);

  config.verification.allowedCommandPrefixes.push('npm run lint');
  const next = runnerConfigFromProjectPolicy(input, project, home);
  assert.deepEqual(next.verification.allowedCommandPrefixes, ['npm test']);
});

test('uses DEFAULT_CONFIG for omitted backend policy values', () => {
  const config = runnerConfigFromProjectPolicy(policy(), project, home);
  assert.equal(config.concurrency, DEFAULT_CONFIG.concurrency);
  assert.deepEqual(config.retry, DEFAULT_CONFIG.retry);
  assert.deepEqual(config.backends, DEFAULT_CONFIG.backends);
  assert.deepEqual(config.roles, {});
});

test('accepts every optional policy value and preserves defaults for empty nested policies', () => {
  const config = runnerConfigFromProjectPolicy(policy({
    agentProfileMapping: {
      defaultAgent: 'worker',
      agents: {
        worker: {
          backend: 'claude',
          model: 'sonnet',
          description: 'Worker agent',
          maxTurns: 2,
          authProfile: 'work_profile',
          authIsolation: 'shared',
          baseUrl: 'https://api.example.com/v1'
        }
      }
    },
    backendPolicy: {
      backends: { claude: {} },
      retry: {}
    }
  }), project, home);
  assert.deepEqual(config.agents.worker, {
    backend: 'claude',
    model: 'sonnet',
    description: 'Worker agent',
    maxTurns: 2,
    authProfile: 'work_profile',
    authIsolation: 'shared',
    baseUrl: 'https://api.example.com/v1'
  });
  assert.deepEqual(config.backends.claude, DEFAULT_CONFIG.backends.claude);
});

test('rejects malformed JSON policy sections', () => {
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ agentProfileMapping: [] }), project, home), /agentProfileMapping must be a JSON object/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ agentProfileMapping: { defaultAgent: 'worker', agents: [] } }), project, home), /agents must be a JSON object/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ agentProfileMapping: { defaultAgent: 'worker', agents: { worker: { backend: 'codex' } }, roles: [] } }), project, home), /roles must be a JSON object/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ backendPolicy: [] }), project, home), /backendPolicy must be a JSON object/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ verificationAllowedCommandPrefixes: [1] }), project, home), /array of strings/);
});

test('rejects unknown policy keys and cannot accept a policy workspace', () => {
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ backendPolicy: { workspace: { repoRoot: '/untrusted' } } }), project, home), /backendPolicy.workspace is not allowed/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ backendPolicy: { retry: { extra: 1 } } }), project, home), /backendPolicy.retry.extra is not allowed/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ agentProfileMapping: { defaultAgent: 'worker', agents: { worker: { backend: 'codex' } }, workspace: {} } }), project, home), /agentProfileMapping.workspace is not allowed/);
});

test('rejects invalid agents, backend ids, and non-positive numeric policy values', () => {
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ agentProfileMapping: { defaultAgent: null, agents: { worker: { backend: 'codex' } } } }), project, home), /defaultAgent must be a string/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ agentProfileMapping: { defaultAgent: 'missing', agents: { worker: { backend: 'codex' } } } }), project, home), /defaultAgent: unknown agent/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ agentProfileMapping: { defaultAgent: 'worker', agents: { 'bad.name': { backend: 'codex' } } } }), project, home), /invalid agent name/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ agentProfileMapping: { defaultAgent: 'worker', agents: { worker: { backend: 'other' } } } }), project, home), /unknown backend/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ agentProfileMapping: { defaultAgent: 'worker', agents: { worker: { backend: 'codex', authIsolation: 'per-run' } } } }), project, home), /authIsolation/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ backendPolicy: { backends: { other: {} } } }), project, home), /unknown backend/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ backendPolicy: { backends: { claude: { nativeWindowsSandbox: 'unsafe' } } } }), project, home), /nativeWindowsSandbox/);
  assert.throws(() => runnerConfigFromProjectPolicy(policy({ backendPolicy: { integration: { runAgentAfterCherryPick: false } } }), project, home), /is not allowed/);
  for (const backendPolicy of [
    { concurrency: 0 },
    { staleAfterMs: -1 },
    { taskTimeoutMs: 1.5 },
    { retry: { maxWorkerAttempts: -1 } },
    { retry: { maxReviewCycles: 1.5 } },
    { concurrency: 1.5 }
  ]) {
    assert.throws(() => runnerConfigFromProjectPolicy(policy({ backendPolicy }), project, home), /positive integer/);
  }
});

test('covers ProjectRegistry transaction rollback while keeping this test self-contained', () => {
  const registry = new ProjectRegistry(join(mkdtempSync(join(tmpdir(), 'agent-team-project-runtime-')), 'projects.sqlite'));
  try {
    assert.throws(() => registry.registerProject({
      gitCommonDir: project.gitCommonDir,
      repoRoot: project.repoRoot,
      displayName: project.displayName,
      gitIdentity: {},
      policy: {
        baseRef: null,
        verificationAllowedCommandPrefixes: [],
        baselinePathPolicy: {},
        agentProfileMapping: {},
        backendPolicy: {}
      }
    }), /NOT NULL constraint failed/);
  } finally {
    registry.close();
  }
});
