// Runner engine: the single writer that schedules tasks, consumes role
// results, enforces gates and maintains the run aggregate. One tick makes
// exactly one bounded pass; runUntilTerminal loops ticks until the run is
// terminal or the abort signal fires.

import type { SqliteDb } from '../store/db.ts';
import { inTransaction } from '../store/db.ts';
import { getRun, updateRunStatus, getContractRevisionAt, clearRevisionPending } from '../store/runs.ts';
import { getTask, listTasks, updateTask } from '../store/tasks.ts';
import { listActiveExecutions, listExecutions, updateExecution } from '../store/executions.ts';
import type { ExecutionRecord } from '../core/types.ts';
import { addEvent } from '../store/events.ts';
import { insertResource, markResourceState, listActiveResources } from '../store/resources.ts';
import { heartbeat, acquireLease, releaseLease, leaseHolder } from '../store/lease.ts';
import { nowIso } from '../store/ids.ts';
import { readResultFile } from '../results/files.ts';
import { validateRoleResult } from '../results/validate.ts';
import type { WorkerResult, ReviewerResult, IntegrationResult } from '../results/types.ts';
import { stageAll, commit, cherryPick, currentHead, revParse, squashSince } from '../core/git.ts';
import { AteamError, type ExitCode } from '../core/errors.ts';
import type { RunRecord, RunStatus, TaskRecord } from '../core/types.ts';
import type { HerdrAgentState } from '../core/types.ts';
import { resolveAgentEntry } from '../config.ts';
import type { RunnerEnv, StartExecutionInput } from './executions.ts';
import { startExecution, resolveReviewerEntry, closePaneSafe } from './executions.ts';
import { verifyTaskWork } from './phases/verify.ts';
import { cleanupTaskResources } from './cleanup.ts';
import { topologicalTasks } from '../core/contract.ts';

const TERMINAL_RUN: ReadonlySet<string> = new Set(['done', 'cancelled', 'abandoned', 'failed']);

export type ReconcileDecisionKind =
  | 'result_recovered'
  | 'pane_lost_new_attempt'
  | 'pane_lost_no_attempt'
  | 'cleanup_resumed'
  | 'resource_lost'
  | 'resource_orphaned'
  | 'revision_consumed';

export interface ReconcileDecision {
  kind: ReconcileDecisionKind;
  taskId?: string;
  executionId?: string;
  detail?: string;
}

export interface RunnerOptions {
  tickMs?: number;
  selfPaneId?: string;
  selfAgentName?: string;
}

export class RunnerEngine {
  readonly env: RunnerEnv;
  private readonly opts: RunnerOptions;
  private lastReportState: string | null = null;
  private integrationPath: string | null = null;
  private integrationRootPaneId: string | null = null;
  private integrationBaseSha: string | null = null;
  /** Task currently blocked on an unresolved cherry-pick conflict. */
  private conflictTaskId: string | null = null;
  /** Integrator gave up: needs human/reconcile intervention. */
  private integrationStalled = false;
  /** Final verification passed; remaining work is resource reclamation. */
  private finalVerified = false;

  constructor(env: RunnerEnv, opts: RunnerOptions = {}) {
    this.env = env;
    this.opts = opts;
  }

  // ------------------------------------------------------------------ tick

  /** One bounded scheduling/progress pass. */
  async tickOnce(): Promise<void> {
    const { db, runId } = this.env;
    heartbeat(db, runId);

    const run = getRun(db, runId);
    if (!run) throw new AteamError(`run not found: ${runId}`);
    if (TERMINAL_RUN.has(run.status)) return;

    if (run.revisionPending) await this.consumeContractRevision();

    const tasks = listTasks(db, runId);
    const executions = listActiveExecutions(db, runId);

    for (const exec of executions) {
      await this.progressExecution(exec, tasks);
    }

    await this.maybeIntegrate();
    await this.scheduleReady();
    await this.updateAggregateStatus();
    await this.selfReport();
  }

