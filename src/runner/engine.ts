// Runner engine: the single writer that schedules tasks, consumes role
// results, enforces gates and maintains the run aggregate. One tick makes
// exactly one bounded pass; runUntilTerminal loops ticks until the run is
// terminal or the abort signal fires.

import type { SqliteDb } from '../store/db.ts';
import { inTransaction } from '../store/db.ts';
import { getRun, updateRunStatus, updateRunRuntimeState, getContractRevisionAt, clearRevisionPending } from '../store/runs.ts';
import { getTask, insertTask, listTasks, updateTask } from '../store/tasks.ts';
import { latestExecutionFor, listActiveExecutions, listExecutions, updateExecution } from '../store/executions.ts';
import type { ExecutionRecord, PendingDispatch } from '../core/types.ts';
import { addEvent } from '../store/events.ts';
import { insertResource, markResourceState, listActiveResources } from '../store/resources.ts';
import { heartbeat, acquireLease, releaseLease, leaseHolder } from '../store/lease.ts';
import { nowIso } from '../store/ids.ts';
import { insertVerification, hasPassingFinalVerification } from '../store/verifications.ts';
import { readResultFile } from '../results/files.ts';
import { validateRoleResult } from '../results/validate.ts';
import type { WorkerResult, ReviewerResult, IntegrationResult } from '../results/types.ts';
import { stageAll, commit, cherryPick, currentHead, hasStagedChanges, revParse, squashSince } from '../core/git.ts';
import { AteamError, type ExitCode } from '../core/errors.ts';
import type { HerdrEventStream, WorkspaceHandle } from '../herdr/types.ts';
import type { RunRecord, RunStatus, TaskRecord } from '../core/types.ts';
import type { HerdrAgentState } from '../core/types.ts';
import { resolveAgentEntry } from '../config.ts';
import { existsSync } from 'node:fs';
import type { RunnerEnv, StartExecutionInput } from './executions.ts';
import { startExecution, resolveReviewerEntry, closePaneSafe, rebuildRolePrompt } from './executions.ts';
import { agentStartArgs } from '../herdr/agent-args.ts';
import { verifyTaskWork } from './phases/verify.ts';
import { cleanupTaskResources } from './cleanup.ts';
import { topologicalTasks, validateGraph } from '../core/contract.ts';

const TERMINAL_RUN: ReadonlySet<string> = new Set(['done', 'cancelled', 'abandoned', 'failed']);

/** Task states that need no further delivery work. */
const SETTLED_TASK: ReadonlySet<string> = new Set(['integrated', 'reclaimed', 'discarded', 'failed']);

