import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from '../src/core/git.ts';
import { resolveAgentTeamHome } from '../src/core/home.ts';
import { ProjectRegistry } from '../src/core/project-registry.ts';
import { StateDatabase } from '../src/core/db.ts';
import { executeRunCommand } from '../src/core/run-execute.ts';
import { blockersPath } from '../src/core/run-exit.ts';

async function repository(prefix) {
  const repoRoot = mkdtempSync(join(tmpdir(), `${prefix}-`));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'feature.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'test']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  return repoRoot;
}

function tempHome() {
  const parent = mkdtempSync(join(tmpdir(), 'agent-team-run-home-'));
  return resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
}

function contractFor(repoRoot, overrides = {}) {
  return {
    version: 1,
    project: { id: 'e2e-project', repoRoot, baseRef: 'HEAD' },
    tasks: [{
      id: 'T001', title: 'Change feature', description: 'Update the feature file.',
      dependsOn: [], allowedPaths: ['src/**'], blockedPaths: [],
      acceptance: ['feature is updated'], verificationCommands: []
    }],
    ...overrides
  };
}

const WORKER_COMPLETED = { status: 'completed', summary: 'did it', testsRun: [], knownRisks: [] };
const APPROVED_REVIEW = { decision: 'approved', summary: 'approved', findings: [], requiredChanges: [] };

function scriptBackend(handler) {
  return {
    id: 'claude',
    capabilities: { maxTurns: true, resumeSession: true },
    async discover() { return { backend: this.id, installed: true, authed: true }; },
    async listModels() { return []; },
    async probe() { return { ok: true, latencyMs: 1 }; },
    async openSession(spec) {
      return {
        async interrupt() {},
        async close() {},
        completion: async () => {
          const response = await handler(spec);
          return response && Object.hasOwn(response, 'ok')
            ? response
            : { ok: true, output: response, timedOut: false, stalled: false };
        }
      };
    }
  };
}

function triple(backend) {
  return { claude: backend, codex: backend, opencode: backend };
}

function workerHandler(log) {
  return async (spec) => {
    if (spec.role === 'worker') {
      writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'changed\n', 'utf8');
      if (log.approvals > 0) {
        log.approvals -= 1;
        const decision = await spec.requestApproval({
          backend: 'claude', role: 'worker', cwd: spec.cwd, taskId: spec.taskId,
          kind: 'command', tool: 'Bash', input: { command: 'pnpm add zod' }, allowSession: false
        });
        if (decision === 'deny') {
          return { status: 'blocked', summary: 'needs pnpm add zod', testsRun: [], knownRisks: [], blockedReason: 'pnpm add zod was denied' };
        }
      }
      if (log.contractBlock) {
        return {
          status: 'blocked_on_contract', summary: 'acceptance conflicts with scope', testsRun: [], knownRisks: [],
          contractBlock: {
            code: 'conflicting_requirement',
            message: 'Acceptance requires files outside allowedPaths.',
            requestedContractChanges: ['Widen T001 allowedPaths to src/**']
          }
        };
      }
      return WORKER_COMPLETED;
    }
    if (spec.role === 'reviewer') return APPROVED_REVIEW;
    return { status: 'completed', summary: 'integration finished', testsRun: [], knownRisks: [] };
  };
}

function pool(handler) {
  const backend = scriptBackend(handler);
  return triple(backend);
}

test('run executes a contract to done with an auto-registered project and handoff', async () => {
  const repoRoot = await repository('agent-team-run-done-');
  const home = tempHome();
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot)));

  const outcome = await executeRunCommand({
    contractPath, home, backends: pool(workerHandler({ approvals: 0 })), exitMode: 'quiescence'
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.kind, 'done');
  assert.equal(outcome.runStatus, 'done');
  assert.equal(outcome.contractRevision, 1);
  assert.ok(outcome.integrationCommit);
  assert.ok(existsSync(outcome.handoffPath));
  const handoff = JSON.parse(readFileSync(outcome.handoffPath, 'utf8'));
  assert.equal(handoff.run.id, outcome.runId);
  assert.equal(handoff.run.status, 'done');
  const registry = new ProjectRegistry(home.stateDb);
  const project = registry.getProject('e2e-project');
  assert.equal(project.repoRoot, repoRoot);
  assert.deepEqual(project.gitIdentity, { root: repoRoot });
  const policy = registry.getProjectPolicy('e2e-project');
  assert.equal(policy.baseRef, 'HEAD');
  assert.deepEqual(JSON.parse(readFileSync(outcome.pendingPath, 'utf8')).pending, []);
});