  /** Loop until terminal; returns the mechanical exit code. */
  async runUntilTerminal(signal?: AbortSignal): Promise<ExitCode> {
    if (!acquireLease(this.env.db, this.env.runId)) {
      throw new AteamError(`run ${this.env.runId} has a live runner lease; attach instead`, {
        exitCode: 1,
        remediation: 'use `agent-team status` to find the active runner',
      });
    }
    const tickMs = this.opts.tickMs ?? 2000;
    try {
      while (!signal?.aborted) {
        await this.tickOnce();
        const run = getRun(this.env.db, this.env.runId);
        if (!run || TERMINAL_RUN.has(run.status)) break;
        await Bun.sleep(tickMs);
      }
      if (signal?.aborted) {
        addEvent(this.env.db, this.env.runId, 'RUN_INTERRUPTED', { payload: { holder: leaseHolder() } });
        return 130;
      }
      const run = getRun(this.env.db, this.env.runId);
      if (!run) return 1;
      return this.exitCodeFor(run);
    } finally {
      await this.shutdown();
    }
  }

  async shutdown(): Promise<void> {
    releaseLease(this.env.db, this.env.runId);
    await this.selfReport(true);
  }

  exitCodeFor(run: RunRecord): ExitCode {
    const contractBlocked = this.hasContractBlockedTask();
    switch (run.status) {
      case 'done':
        return 0;
      case 'failed':
        return 1;
      default:
        return contractBlocked ? 11 : 10;
    }
  }

  private hasContractBlockedTask(): boolean {
    return listTasks(this.env.db, this.env.runId).some((t) => t.status === 'blocked_on_contract');
  }

  // ------------------------------------------------------------- revision

  /** Consume revision_pending: refresh specs; unblock contract-blocked tasks. */
  async consumeContractRevision(): Promise<void> {
    const { db, runId } = this.env;
    const run = getRun(db, runId);
    if (!run) return;
    const contract = getContractRevisionAt(db, runId, run.contractRevision);
    clearRevisionPending(db, runId);
    if (!contract) return;

    const byId = new Map(contract.tasks.map((t) => [t.id, t]));
    for (const task of listTasks(db, runId)) {
      const fresh = byId.get(task.taskId);
      if (!fresh) continue;
      const specChanged =
        JSON.stringify(task.spec) !== JSON.stringify(fresh) &&
        task.status !== 'integrated' &&
        task.status !== 'reclaimed';
      const unblock = task.status === 'blocked_on_contract';
      if (!specChanged && !unblock) continue;
      inTransaction(db, () => {
        if (specChanged) {
          db.run('UPDATE tasks SET spec_json = ? WHERE run_id = ? AND task_id = ?', [
            JSON.stringify(fresh), runId, task.taskId,
          ]);
        }
        if (unblock) {
          updateTask(db, runId, task.taskId, { status: 'pending', contractBlock: null });
          // the retained execution observed the old spec; a fresh attempt must be used
          for (const exec of listActiveExecutions(db, runId)) {
            if (exec.taskId === task.taskId) {
              updateExecution(db, exec.id, { status: 'abandoned', paneState: 'retained' });
            }
          }
        }
        addEvent(db, runId, 'CONTRACT_REVISED', {
          taskId: task.taskId,
          payload: { revision: run.contractRevision, specChanged, unblocked: unblock },
        });
      });
    }
  }

  // ------------------------------------------------------------ executions

