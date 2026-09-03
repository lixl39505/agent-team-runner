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
import { blockersPath, pendingItemPath } from '../src/core/run-exit.ts';

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
  const specs = [];
  let sessionCounter = 0;
  const backend = {
    id: 'claude',
    capabilities: { maxTurns: true, resumeSession: true },
    specs,
    async discover() { return { backend: this.id, installed: true, authed: true }; },
    async listModels() { return []; },
    async probe() { return { ok: true, latencyMs: 1 }; },
    async openSession(spec) {
      sessionCounter += 1;
      const sessionId = `sess-${sessionCounter}`;
      spec.sessionId = sessionId;
      specs.push(spec);
      spec.onEvent?.({ type: 'session', sessionId });
      return {
        sessionId,
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
  return backend;
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
  const replayBackend = scriptBackend(workerHandler({ approvals: 0 }));
  const second = await executeRunCommand({
    contractPath, runId: first.runId, grantPath: decisionsPath, home,
    backends: { claude: replayBackend, codex: replayBackend, opencode: replayBackend }, exitMode: 'quiescence'
  });

  assert.equal(second.exitCode, 0);
  assert.equal(second.kind, 'done');
  // 普通重放（grant 后重跑）不复用旧 session：上下文经厚重试注入，会话保持全新。
  const workerSpecs = replayBackend.specs.filter((spec) => spec.role === 'worker');
  assert.ok(workerSpecs.length >= 1);
  assert.equal(workerSpecs.at(-1).resumeSessionId, undefined);
  assert.equal(workerSpecs.at(-1).taskId, 'T001');
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

  // 中断后的 run 保持可重放：同进程内紧接的重放按本次运行的真实状态分类，不再误判 130。
  const second = await executeRunCommand({
    contractPath, runId: first.runId, home, backends: pool(workerHandler({ approvals: 0 })), exitMode: 'quiescence'
  });
  assert.equal(second.exitCode, 0);
  assert.equal(second.kind, 'done');
});

test('a task interrupted mid-flight resumes its previous worker session on replay', async () => {
  const repoRoot = await repository('agent-team-run-resume-');
  const home = tempHome();
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot)));

  const first = await executeRunCommand({
    contractPath, home, backends: pool(workerHandler({ approvals: 0 })), exitMode: 'quiescence'
  });
  assert.equal(first.exitCode, 0);

  // 把任务置回「中断待恢复」状态：phase interrupted + 保留 worktree + 上次 worker session。
  const db = new StateDatabase(home.stateDb);
  db.updateTask(first.runId, 'T001', {
    status: 'changes_requested', phase: 'interrupted', commitSha: null, finishedAt: null
  });
  db.startAgentExecution({
    runId: first.runId, agentId: 'T001-worker-1', taskId: 'T001', role: 'worker', backend: 'claude',
    logPath: join(home.runsDir, first.runId, 'logs', 'T001-worker-1.log')
  });
  db.updateAgentExecution(first.runId, 'T001-worker-1', { sessionId: 'sess-run1' });
  db.updateRun(first.runId, { status: 'failed', error: null, finishedAt: null, integrationCommit: null });
  db.close();

  const replayBackend = scriptBackend(workerHandler({ approvals: 0 }));
  const second = await executeRunCommand({
    contractPath, runId: first.runId, home,
    backends: { claude: replayBackend, codex: replayBackend, opencode: replayBackend }, exitMode: 'quiescence'
  });
  assert.equal(second.exitCode, 0);
  assert.equal(second.kind, 'done');
  // 中断恢复是唯一允许 resume worker 会话的场景。
  const resumedSpec = replayBackend.specs.filter((spec) => spec.role === 'worker').at(-1);
  assert.equal(resumedSpec.taskId, 'T001');
  assert.equal(resumedSpec.resumeSessionId, 'sess-run1');
});

test('a failure after run creation persists exit artifacts and reports the runId', async () => {
  const repoRoot = await repository('agent-team-run-crash-');
  const home = tempHome();
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot)));

  const first = await executeRunCommand({
    contractPath, home, backends: pool(workerHandler({ approvals: 0, contractBlock: true })), exitMode: 'quiescence'
  });
  assert.equal(first.exitCode, 11);

  // 重放携带冲突契约：runId 已存在后的异常路径也要留下文件化终态。
  const conflicting = contractFor(repoRoot);
  conflicting.project.baseRef = 'refs/heads/other';
  const conflictingPath = join(repoRoot, 'contract-conflict.json');
  writeFileSync(conflictingPath, JSON.stringify(conflicting));

  await assert.rejects(
    executeRunCommand({ contractPath: conflictingPath, runId: first.runId, home, backends: pool(workerHandler({ approvals: 0 })), exitMode: 'quiescence' }),
    (error) => {
      assert.match(error.message, new RegExp(`^Run ${first.runId}: Contract revision cannot change`));
      assert.equal(error.runId, first.runId);
      return true;
    }
  );

  const pending = JSON.parse(readFileSync(pendingItemPath(home.runsDir, first.runId), 'utf8'));
  assert.equal(pending.runId, first.runId);
  assert.deepEqual(pending.pending, []);
  const blockers = JSON.parse(readFileSync(blockersPath(home.runsDir, first.runId), 'utf8'));
  assert.deepEqual(blockers.blockers.map((blocker) => blocker.taskId), ['T001']);
});