test('run collects denied approvals, exits 10, and a grant sediments the allowlist on replay', async () => {
  const repoRoot = await repository('agent-team-run-approval-');
  const home = tempHome();
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot)));

  const first = await executeRunCommand({
    contractPath, home, backends: pool(workerHandler({ approvals: 1 })), exitMode: 'quiescence'
  });

  assert.equal(first.exitCode, 10);
  assert.equal(first.kind, 'needs_approval');
  assert.equal(first.runStatus, 'needs_attention');
  assert.equal(first.pending.length, 1);
  assert.equal(first.pending[0].taskId, 'T001');
  assert.deepEqual(first.pending[0].commands, ['pnpm add zod']);
  const pendingOnDisk = JSON.parse(readFileSync(first.pendingPath, 'utf8'));
  assert.equal(pendingOnDisk.runId, first.runId);
  assert.equal(pendingOnDisk.pending.length, 1);

  const decisionsPath = join(repoRoot, 'decisions.json');
  writeFileSync(decisionsPath, JSON.stringify({ p1: 'approve' }));
  const second = await executeRunCommand({
    contractPath, runId: first.runId, grantPath: decisionsPath, home,
    backends: pool(workerHandler({ approvals: 0 })), exitMode: 'quiescence'
  });

  assert.equal(second.exitCode, 0);
  assert.equal(second.kind, 'done');
  const registry = new ProjectRegistry(home.stateDb);
  const policy = registry.getProjectPolicy('e2e-project');
  assert.ok(policy.verificationAllowedCommandPrefixes.includes('pnpm add zod'));
  const db = new StateDatabase(home.stateDb);
  const run = db.getRun(first.runId);
  db.close();
  assert.equal(run.projectPolicyRevisionId, policy.id);
  assert.deepEqual(JSON.parse(readFileSync(second.pendingPath, 'utf8')).pending, []);
});

test('run exits 11 on a contract block and a revised contract reentry applies a revision', async () => {
  const repoRoot = await repository('agent-team-run-block-');
  const home = tempHome();
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot)));

  const first = await executeRunCommand({
    contractPath, home, backends: pool(workerHandler({ approvals: 0, contractBlock: true })), exitMode: 'quiescence'
  });

  assert.equal(first.exitCode, 11);
  assert.equal(first.kind, 'contract_blocked');
  assert.deepEqual(first.blockers.map((blocker) => blocker.taskId), ['T001']);
  assert.match(first.blockers[0].reason, /Acceptance requires/);
  assert.ok(existsSync(blockersPath(home.runsDir, first.runId)));

  const revised = contractFor(repoRoot);
  revised.tasks[0].allowedPaths = ['src/**', 'docs/**'];
  const revisedPath = join(repoRoot, 'contract-v2.json');
  writeFileSync(revisedPath, JSON.stringify(revised));

  const second = await executeRunCommand({
    contractPath: revisedPath, runId: first.runId, home,
    backends: pool(workerHandler({ approvals: 0 })), exitMode: 'quiescence'
  });

  assert.equal(second.exitCode, 0);
  assert.equal(second.kind, 'done');
  assert.equal(second.contractRevision, 2);
  assert.deepEqual(second.tasks.map((task) => task.status), ['approved']);
});

test('eager mode aborts the run after the debounce window and reports pending approvals', async () => {
  const repoRoot = await repository('agent-team-run-eager-');
  const home = tempHome();
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot)));

  const slowHandler = async (spec) => {
    if (spec.role === 'worker') {
      writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'changed\n', 'utf8');
      await spec.requestApproval({
        backend: 'claude', role: 'worker', cwd: spec.cwd, taskId: spec.taskId,
        kind: 'command', tool: 'Bash', input: { command: 'pnpm add zod' }, allowSession: false
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      return { status: 'blocked', summary: 'needs pnpm add zod', testsRun: [], knownRisks: [], blockedReason: 'denied' };
    }
    return spec.role === 'reviewer' ? APPROVED_REVIEW : WORKER_COMPLETED;
  };

  const outcome = await executeRunCommand({
    contractPath, home, backends: pool(slowHandler), exitMode: 'eager', debounceMs: 5
  });

  assert.equal(outcome.exitCode, 10);
  assert.equal(outcome.kind, 'needs_approval');
  assert.equal(outcome.pending.length, 1);
});

test('SIGINT during a run exits 130 and the run stays resumable', async () => {
  const repoRoot = await repository('agent-team-run-sigint-');
  const home = tempHome();
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot)));

  const handler = async (spec) => {
    if (spec.role === 'worker') {
      writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'changed\n', 'utf8');
      process.emit('SIGINT');
      for (let i = 0; i < 200; i += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      return WORKER_COMPLETED;
    }
    return spec.role === 'reviewer' ? APPROVED_REVIEW : WORKER_COMPLETED;
  };

  const previousExitCode = process.exitCode;
  let first;
  try {
    first = await executeRunCommand({
      contractPath, home, backends: pool(handler), exitMode: 'quiescence'
    });
  } finally {
    process.exitCode = previousExitCode;
  }
  assert.equal(first.exitCode, 130);
  assert.equal(first.kind, 'interrupted');

  const second = await executeRunCommand({
    contractPath, runId: first.runId, home, backends: pool(workerHandler({ approvals: 0 })), exitMode: 'quiescence'
  });
  assert.equal(second.exitCode, 0);
  assert.equal(second.kind, 'done');
});