  private async progressExecution(exec: ExecutionRecord, tasks: TaskRecord[]): Promise<void> {
    const { db, runId, client } = this.env;
    const task = tasks.find((t) => t.taskId === exec.taskId) ?? getTask(db, runId, exec.taskId);
    if (!task) return;

    // observe live agent state (never a credential)
    const agent = await client.getAgent(exec.agentName);
    if (agent) {
      const patch: Parameters<typeof updateExecution>[2] = { lastAgentState: agent.state };
      if (agent.nativeSessionRef && agent.nativeSessionRef !== exec.nativeSessionRef) {
        patch.nativeSessionRef = agent.nativeSessionRef;
      }
      if (agent.paneId && agent.paneId !== exec.paneId) patch.paneId = agent.paneId;
      updateExecution(db, exec.id, patch);
      exec = { ...exec, ...patch, resultDigest: exec.resultDigest } as ExecutionRecord;

      if (agent.state === 'blocked' && exec.status !== 'blocked') {
        updateExecution(db, exec.id, { status: 'blocked' });
        addEvent(db, runId, 'RECONCILE_DECISION', {
          executionId: exec.id,
          payload: { reason: 'native_blocked_ui', agentState: agent.state },
        });
        return;
      }
      if (agent.state !== 'blocked' && exec.status === 'blocked') {
        updateExecution(db, exec.id, { status: 'running' });
        exec = { ...exec, status: 'running' };
      }
    } else if (exec.paneState === 'open') {
      // pane vanished (server restart / crash) — left for reconcile (M5)
      updateExecution(db, exec.id, { paneState: 'gone' });
      return;
    }

    if (exec.status === 'blocked') return;

    // result gate: file presence + schema + digest chain
    const read = exec.resultPath ? await readResultFile(exec.resultPath) : null;
    if (!read) return;
    if (exec.resultDigest === read.digest) return; // already consumed this exact file

    let result: WorkerResult | ReviewerResult | IntegrationResult;
    try {
      result = validateRoleResult(exec.role, read.value);
    } catch (err) {
      // invalid schema: keep the pane, surface for attention; file stays for inspection
      updateExecution(db, exec.id, { status: 'result_pending' });
      addEvent(db, runId, 'RECONCILE_DECISION', {
        executionId: exec.id,
        payload: { reason: 'result_schema_rejected', error: String(err) },
      });
      return;
    }
    updateExecution(db, exec.id, { resultDigest: read.digest, result, resultReceivedAt: nowIso() });
    addEvent(db, runId, 'RESULT_ACCEPTED', {
      taskId: task.taskId,
      executionId: exec.id,
      payload: { role: exec.role, digest: read.digest, status: (result as { status: string }).status },
    });
    try {
      if (exec.role === 'worker') {
        await this.applyWorkerResult({ ...exec, resultDigest: read.digest }, task, result as WorkerResult);
      } else if (exec.role === 'reviewer') {
        await this.applyReviewerResult({ ...exec, resultDigest: read.digest }, task, result as ReviewerResult);
      } else {
        await this.applyIntegratorResult({ ...exec, resultDigest: read.digest }, task, result as IntegrationResult);
      }
    } catch (err) {
      // transition failures are real faults (missing panes, git errors) — surface, never swallow
      addEvent(db, runId, 'RECONCILE_DECISION', {
        executionId: exec.id,
        payload: { reason: 'apply_failed', error: String(err) },
      });
      updateRunStatus(db, runId, 'needs_attention', `apply failed: ${String(err)}`);
    }
  }

  private async applyWorkerResult(exec: ExecutionRecord, task: TaskRecord, result: WorkerResult): Promise<void> {
    const { db, runId } = this.env;
    switch (result.status) {
      case 'completed':
        await this.verifyAndHandToReview(exec, task);
        return;
      case 'blocked':
        // user keeps working in the retained pane; a rewritten result file re-enters the gate
        updateTask(db, runId, task.taskId, { status: 'blocked', lastError: result.blockedReason ?? null });
        updateExecution(db, exec.id, { paneState: 'retained' });
        return;
      case 'blocked_on_contract':
        updateTask(db, runId, task.taskId, { status: 'blocked_on_contract', contractBlock: result.contractBlock ?? null });
        updateExecution(db, exec.id, { paneState: 'retained' });
        return;
      case 'failed':
        await this.retryWorker(task, { lastWorkerSummary: result.summary });
        return;
    }
  }

  private async verifyAndHandToReview(exec: ExecutionRecord, task: TaskRecord): Promise<void> {
    const { db, runId, client, config, home } = this.env;
    updateTask(db, runId, task.taskId, { status: 'verifying' });
    const current = getTask(db, runId, task.taskId)!;
    const outcome = await verifyTaskWork({
      worktreePath: current.worktreePath!,
      task: current,
      allowlist: config.verificationAllowlist,
      baseSha: current.startSha ?? 'HEAD',
      logDir: `${home.runsDir}/${runId}/logs`,
    });
    addEvent(db, runId, outcome.ok ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED', {
      taskId: task.taskId,
      payload: {
        violations: outcome.violations,
        diffFiles: outcome.diffFiles,
        commands: outcome.commands.map((c) => ({ command: c.command, ok: c.ok })),
        logPath: outcome.logPath,
      },
    });