export type ReconcileDecisionKind =
  | 'result_recovered'
  | 'pane_lost_new_attempt'
  | 'pane_lost_no_attempt'
  | 'cleanup_resumed'
  | 'cleanup_deferred'
  | 'snapshot_unavailable'
  | 'subscription_unavailable'
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
  /** Fencing token held while this process is the single writer (R2-06). */
  private leaseFence: string | null = null;

  constructor(env: RunnerEnv, opts: RunnerOptions = {}) {
    this.env = env;
    this.opts = opts;
  }

  // ------------------------------------------------------------------ tick

  /** One bounded scheduling/progress pass. */
  async tickOnce(): Promise<void> {
    const { db, runId } = this.env;
    if (this.leaseFence) this.ensureLease();

    const run = getRun(db, runId);
    if (!run) throw new AteamError(`run not found: ${runId}`);
    if (TERMINAL_RUN.has(run.status)) return;

    if (run.revisionPending) await this.consumeContractRevision();

    const tasks = listTasks(db, runId);
    const executions = listActiveExecutions(db, runId);

    for (const exec of executions) {
      await this.progressExecution(exec, tasks);
    }

    // R2-02: replay follow-up dispatches a crash interrupted after a result
    // was consumed but before the next role/attempt started
    await this.resumePendingDispatches(listTasks(db, runId), listActiveExecutions(db, runId));

    await this.maybeIntegrate();
    await this.scheduleReady();
    await this.updateAggregateStatus();
    await this.selfReport();
  }

  /** Renew the lease and verify this process still holds the fencing token
   * (R2-06). heartbeat() is a token-CAS update: zero rows changed means
   * another writer took over — this runner must not write delivery state. */
  private ensureLease(): void {
    if (!this.leaseFence) return;
    if (!heartbeat(this.env.db, this.env.runId, this.leaseFence)) {
      throw new AteamError('runner lease lost (fencing token no longer current) — another writer holds this run', {
        exitCode: 1,
      });
    }
  }

  /** Loop until terminal; returns the mechanical exit code. */
  async runUntilTerminal(signal?: AbortSignal): Promise<ExitCode> {
    const fence = acquireLease(this.env.db, this.env.runId);
    if (!fence) {
      throw new AteamError(`run ${this.env.runId} has a live runner lease; attach instead`, {
        exitCode: 1,
        remediation: 'use `agent-team status` to find the active runner',
      });
    }
    this.leaseFence = fence;
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
    releaseLease(this.env.db, this.env.runId, this.leaseFence);
    this.leaseFence = null;
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

  /**
   * Consume revision_pending (review 01 #6): validate the revision against
   * the executed state, apply additions/removals/spec changes and the
   * consumption marker in ONE transaction, then refresh the Runner's
   * effective contract so scheduling, skills and briefs read the revision.
   * An incompatible revision lands in needs_attention and stays pending —
   * resolvable by a corrected revision, never half-applied.
   *
   * Review 02: a revision may NOT move the project binding (R2-04) — every
   * ledgered task branch/worktree belongs to the repo the run was created
   * against, and cleanup would otherwise delete same-named branches in a
   * different repository. A revision that changes the delivered task set
   * after final verification is also refused (R2-05): the final-verification
   * conclusion binds to that set and the integration HEAD, so accepting it
   * silently would keep a stale finalVerified while new tasks can never
   * reach integration.
   */
  async consumeContractRevision(): Promise<void> {
    const { db, runId } = this.env;
    const run = getRun(db, runId);
    if (!run) return;
    const contract = getContractRevisionAt(db, runId, run.contractRevision);
    if (!contract) {
      clearRevisionPending(db, runId);
      return;
    }
    // structural compatibility first: fresh graph checks (deps, cycles,
    // duplicate ids, exclusive path ownership) over the FULL new task set
    try {
      validateGraph(contract);
    } catch (err) {
      updateRunStatus(db, runId, 'needs_attention', `contract revision rejected: ${String(err)}`);
      return; // revision_pending stays set
    }

    // R2-04: the project binding is frozen for the lifetime of the run
    if (
      contract.project.id !== run.projectId
      || contract.project.repoRoot !== run.repoRoot
      || contract.project.baseRef !== run.baseRef
    ) {
      updateRunStatus(
        db, runId, 'needs_attention',
        `contract revision rejected: project binding changed (run is bound to ${run.projectId} ${run.repoRoot}@${run.baseRef}); start a new run instead`,
      );
      return; // revision_pending stays set
    }

    const tasks = listTasks(db, runId);
    const existing = new Map(tasks.map((t) => [t.taskId, t]));
    const freshIds = new Set(contract.tasks.map((t) => t.id));

    // removals: only never-started tasks may be dropped from a live run
    const incompatible = tasks
      .filter((t) => !freshIds.has(t.taskId) && (t.status !== 'pending' || t.attempts > 0))
      .map((t) => t.taskId);
    if (incompatible.length > 0) {
      updateRunStatus(db, runId, 'needs_attention', `contract revision removes already-executed tasks: ${incompatible.join(', ')}`);
      return; // revision_pending stays set
    }

    // R2-05: after final verification the delivered set is frozen — the
    // conclusion (and its verification record) is bound to exactly these
    // tasks, this revision and the integration HEAD. A revision that would
    // change that set is rejected OUTRIGHT: re-opening integration from here
    // cannot restore the pre-verification world (resources may already be
    // reclaimed), and holding it pending would strand a terminal run.
    if (run.finalVerified) {
      const affectsDelivery =
        tasks.some((t) => !freshIds.has(t.taskId)) ||
        contract.tasks.some((spec) => !existing.has(spec.id)) ||
        contract.tasks.some((spec) => {
          const task = existing.get(spec.id);
          return !!task
            && JSON.stringify(task.spec) !== JSON.stringify(spec)
            && !['integrated', 'reclaimed'].includes(task.status);
        });
      if (affectsDelivery) {
        addEvent(db, runId, 'CONTRACT_REVISED', {
          payload: {
            revision: run.contractRevision,
            rejected: true,
            reason: 'changes the delivered task set after final verification',
          },
        });
        clearRevisionPending(db, runId);
        return;
      }
    }

    inTransaction(db, () => {
      for (const task of tasks) {
        if (freshIds.has(task.taskId)) continue;
        db.run('DELETE FROM tasks WHERE run_id = ? AND task_id = ?', [runId, task.taskId]);
        addEvent(db, runId, 'CONTRACT_REVISED', {
          taskId: task.taskId,
          payload: { revision: run.contractRevision, removed: true },
        });
      }
      for (const spec of contract.tasks) {
        const task = existing.get(spec.id);
        if (!task) {
          insertTask(db, runId, spec);
          addEvent(db, runId, 'CONTRACT_REVISED', {
            taskId: spec.id,
            payload: { revision: run.contractRevision, added: true },
          });
          continue;
        }
        const specChanged =
          JSON.stringify(task.spec) !== JSON.stringify(spec) &&
          task.status !== 'integrated' &&
          task.status !== 'reclaimed';
        const unblock = task.status === 'blocked_on_contract';
        if (!specChanged && !unblock) continue;
        if (specChanged) {
          db.run('UPDATE tasks SET spec_json = ? WHERE run_id = ? AND task_id = ?', [
            JSON.stringify(spec), runId, task.taskId,
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
      }
      // consumed atomically with the task changes — a crash mid-apply retries
      clearRevisionPending(db, runId);
      // a corrected revision resolves a previously refused one
      db.run('UPDATE runs SET error = NULL WHERE id = ?', [runId]);
    });

    // the revision is now the authoritative version for everything the
    // Runner derives from the contract (topology, skills, briefs, base info)
    this.env.contract = contract;
  }

  // ------------------------------------------------------------ executions

  private async progressExecution(exec: ExecutionRecord, tasks: TaskRecord[]): Promise<void> {
    const { db, runId, client } = this.env;
    const task = tasks.find((t) => t.taskId === exec.taskId) ?? getTask(db, runId, exec.taskId);
    if (!task) return;

    // interrupted dispatch (review 01 #12): the row exists but the prompt was
    // never confirmed — resume or fail it explicitly, never poll forever
    if (exec.status === 'starting' && !exec.promptSentAt) {
      await this.resumePromptDispatch(exec, task);
      return;
    }

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

    // Result gate, phase 1 (receipt): file presence + schema + digest chain.
    const fresh = await this.acceptResultFile(exec);
    if (fresh === 'invalid') return;
    if (fresh) {
      await this.applyExecutionResult(fresh.exec, task, fresh.result);
      return;
    }
    // phase 2 (application) replay: a result persisted by a previous process
    // whose transition never landed (crash between receipt and application)
    // is re-applied here — the applied digest, not the receipt, is the guard
    if (exec.resultDigest && exec.resultDigest !== exec.resultAppliedDigest && exec.result) {
      await this.applyExecutionResult(exec, task, exec.result as WorkerResult | ReviewerResult | IntegrationResult);
    }
  }

  /** Phase 1: read + validate the role result file; persists receipt when new.
   * Returns the freshly-received result, 'invalid' for schema rejects, or
   * null when there is nothing new to receive. */
  private async acceptResultFile(
    exec: ExecutionRecord,
  ): Promise<{ exec: ExecutionRecord; result: WorkerResult | ReviewerResult | IntegrationResult } | 'invalid' | null> {
    const { db, runId } = this.env;
    const read = exec.resultPath ? await readResultFile(exec.resultPath) : null;
    if (!read) return null;
    if (exec.resultDigest === read.digest) return null; // already received this exact file
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
      return 'invalid';
    }
    const received: ExecutionRecord = {
      ...exec,
      resultDigest: read.digest,
      result,
      resultReceivedAt: nowIso(),
    };
    updateExecution(db, exec.id, { resultDigest: read.digest, result, resultReceivedAt: received.resultReceivedAt });
    addEvent(db, runId, 'RESULT_ACCEPTED', {
      taskId: exec.taskId,
      executionId: exec.id,
      payload: { role: exec.role, digest: read.digest, status: (result as { status: string }).status },
    });
    return { exec: received, result };
  }

  /** Phase 2: apply a received result to the task state machine exactly once
   * per digest. Transition failures surface (needs_attention) and leave the
   * applied digest unset, so the next tick/reconcile replays the stored
   * result instead of dropping it (ADR: 结果落盘后补做尚未持久化状态转换). */
  private async applyExecutionResult(
    exec: ExecutionRecord,
    task: TaskRecord,
    result: WorkerResult | ReviewerResult | IntegrationResult,
  ): Promise<void> {
    const { db, runId } = this.env;
    try {
      if (exec.role === 'worker') {
        await this.applyWorkerResult(exec, task, result as WorkerResult);
      } else if (exec.role === 'reviewer') {
        await this.applyReviewerResult(exec, task, result as ReviewerResult);
      } else {
        await this.applyIntegratorResult(exec, task, result as IntegrationResult);
      }
    } catch (err) {
      // transition failures are real faults (missing panes, git errors) — surface, never swallow
      addEvent(db, runId, 'RECONCILE_DECISION', {
        executionId: exec.id,
        payload: { reason: 'apply_failed', error: String(err) },
      });
      updateRunStatus(db, runId, 'needs_attention', `apply failed: ${String(err)}`);
      return;
    }
    // the transition persisted without throwing — pin this digest as applied
    if (exec.resultDigest) {
      updateExecution(db, exec.id, { resultAppliedDigest: exec.resultDigest });
    }
    this.clearRunError();
  }

  /** Clear a persisted run error — the engine made real progress, so the
   * attention flag it set earlier no longer applies. A refused revision is
   * sticky: while revision_pending it is not washed away by progress
   * (R2-04/R2-05 refusals must stay visible until corrected). */
  private clearRunError(): void {
    const { db, runId } = this.env;
    if (getRun(db, runId)?.revisionPending) return;
    db.run('UPDATE runs SET error = NULL, updated_at = ? WHERE id = ?', [nowIso(), runId]);
  }

  /** ADR 恢复顺序第一步：已落盘结果优先于新 attempt。Applies the persisted
   * result (receipt + transition) for an execution whose pane is gone or
   * unobservable; true when a usable result existed and was applied. */
  private async recoverPersistedResult(exec: ExecutionRecord, task: TaskRecord): Promise<boolean> {
    const fresh = await this.acceptResultFile(exec);
    if (fresh === 'invalid') return false;
    if (fresh) {
      await this.applyExecutionResult(fresh.exec, task, fresh.result);
      return true;
    }
    if (exec.resultDigest && exec.resultDigest !== exec.resultAppliedDigest && exec.result) {
      await this.applyExecutionResult(exec, task, exec.result as WorkerResult | ReviewerResult | IntegrationResult);
      return true;
    }
    return false;
  }

  /** Resume an execution stuck in `starting`: finish the agent start and/or
   * prompt dispatch, or abandon it for a fresh attempt when nothing is
   * recoverable (review 01 #12 — no permanently stalled executions). */
  private async resumePromptDispatch(exec: ExecutionRecord, task: TaskRecord): Promise<void> {
    const { db, runId, client } = this.env;
    const abandon = async (reason: string): Promise<void> => {
      updateExecution(db, exec.id, { status: 'abandoned', paneState: 'gone' });
      addEvent(db, runId, 'RECONCILE_DECISION', {
        executionId: exec.id,
        payload: { reason, promptSent: false },
      });
      const current = getTask(db, runId, task.taskId)!;
      if (exec.role === 'worker') await this.retryWorker(current, {});
      else if (exec.role === 'reviewer') await this.startReviewer(current);
      else {
        updateRunRuntimeState(db, runId, { integrationStalled: true });
        updateTask(db, runId, task.taskId, { lastError: 'integrator dispatch never completed; resolve manually' });
        updateRunStatus(db, runId, 'needs_attention', 'integrator dispatch never completed');
      }
    };

    if (!exec.paneId) {
      // the split never landed — the dispatch never reached Herdr
      await abandon('dispatch_interrupted_no_pane');
      return;
    }
    // R2-10: an observability ERROR is not "agent absent" — restarting on
    // that guess would spawn a duplicate agent. Surface it for attention;
    // only a definitive null (Herdr knows the agent no longer exists) restarts.
    const observed = await client.getAgent(exec.agentName).then(
      (agent) => agent,
      (err) => err instanceof Error ? err : new Error(String(err)),
    );
    if (observed instanceof Error) {
      updateRunStatus(db, runId, 'needs_attention', `agent ${exec.agentName} state unobservable during dispatch resume: ${observed.message}; resolve manually`);
      return;
    }
    if (!observed) {
      try {
        const entry = resolveAgentEntry(this.env.config, task.spec.agent, exec.role);
        await client.startAgent({
          name: exec.agentName,
          kind: exec.agentKind,
          paneId: exec.paneId,
          args: agentStartArgs(entry),
        });
      } catch (err) {
        await abandon(`dispatch_interrupted_agent_gone: ${String(err)}`);
        return;
      }
    }
    const worktreePath = exec.role === 'integrator'
      ? getRun(db, runId)?.integrationPath ?? task.worktreePath
      : task.worktreePath;
    const prompt = worktreePath ? rebuildRolePrompt(this.env, exec, worktreePath) : null;
    if (!prompt) {
      // persisted digest no longer reproducible — human decision required
      updateExecution(db, exec.id, { status: 'abandoned', paneState: 'retained' });
      updateRunStatus(db, runId, 'needs_attention', `execution ${exec.id} prompt could not be rebuilt; attach the pane to decide`);
      return;
    }
    // R2-10: prompt delivery is idempotent by requestId (the persisted
    // prompt digest) — the runtime dedupes a re-sent prompt, so recovery
    // never has to GUESS from transient agent state whether the first send
    // landed. Runtimes without request-id support must not call this path
    // blindly: the requestId contract is documented on HerdrRuntimeClient.
    await client.promptAgent({
      target: exec.agentName, text: prompt, wait: false, until: [], timeoutMs: 5000,
      requestId: exec.promptDigest ?? undefined,
    });
    updateExecution(db, exec.id, { promptSentAt: nowIso(), status: 'running' });
    addEvent(db, runId, 'EXECUTION_PROMPTED', {
      taskId: exec.taskId,
      executionId: exec.id,
      payload: { role: exec.role, attemptNo: exec.attemptNo, cycleNo: exec.cycleNo, agentName: exec.agentName, resumed: true },
    });
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
        // R2-02: persist the retry intent BEFORE consuming the result, so a
        // crash between "result consumed" and "next attempt started" is
        // replayed from the task row. R2-11: the pane RETAINS for attach
        // (ADR: 失败 pane 保留以供 attach) — only the scheduling slot closes.
        updateTask(this.env.db, runId, task.taskId, { pendingDispatch: 'worker_retry' });
        updateExecution(this.env.db, exec.id, { status: 'completed', paneState: 'retained' });
        await this.retryWorker(task, { lastWorkerSummary: result.summary });
        return;
    }
  }

  private async verifyAndHandToReview(exec: ExecutionRecord, task: TaskRecord): Promise<void> {
    const { db, runId, client, config, home } = this.env;
    const current = getTask(db, runId, task.taskId)!;
    // idempotent replay (review 01 #1): a previous process may have crashed
    // after persisting the transition — never redo verification/commit/review
    // once the task has advanced past this result
    if (['reviewing', 'approved', 'integrated', 'reclaimed', 'discarded', 'changes_requested'].includes(current.status)) return;
    updateTask(db, runId, task.taskId, { status: 'verifying' });
    const outcome = await verifyTaskWork({
      worktreePath: current.worktreePath!,
      task: current,
      allowlist: config.verificationAllowlist,
      baseSha: current.startSha ?? 'HEAD',
      logDir: `${home.runsDir}/${runId}/logs`,
    });
    // R2-14: the gate outcome becomes a queryable record (revision, HEAD,
    // commands, log) — events alone are not durable verification evidence
    insertVerification(db, {
      runId,
      taskId: task.taskId,
      kind: 'task',
      attemptNo: exec.attemptNo,
      ok: outcome.ok,
      detail: {
        contractRevision: getRun(db, runId)?.contractRevision,
        headSha: outcome.headAfter,
        baseSha: current.startSha ?? outcome.headBefore,
        violations: outcome.violations,
        diffFiles: outcome.diffFiles,
        commands: outcome.commands.map((c) => ({ command: c.command, ok: c.ok, exitCode: c.exitCode })),
      },
      logPath: outcome.logPath,
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
      // R2-02 + R2-11: retry intent persists first; the pane stays retained
      // (failed gate = failed pane, kept for attach); only the slot closes
      updateTask(db, runId, task.taskId, { pendingDispatch: 'worker_retry' });
      updateExecution(db, exec.id, { status: 'completed', paneState: 'retained' });
      await this.retryWorker(getTask(db, runId, task.taskId)!, {});
      return;
    }

    // R2-06: the verification may have run long — renew the lease (token
    // CAS) before any delivery write; a dispossessed runner must not commit
    this.ensureLease();

    await stageAll(current.worktreePath!);
    // crash-safe commit: if the task commit already landed (crash after
    // commit, before the status write) there is nothing staged — reuse HEAD
    const sha = (await hasStagedChanges(current.worktreePath!))
      ? await commit(current.worktreePath!, `ateam(${runId}): task ${task.taskId} attempt ${exec.attemptNo}`)
      : await currentHead(current.worktreePath!);
    // R2-02: the review dispatch intent lands in the SAME write that
    // advances the status, so a crash before startReviewer replays
    updateTask(db, runId, task.taskId, { status: 'reviewing', commitSha: sha, pendingDispatch: 'review' });
    updateExecution(db, exec.id, { status: 'completed', paneState: 'closed_success' });
    await closePaneSafe(client, exec.paneId);

    await this.startReviewer(getTask(db, runId, task.taskId)!);
  }

  private async startReviewer(task: TaskRecord): Promise<void> {
    const { db, runId } = this.env;
    // the execution ledger is the authority for cycle numbering: a replay
    // after a crash continues from what actually started, never double-starts
    // (the (run, task, role, attempt, cycle) unique constraint backstops this)
    const startedCycles = listExecutions(db, runId)
      .filter((e) => e.taskId === task.taskId && e.role === 'reviewer')
      .map((e) => e.cycleNo);
    const cycle = Math.max(0, ...startedCycles) + 1;
    const workerEntry = resolveAgentEntry(this.env.config, task.spec.agent, 'worker');
    const reviewerEntry = resolveReviewerEntry(this.env.config, workerEntry.kind);
    updateTask(db, runId, task.taskId, { reviewCycles: cycle });
    await startExecution(this.env, {
      role: 'reviewer',
      task,
      attemptNo: task.attempts,
      cycleNo: cycle,
      entry: reviewerEntry,
    });
    // the dispatch is on the ledger — the recovery intent is served (R2-02)
    this.clearPendingDispatch(task.taskId);
  }

  private async retryWorker(task: TaskRecord, retry: { lastWorkerSummary?: string; lastReview?: unknown }): Promise<void> {
    const { db, runId, config } = this.env;
    const current = getTask(db, runId, task.taskId)!;
    // attempt numbers come from the execution ledger: a replay after a crash
    // reuses the persisted attempt (and never double-starts one that lives)
    const started = listExecutions(db, runId)
      .filter((e) => e.taskId === task.taskId && e.role === 'worker')
      .map((e) => e.attemptNo);
    const latest = latestExecutionFor(db, runId, task.taskId, 'worker');
    if (latest && ['starting', 'running', 'blocked', 'result_pending'].includes(latest.status)) {
      this.clearPendingDispatch(task.taskId); // an active attempt covers the intent
      return;
    }
    const attemptNo = Math.max(current.attempts, ...started, 0) + 1;
    if (attemptNo > config.defaults.maxWorkerAttempts) {
      updateTask(db, runId, task.taskId, { status: 'failed', lastError: 'worker attempts exhausted' });
      this.clearPendingDispatch(task.taskId); // no dispatch will follow
      return;
    }
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
    // the dispatch is on the ledger — the recovery intent is served (R2-02)
    this.clearPendingDispatch(task.taskId);
  }

  /** Clear the persisted follow-up dispatch intent once it has been handed
   * off to the execution ledger (R2-02). */
  private clearPendingDispatch(taskId: string): void {
    this.env.db.run(
      'UPDATE tasks SET pending_dispatch = NULL, updated_at = ? WHERE run_id = ? AND task_id = ?',
      [nowIso(), this.env.runId, taskId],
    );
  }

  /** R2-02: replay a crash-interrupted follow-up dispatch. Consuming a role
   * result and starting the next role/attempt are two steps; the intent is
   * persisted on the task BEFORE the result is consumed, so a crash between
   * the two leaves a recoverable task row instead of a stranded run. Both
   * dispatchers are ledger-idempotent, so replays never double-start. */
  private async resumePendingDispatches(tasks: TaskRecord[], active: ExecutionRecord[]): Promise<void> {
    const { db, runId } = this.env;
    for (const task of tasks) {
      const intent: PendingDispatch | null = task.pendingDispatch;
      if (!intent) continue;
      const role = intent === 'review' ? 'reviewer' : 'worker';
      if (!active.some((e) => e.taskId === task.taskId && e.role === role)) {
        const current = getTask(db, runId, task.taskId);
        if (!current) continue;
        addEvent(db, runId, 'RECONCILE_DECISION', {
          taskId: task.taskId,
          payload: { reason: 'pending_dispatch_resumed', intent },
        });
        if (intent === 'review') await this.startReviewer(current);
        else await this.retryWorker(current, current.review ? { lastReview: current.review } : {});
      } else {
        // dispatch already started before the crash — the active execution
        // (possibly a resumable 'starting' row) covers the intent
        this.clearPendingDispatch(task.taskId);
      }
    }
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
    // R2-02: persist the retry intent before consuming the review verdict
    updateTask(db, runId, task.taskId, { pendingDispatch: 'worker_retry' });
    updateExecution(db, exec.id, { status: 'completed', paneState: 'closed_success' });
    await closePaneSafe(client, exec.paneId);
    await this.retryWorker(task, { lastReview: result });
  }

  private async applyIntegratorResult(exec: ExecutionRecord, task: TaskRecord, result: IntegrationResult): Promise<void> {
    const { db, runId, client } = this.env;
    const run = getRun(db, runId)!;
    const worktreePath = run.integrationPath;
    if (!worktreePath) throw new AteamError('integration worktree missing for integrator result');
    if (result.status === 'completed') {
      await stageAll(worktreePath);
      // crash-safe: reuse HEAD when the resolve commit already landed
      const sha = (await hasStagedChanges(worktreePath))
        ? await commit(worktreePath, `ateam(${runId}): integrate task ${task.taskId} (conflicts resolved)`)
        : await currentHead(worktreePath);
      updateTask(db, runId, task.taskId, { status: 'integrated', integrationCommit: sha });
      updateRunRuntimeState(db, runId, { conflictTaskId: null });
      updateExecution(db, exec.id, { status: 'completed', paneState: 'closed_success' });
      await closePaneSafe(client, exec.paneId);
      return;
    }
    updateRunRuntimeState(db, runId, { integrationStalled: true });
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
      (task.spec.dependsOn ?? []).every((dep) => SETTLED_TASK.has(statusById.get(dep) ?? ''));

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
    const run = getRun(db, runId)!;
    if (run.integrationStalled) return;
    if (run.finalVerified) {
      await this.runCleanupPhase(run);
      return;
    }
    const active = listActiveExecutions(db, runId);
    if (active.length > 0) return; // finish execution work first

    const approved = tasks.filter((t) => t.status === 'approved');
    const integrated = tasks.filter((t) => t.status === 'integrated');
    const settled = tasks.every((t) => SETTLED_TASK.has(t.status));

    if (approved.length === 0) {
      const anyFailed = tasks.some((t) => t.status === 'failed');
      if (integrated.length > 0 && settled && !anyFailed) {
        // resume path (review 01 #3): the integration worktree may come from
        // the ledger — only verify when a usable worktree exists
        await this.ensureIntegrationWorktree(tasks);
        const refreshed = getRun(db, runId)!;
        if (refreshed.integrationPath) {
          await this.finalVerification(tasks);
        } else if (!refreshed.integrationStalled) {
          updateRunRuntimeState(db, runId, { integrationStalled: true });
          updateRunStatus(db, runId, 'needs_attention', 'integration worktree unavailable for final verification');
        }
      }
      return;
    }
    await this.ensureIntegrationWorktree(tasks);
    const current = getRun(db, runId)!;
    for (const taskId of topologicalTasks(this.env.contract)) {
      const task = tasks.find((t) => t.taskId === taskId);
      if (!task || task.status !== 'approved') continue;
      if (current.conflictTaskId && current.conflictTaskId !== task.taskId) continue; // serialize conflicts
      await this.integrateTask(task);
    }
  }

  /** Reclaim integrated tasks step by step; done once everything is settled. */
  private async runCleanupPhase(run: RunRecord): Promise<void> {
    const { db, runId, client } = this.env;
    const tasks = listTasks(db, runId);
    for (const task of tasks.filter((t) => t.status === 'integrated')) {
      await cleanupTaskResources(this.env, task);
    }
    // run-level temp resource: the integration worktree itself
    if (run.integrationWorkspaceId && listTasks(db, runId).every((t) => SETTLED_TASK.has(t.status))) {
      try {
        await client.removeWorktree({ workspaceId: run.integrationWorkspaceId, force: true });
        markResourceState(db, 'workspace', run.integrationWorkspaceId, 'reclaimed');
        updateRunRuntimeState(db, runId, { integrationWorkspaceId: null, integrationPath: null });
      } catch {
        /* retried on the next tick / by clean */
      }
    }
    const live = getRun(db, runId)!;
    const remaining = listTasks(db, runId);
    if (remaining.every((t) => SETTLED_TASK.has(t.status)) && !live.integrationWorkspaceId) {
      updateRunStatus(db, runId, 'done');
      addEvent(db, runId, 'RUN_FINISHED', { payload: { status: 'done' } });
    }
  }

  private async ensureIntegrationWorktree(tasks: TaskRecord[]): Promise<void> {
    const { db, runId, client } = this.env;
    const run = getRun(db, runId)!;
    if (run.integrationPath && run.integrationWorkspaceId) {
      // R2-12: a ledgered mapping is only reused when Herdr STILL knows the
      // workspace and the path exists on disk — after a server restart the
      // mapping may point at nothing, and silently building elsewhere would
      // orphan the already-integrated commits
      const snap = await client.snapshot().catch(() => null);
      const wsAlive = snap ? snap.workspaces.some((w) => w.workspaceId === run.integrationWorkspaceId) : true;
      if (wsAlive && existsSync(run.integrationPath)) return;
    }
    const firstWithWorkspace = tasks.find((t) => t.workspaceId);
    if (!firstWithWorkspace) return;
    const branch = run.integrationBranch ?? `ateam/${runId}/integration`;
    // resume order (review 01 #3): reopen the ledger-recorded workspace →
    // reopen by branch → create fresh; a restart must not orphan the
    // already-integrated commits by silently rebuilding elsewhere
    let handle: WorkspaceHandle | null = null;
    if (run.integrationWorkspaceId) {
      handle = await client
        .openWorktree({ sourceWorkspaceId: run.integrationWorkspaceId })
        .catch(() => null);
    }
    if (!handle) {
      handle = await client
        .openWorktree({ sourceWorkspaceId: firstWithWorkspace.workspaceId!, branch })
        .catch(() => null);
    }
    if (!handle) {
      handle = await client
        .createWorktreeWorkspace({
          sourceWorkspaceId: firstWithWorkspace.workspaceId!,
          branch,
          label: `${runId}/integration`,
          focus: false,
        })
        .catch(() => null);
    }
    if (!handle) {
      updateRunRuntimeState(db, runId, { integrationStalled: true });
      updateRunStatus(db, runId, 'needs_attention', `integration worktree ${branch} could not be reopened after restart`);
      addEvent(db, runId, 'RECONCILE_DECISION', {
        payload: { reason: 'integration_worktree_unrecoverable', branch },
      });
      return;
    }
    // R2-12: the FIRST creation's base SHA is the integration baseline — a
    // reopen after restart must preserve it, because HEAD has already moved
    // by the integrated commits and would corrupt the final-verification diff
    const baseSha = run.integrationBaseSha ?? await revParse(handle.worktree.path, 'HEAD').catch(() => null);
    insertResource(db, {
      runId, kind: 'workspace', herdrId: handle.workspace.workspaceId,
      branch: handle.worktree.branch, path: handle.worktree.path,
    });
    updateRunRuntimeState(db, runId, {
      integrationWorkspaceId: handle.workspace.workspaceId,
      integrationPath: handle.worktree.path,
      integrationBranch: handle.worktree.branch,
      integrationRootPaneId: handle.rootPane.paneId,
      integrationBaseSha: baseSha,
    });
  }

  private async integrateTask(task: TaskRecord): Promise<void> {
    const { db, runId, config } = this.env;
    const run = getRun(db, runId)!;
    const path = run.integrationPath;
    if (!path || !run.integrationRootPaneId) return;

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
    updateRunRuntimeState(db, runId, { conflictTaskId: task.taskId });
    const integratorEntry = resolveAgentEntry(config, task.spec.agent, 'integrator');
    await startExecution(this.env, {
      role: 'integrator',
      task,
      attemptNo: task.attempts + 1,
      cycleNo: 0,
      entry: integratorEntry,
      targetWorktree: { path, rootPaneId: run.integrationRootPaneId },
      notes: `Integration conflict while cherry-picking ${task.commitSha}. Conflicted files:\n${res.conflicts.map((f) => `- ${f}`).join('\n')}\nResolve conflicts in place. Do NOT commit — the runner commits after your result is accepted.`,
    });
    addEvent(db, runId, 'RECONCILE_DECISION', {
      taskId: task.taskId,
      payload: { reason: 'integration_conflict', conflicts: res.conflicts },
    });
  }

  private async finalVerification(tasks: TaskRecord[]): Promise<void> {
    const { db, runId, config, home } = this.env;
    const run = getRun(db, runId)!;
    const path = run.integrationPath;
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
      baseSha: run.integrationBaseSha ?? 'HEAD',
      logDir: `${home.runsDir}/${runId}/logs`,
    });
    // R2-06: renew the lease (token CAS) before the delivery conclusion; a
    // dispossessed runner must not mark the run final-verified
    this.ensureLease();
    const integrationHead = await currentHead(path).catch(() => null);
    // R2-14: the final conclusion is persisted as a queryable record bound
    // to the contract revision and the verified integration HEAD — this
    // record (not just the run flag) is what cleanup eligibility reads
    insertVerification(db, {
      runId,
      kind: 'final',
      ok: outcome.ok,
      detail: {
        phase: 'integration_final',
        contractRevision: run.contractRevision,
        headSha: integrationHead,
        baseSha: run.integrationBaseSha ?? null,
        violations: outcome.violations,
        diffFiles: outcome.diffFiles,
        commands: outcome.commands.map((c) => ({ command: c.command, ok: c.ok, exitCode: c.exitCode })),
      },
      logPath: outcome.logPath,
    });
    addEvent(db, runId, outcome.ok ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED', {
      payload: { phase: 'integration_final', violations: outcome.violations, logPath: outcome.logPath },
    });
    if (outcome.ok) {
      // persisted immediately: cleanup eligibility everywhere keys off this
      // (the verification record above is written FIRST, so the flag can
      // never exist without its durable evidence)
      updateRunRuntimeState(db, runId, { finalVerified: true, finalVerifiedAt: nowIso() });
      this.clearRunError();
    } else {
      updateRunStatus(db, runId, 'needs_attention', 'integration final verification failed');
    }
  }

  // ------------------------------------------------------------- reconcile

  /** One reconciliation pass: subscribe (confirmed) → snapshot ∩ ledger,
   * recover, resume cleanups (ADR: 先订阅后快照、结果优先于新 attempt). */
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

    // ADR recovery order (R2-07): establish the event subscription AND wait
    // for its confirmation BEFORE reading the snapshot, so the observe gap
    // is bridged by buffered events instead of being silently missed. A
    // subscription that cannot be confirmed means the required order cannot
    // be guaranteed — report it and defer every judgment (no snapshot-only
    // degradation).
    let stream: HerdrEventStream;
    try {
      stream = await client.subscribe();
    } catch (err) {
      decisions.push({
        kind: 'subscription_unavailable',
        detail: `event subscription failed (${String(err)}); recovery judgments deferred`,
      });
      return decisions;
    }
    try {
        const snap = await client.snapshot().catch(() => null);
        if (!snap) {
          // 快照不可用 ⇒ 停止判定（review 01 #4）：绝不把"看不见"当成"pane 丢失"
          decisions.push({
            kind: 'snapshot_unavailable',
            detail: 'runtime snapshot failed; pane-loss judgments deferred to the next pass',
          });
          return decisions;
        }
        // R2-07: merge events buffered between the subscription ACK and the
        // snapshot into the observation sets — removal events never add
        // liveness, so a pane closed in the gap still judges as gone
        const alivePanes = new Set(snap.panes.map((p) => p.paneId));
        const observedIds = new Set<string>([
          ...snap.workspaces.map((w) => w.workspaceId),
          ...snap.panes.map((p) => p.paneId),
        ]);
        for (const ev of stream.drainPending?.() ?? []) {
          if (ev.type === 'pane.closed' || ev.type === 'pane.exited' || ev.type === 'worktree.removed') continue;
          if (ev.paneId) alivePanes.add(ev.paneId);
          if (ev.paneId) observedIds.add(ev.paneId);
          if (ev.workspaceId) observedIds.add(ev.workspaceId);
        }
        const tasks = listTasks(db, runId);
        // only resources that existed before this pass may be swept as lost/orphaned
        const preExistingResources = new Set(listActiveResources(db, runId).map((r) => `${r.kind}:${r.herdrId}`));

        for (const exec of listActiveExecutions(db, runId)) {
          const task = tasks.find((t) => t.taskId === exec.taskId);
          // 1) 已落盘结果优先：有效结果存在就补做转换，绝不为此新建 attempt。
          // R2-08: dry-run probes the same condition READ-ONLY — receiving
          // and applying a persisted result is a state change and must not
          // happen under --dry-run.
          if (task && exec.resultPath) {
            if (opts.dryRun) {
              if (await this.hasRecoverableResult(exec)) {
                decisions.push({ kind: 'result_recovered', taskId: exec.taskId, executionId: exec.id, detail: 'dry-run: persisted result would be applied' });
                continue;
              }
            } else {
              const recovered = await this.recoverPersistedResult(exec, task);
              if (recovered) {
                decisions.push({ kind: 'result_recovered', taskId: exec.taskId, executionId: exec.id, detail: 'persisted result applied' });
                continue;
              }
            }
          }
          // 2) pane 仍然存活：回到常规观察/结果门
          if (exec.paneId && alivePanes.has(exec.paneId)) {
            decisions.push({ kind: 'result_recovered', taskId: exec.taskId, executionId: exec.id, detail: 'pane alive; re-entered result gate' });
            await apply(() => this.progressExecution(exec, listTasks(db, runId)));
            continue;
          }
          // 3) pane 丢失且无有效结果：abandon + 新 attempt（无论 prompt 是否发出）
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
          await this.recoverExecutionOnFreshWorktree(exec, task, decisions);
        }

      // cleanup eligibility (review 01 #2 + R2-03/R2-14): only after the
      // final verification is persisted as a PASSING record; reconciling an
      // unverified run reports the deferral instead of destroying worktrees
      // that the final gate still needs
      if (run.finalVerified && hasPassingFinalVerification(db, runId)) {
        for (const task of listTasks(db, runId).filter((t) => t.status === 'integrated')) {
          decisions.push({ kind: 'cleanup_resumed', taskId: task.taskId });
          await apply(async () => {
            await cleanupTaskResources(this.env, task);
          });
        }
      } else if (listTasks(db, runId).some((t) => t.status === 'integrated')) {
        decisions.push({
          kind: 'cleanup_deferred',
          detail: 'integrated tasks kept until a passing final verification is persisted',
        });
      }

      for (const res of listActiveResources(db, runId)) {
        if (!preExistingResources.has(`${res.kind}:${res.herdrId}`)) continue;
        if (observedIds.has(res.herdrId)) continue;
        decisions.push({
          kind: res.provenance ? 'resource_lost' : 'resource_orphaned',
          taskId: res.taskId ?? undefined,
          detail: `${res.kind}:${res.herdrId}`,
        });
        await apply(() => markResourceState(db, res.kind, res.herdrId, res.provenance ? 'lost' : 'orphaned'));
      }

      return decisions;
    } finally {
      stream.close();
    }
  }

  /** Read-only dry-run probe (R2-08): would recoverPersistedResult find
   * work for this execution? Never writes. */
  private async hasRecoverableResult(exec: ExecutionRecord): Promise<boolean> {
    const read = exec.resultPath ? await readResultFile(exec.resultPath) : null;
    if (!read) return false;
    if (read.digest !== exec.resultDigest) return true; // fresh receipt pending
    return exec.resultDigest !== exec.resultAppliedDigest && !!exec.result; // application pending
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
      updateRunRuntimeState(db, runId, { integrationStalled: true });
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
    const allSettled = tasks.every((t) => SETTLED_TASK.has(t.status));

    let status: RunStatus;
    const run = getRun(db, runId)!;
    if (allSettled && anyFailed) status = 'failed';
    else if (allSettled) status = 'integrating'; // final verification pending
    else if (anyFailed) status = 'failed';
    else if (run.integrationStalled) status = 'needs_attention';
    // a persisted run error (refused revision, failed apply) or a pending
    // (refused) revision demands human attention and must not be
    // aggregate-washed back to 'running'
    else if (anyContract || anyBlocked || blockedExecs || !!run.error || run.revisionPending) status = 'needs_attention';
    else if (tasks.some((t) => t.status === 'integrated')) status = 'integrating';
    else status = 'running';

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