    if (!outcome.ok) {
      await this.retryWorker(current, {});
      return;
    }

    await stageAll(current.worktreePath!);
    const sha = await commit(current.worktreePath!, `ateam(${runId}): task ${task.taskId} attempt ${exec.attemptNo}`);
    updateTask(db, runId, task.taskId, { status: 'reviewing', commitSha: sha });
    updateExecution(db, exec.id, { status: 'completed', paneState: 'closed_success' });
    await closePaneSafe(client, exec.paneId);

    await this.startReviewer(current);
  }

  private async startReviewer(task: TaskRecord): Promise<void> {
    const { db, runId } = this.env;
    const workerEntry = resolveAgentEntry(this.env.config, task.spec.agent, 'worker');
    const reviewerEntry = resolveReviewerEntry(this.env.config, workerEntry.kind);
    const cycle = task.reviewCycles + 1;
    updateTask(db, runId, task.taskId, { reviewCycles: cycle });
    await startExecution(this.env, {
      role: 'reviewer',
      task,
      attemptNo: task.attempts,
      cycleNo: cycle,
      entry: reviewerEntry,
    });
  }

  private async retryWorker(task: TaskRecord, retry: { lastWorkerSummary?: string; lastReview?: unknown }): Promise<void> {
    const { db, runId, config } = this.env;
    const current = getTask(db, runId, task.taskId)!;
    if (current.attempts >= config.defaults.maxWorkerAttempts) {
      updateTask(db, runId, task.taskId, { status: 'failed', lastError: 'worker attempts exhausted' });
      return;
    }
    const attemptNo = current.attempts + 1;
    updateTask(db, runId, task.taskId, { attempts: attemptNo, status: 'running' });
    const entry = resolveAgentEntry(config, current.spec.agent, 'worker');
    await startExecution(this.env, {
      role: 'worker',
      task: current,
      attemptNo,
      cycleNo: 0,
      entry,
      retry,
    });
  }

  private async applyReviewerResult(exec: ExecutionRecord, task: TaskRecord, result: ReviewerResult): Promise<void> {
    const { db, runId, client, config } = this.env;
    updateTask(db, runId, task.taskId, { review: result });
    if (result.status === 'approved') {
      updateTask(db, runId, task.taskId, { status: 'approved' });
      addEvent(db, runId, 'TASK_APPROVED', { taskId: task.taskId, payload: { cycle: exec.cycleNo } });
      updateExecution(db, exec.id, { status: 'completed', paneState: 'closed_success' });
      await closePaneSafe(client, exec.paneId);
      return;
    }
    if (exec.cycleNo >= config.defaults.maxReviewCycles) {
      updateTask(db, runId, task.taskId, { status: 'changes_requested', lastError: 'review cycles exhausted' });
      updateExecution(db, exec.id, { status: 'completed', paneState: 'retained' });
      return;
    }
    updateExecution(db, exec.id, { status: 'completed', paneState: 'closed_success' });
    await closePaneSafe(client, exec.paneId);
    await this.retryWorker(task, { lastReview: result });
  }

  private async applyIntegratorResult(exec: ExecutionRecord, task: TaskRecord, result: IntegrationResult): Promise<void> {
    const { db, runId, client } = this.env;
    const worktreePath = this.integrationPath;
    if (!worktreePath) throw new AteamError('integration worktree missing for integrator result');
    if (result.status === 'completed') {
      await stageAll(worktreePath);
      const sha = await commit(worktreePath, `ateam(${runId}): integrate task ${task.taskId} (conflicts resolved)`);
      updateTask(db, runId, task.taskId, { status: 'integrated', integrationCommit: sha });
      this.conflictTaskId = null;
      updateExecution(db, exec.id, { status: 'completed', paneState: 'closed_success' });
      await closePaneSafe(client, exec.paneId);
      return;
    }
    this.integrationStalled = true;
    updateTask(db, runId, task.taskId, { lastError: result.blockedReason ?? 'integration failed' });
    updateExecution(db, exec.id, { status: 'completed', paneState: 'retained' });
  }

  // ------------------------------------------------------------ scheduling

  private async scheduleReady(): Promise<void> {
    const { db, runId, config } = this.env;
    const tasks = listTasks(db, runId);
    const active = listActiveExecutions(db, runId);
    let slots = config.defaults.maxParallel - active.length;
    if (slots <= 0) return;

    const statusById = new Map(tasks.map((t) => [t.taskId, t.status]));
    const depsIntegrated = (task: TaskRecord): boolean =>
      (task.spec.dependsOn ?? []).every((dep) => ['integrated', 'reclaimed'].includes(statusById.get(dep) ?? ''));

    for (const task of tasks) {
      if (slots <= 0) return;
      if (task.status !== 'pending') continue;
      if (!depsIntegrated(task)) continue;
      if (task.attempts >= config.defaults.maxWorkerAttempts) continue;
      const entry = resolveAgentEntry(config, task.spec.agent, 'worker');
      const attemptNo = task.attempts + 1;
      updateTask(db, runId, task.taskId, { attempts: attemptNo, status: 'running' });
      await startExecution(this.env, { role: 'worker', task, attemptNo, cycleNo: 0, entry });
      slots -= 1;
    }
  }

  // ------------------------------------------------------------ integrating

  private async maybeIntegrate(): Promise<void> {
    const { db, runId } = this.env;
    const tasks = listTasks(db, runId);
    if (tasks.length === 0) return;
    if (this.integrationStalled) return;
    if (this.finalVerified) {
      await this.runCleanupPhase();
      return;
    }
    const active = listActiveExecutions(db, runId);
    if (active.length > 0) return; // finish execution work first

    const approved = tasks.filter((t) => t.status === 'approved');
    const integrated = tasks.filter((t) => t.status === 'integrated');
    const settled = tasks.every((t) => ['integrated', 'reclaimed', 'failed'].includes(t.status));

    if (approved.length === 0) {
      const anyFailed = tasks.some((t) => t.status === 'failed');
      if (integrated.length > 0 && settled && !anyFailed && this.integrationPath) {
        await this.finalVerification(tasks);
      }
      return;
    }
    await this.ensureIntegrationWorktree(tasks);
    for (const taskId of topologicalTasks(this.env.contract)) {
      const task = tasks.find((t) => t.taskId === taskId);
      if (!task || task.status !== 'approved') continue;
      if (this.conflictTaskId && this.conflictTaskId !== task.taskId) continue; // serialize conflicts
      await this.integrateTask(task);
    }
  }

  /** Reclaim integrated tasks step by step; done once everything is reclaimed. */
  private async runCleanupPhase(): Promise<void> {
    const { db, runId, client } = this.env;
    const tasks = listTasks(db, runId);
    for (const task of tasks.filter((t) => t.status === 'integrated')) {
      await cleanupTaskResources(this.env, task);
    }
    // run-level temp resource: the integration worktree itself
    if (this.integrationWorkspaceId && listTasks(db, runId).every((t) => t.status === 'reclaimed')) {
      try {
        await client.removeWorktree({ workspaceId: this.integrationWorkspaceId, force: true });
        markResourceState(db, 'workspace', this.integrationWorkspaceId, 'reclaimed');
        this.integrationWorkspaceId = null;
        this.integrationPath = null;
      } catch {
        /* retried on the next tick / by clean */
      }
    }
    const remaining = listTasks(db, runId);
    if (remaining.every((t) => t.status === 'reclaimed') && !this.integrationWorkspaceId) {
      updateRunStatus(db, runId, 'done');
      addEvent(db, runId, 'RUN_FINISHED', { payload: { status: 'done' } });
    }
  }

  private async ensureIntegrationWorktree(tasks: TaskRecord[]): Promise<void> {
    if (this.integrationPath) return;
    const firstWithWorkspace = tasks.find((t) => t.workspaceId);
    if (!firstWithWorkspace) return;
    const branch = `ateam/${this.env.runId}/integration`;
    const handle = await this.env.client.createWorktreeWorkspace({
      sourceWorkspaceId: firstWithWorkspace.workspaceId!,
      branch,
      label: `${this.env.runId}/integration`,
      focus: false,
    });
    this.integrationPath = handle.worktree.path;
    this.integrationRootPaneId = handle.rootPane.paneId;
    this.integrationBaseSha = await revParse(handle.worktree.path, 'HEAD');
    insertResource(this.env.db, {
      runId: this.env.runId, kind: 'workspace', herdrId: handle.workspace.workspaceId, branch, path: handle.worktree.path,
    });
    this.integrationWorkspaceId = handle.workspace.workspaceId;
  }

  private integrationWorkspaceId: string | null = null;

  private async integrateTask(task: TaskRecord): Promise<void> {
    const { db, runId, config } = this.env;
    const path = this.integrationPath!;

    // one commit per task chain: retry attempts squash before cherry-picking
    const current = getTask(db, runId, task.taskId)!;
    if (current.worktreePath && current.startSha) {
      const squashed = await squashSince(current.worktreePath, current.startSha, `ateam(${runId}): task ${task.taskId}`);
      if (squashed !== current.commitSha) {
        updateTask(db, runId, task.taskId, { commitSha: squashed });
        task = { ...current, commitSha: squashed };
      }
    }

    const res = await cherryPick(path, task.commitSha!);
    if (res.ok) {
      const sha = await currentHead(path);
      updateTask(db, runId, task.taskId, { status: 'integrated', integrationCommit: sha });
      addEvent(db, runId, 'INTEGRATION_COMMITTED', { taskId: task.taskId, payload: { sha, conflicts: false } });
      return;
    }
    // conflict: integrator agent resolves inside the integration worktree
    this.conflictTaskId = task.taskId;
    const integratorEntry = resolveAgentEntry(config, task.spec.agent, 'integrator');
    await startExecution(this.env, {
      role: 'integrator',
      task,
      attemptNo: task.attempts + 1,
      cycleNo: 0,
      entry: integratorEntry,
      targetWorktree: { path, rootPaneId: this.integrationRootPaneId! },
      notes: `Integration conflict while cherry-picking ${task.commitSha}. Conflicted files:\n${res.conflicts.map((f) => `- ${f}`).join('\n')}\nResolve conflicts in place. Do NOT commit — the runner commits after your result is accepted.`,
    });
    addEvent(db, runId, 'RECONCILE_DECISION', {
      taskId: task.taskId,
      payload: { reason: 'integration_conflict', conflicts: res.conflicts },
    });
  }

  private async finalVerification(tasks: TaskRecord[]): Promise<void> {
    const { db, runId, config, home } = this.env;
    const path = this.integrationPath;
    if (!path) return;
    const allCommands = [...new Set(tasks.flatMap((t) => t.spec.verificationCommands ?? []))];
    const probe: TaskRecord = {
      ...tasks[0]!,
      taskId: 'INTEGRATION',
      spec: { id: 'INTEGRATION', title: 'final gate', allowedPaths: ['**'], verificationCommands: allCommands },
      attempts: 0,
    };
    const outcome = await verifyTaskWork({
      worktreePath: path,
      task: probe,
      allowlist: config.verificationAllowlist,
      baseSha: this.integrationBaseSha ?? 'HEAD',
      logDir: `${home.runsDir}/${runId}/logs`,
    });
    addEvent(db, runId, outcome.ok ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED', {
      payload: { phase: 'integration_final', violations: outcome.violations, logPath: outcome.logPath },
    });
    if (outcome.ok) {
      this.finalVerified = true;
    } else {
      updateRunStatus(db, runId, 'needs_attention', 'integration final verification failed');
    }
  }

  // ------------------------------------------------------------- reconcile

  /** One reconciliation pass: snapshot ∩ ledger, recover, resume cleanups. */
  async reconcileOnce(opts: { dryRun?: boolean } = {}): Promise<ReconcileDecision[]> {
    const { db, runId, client } = this.env;
    const decisions: ReconcileDecision[] = [];
    const apply = async (fn: () => Promise<void> | void): Promise<void> => {
      if (!opts.dryRun) await fn();
    };

    const run = getRun(db, runId);
    if (!run || TERMINAL_RUN.has(run.status)) return decisions;

    if (run.revisionPending) {
      decisions.push({ kind: 'revision_consumed', detail: `revision ${run.contractRevision}` });
      await apply(() => this.consumeContractRevision());
    }

    const snap = await client.snapshot().catch(() => null);
    const alivePanes = new Set((snap?.panes ?? []).map((p) => p.paneId));
    const tasks = listTasks(db, runId);
    // only resources that existed before this pass may be swept as lost/orphaned
    const preExistingResources = new Set(listActiveResources(db, runId).map((r) => `${r.kind}:${r.herdrId}`));

    for (const exec of listActiveExecutions(db, runId)) {
      const paneAlive = exec.paneId ? alivePanes.has(exec.paneId) : false;
      if (paneAlive) {
        decisions.push({ kind: 'result_recovered', taskId: exec.taskId, executionId: exec.id, detail: 'pane alive; re-entered result gate' });
        await apply(() => this.progressExecution(exec, listTasks(db, runId)));
        continue;
      }
      const task = tasks.find((t) => t.taskId === exec.taskId);
      decisions.push({
        kind: exec.promptSentAt ? 'pane_lost_new_attempt' : 'pane_lost_no_attempt',
        taskId: exec.taskId,
        executionId: exec.id,
        detail: `pane ${exec.paneId ?? '-'} not in snapshot`,
      });
      if (opts.dryRun || !task) continue;
      updateExecution(db, exec.id, { status: 'abandoned', paneState: 'gone' });
      addEvent(db, runId, 'RECONCILE_DECISION', {
        executionId: exec.id,
        payload: { reason: 'pane_lost', promptSent: !!exec.promptSentAt },
      });
      if (!exec.promptSentAt) continue;
      await this.recoverExecutionOnFreshWorktree(exec, task, decisions);
    }

    for (const task of listTasks(db, runId).filter((t) => t.status === 'integrated')) {
      decisions.push({ kind: 'cleanup_resumed', taskId: task.taskId });
      await apply(async () => {
        await cleanupTaskResources(this.env, task);
      });
    }

    if (snap) {
      const snapIds = new Set<string>([
        ...snap.workspaces.map((w) => w.workspaceId),
        ...snap.panes.map((p) => p.paneId),
      ]);
      for (const res of listActiveResources(db, runId)) {
        if (!preExistingResources.has(`${res.kind}:${res.herdrId}`)) continue;
        if (snapIds.has(res.herdrId)) continue;
        decisions.push({
          kind: res.provenance ? 'resource_lost' : 'resource_orphaned',
          taskId: res.taskId ?? undefined,
          detail: `${res.kind}:${res.herdrId}`,
        });
        await apply(() => markResourceState(db, res.kind, res.herdrId, res.provenance ? 'lost' : 'orphaned'));
      }
    }

    return decisions;
  }

  /** Recreate a usable worktree (reuse → same-branch rebuild → suffixed rebuild) then re-dispatch. */
  private async recoverExecutionOnFreshWorktree(
    exec: ExecutionRecord,
    task: TaskRecord,
    decisions: ReconcileDecision[],
  ): Promise<void> {
    const { db, runId, client } = this.env;
    const source = process.env.HERDR_WORKSPACE_ID ?? task.workspaceId ?? '';
    let handle: Awaited<ReturnType<typeof client.createWorktreeWorkspace>> | null = null;

    if (task.branch) {
      try {
        handle = await client.openWorktree({ sourceWorkspaceId: source, branch: task.branch });
      } catch {
        /* try rebuilds below */
      }
      if (!handle) {
        for (const suffix of ['', '-r2', '-r3']) {
          try {
            handle = await client.createWorktreeWorkspace({
              sourceWorkspaceId: source, branch: `${task.branch}${suffix}`, focus: false,
            });
            break;
          } catch {
            /* next suffix */
          }
        }
      }
    }
    if (!handle) {
      decisions.push({ kind: 'pane_lost_no_attempt', taskId: task.taskId, detail: 'worktree unrecoverable; needs manual attention' });
      updateTask(db, runId, task.taskId, { lastError: 'worktree unrecoverable after pane loss' });
      return;
    }

    insertResource(db, {
      runId, taskId: task.taskId, kind: 'workspace', herdrId: handle.workspace.workspaceId,
      branch: handle.worktree.branch, path: handle.worktree.path,
    });
    insertResource(db, { runId, taskId: task.taskId, kind: 'pane', herdrId: handle.rootPane.paneId });
    updateTask(db, runId, task.taskId, {
      workspaceId: handle.workspace.workspaceId,
      worktreePath: handle.worktree.path,
      branch: handle.worktree.branch,
      startSha: null,
    });

    const current = getTask(db, runId, task.taskId)!;
    if (exec.role === 'worker') {
      await this.retryWorker(current, {});
    } else if (exec.role === 'reviewer') {
      await this.startReviewer(current);
    } else {
      this.integrationStalled = true;
      updateTask(db, runId, task.taskId, { lastError: 'integrator pane lost mid-conflict; resolve manually' });
      decisions.push({ kind: 'pane_lost_no_attempt', taskId: task.taskId, detail: 'integrator mid-conflict; needs manual resolution' });
    }
  }


  // ------------------------------------------------------------- aggregate

  private async updateAggregateStatus(): Promise<void> {
    const { db, runId } = this.env;
    const tasks = listTasks(db, runId);
    if (tasks.length === 0) return;
    const execs = listExecutions(db, runId);
    const blockedExecs = execs.some((e) => e.status === 'blocked' || e.status === 'result_pending');
    const anyContract = tasks.some((t) => t.status === 'blocked_on_contract');
    const anyBlocked = tasks.some((t) => t.status === 'blocked' || t.status === 'changes_requested');
    const anyFailed = tasks.some((t) => t.status === 'failed');
    const allSettled = tasks.every((t) => ['integrated', 'reclaimed', 'failed'].includes(t.status));

    let status: RunStatus;
    if (allSettled && anyFailed) status = 'failed';
    else if (allSettled) status = 'integrating'; // final verification pending
    else if (anyFailed) status = 'failed';
    else if (this.integrationStalled) status = 'needs_attention';
    else if (anyContract || anyBlocked || blockedExecs) status = 'needs_attention';
    else if (tasks.some((t) => t.status === 'integrated')) status = 'integrating';
    else status = 'running';

    const run = getRun(db, runId)!;
    if (run.status !== status && !TERMINAL_RUN.has(run.status)) {
      updateRunStatus(db, runId, status);
      addEvent(db, runId, 'RUN_STATUS_CHANGED', { payload: { from: run.status, to: status } });
    }
  }

  private async selfReport(final = false): Promise<void> {
    const { db, runId, client } = this.env;
    const paneId = this.opts.selfPaneId;
    if (!paneId) return;
    const run = getRun(db, runId);
    if (!run) return;
    const execs = listExecutions(db, runId);
    let state: HerdrAgentState;
    if (final) state = 'idle';
    else if (TERMINAL_RUN.has(run.status)) state = run.status === 'done' ? 'done' : 'blocked';
    else if (run.status === 'needs_attention') state = 'blocked';
    else if (!execs.some((e) => ['running', 'starting'].includes(e.status))) state = 'idle';
    else state = 'working';
    if (state === this.lastReportState) return;
    this.lastReportState = state;
    try {
      await client.reportAgentState({
        paneId,
        agent: this.opts.selfAgentName ?? 'ateam-runner',
        state,
        message: `${runId} ${run.status}`,
      });
    } catch {
      /* self-report is best effort */
    }
  }
}

export type { StartExecutionInput };
