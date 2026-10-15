// Runner engine: the single writer that schedules tasks, consumes role
// results, enforces gates and maintains the run aggregate. One tick makes
// exactly one bounded pass; runUntilTerminal loops ticks until the run is
// terminal or the abort signal fires.

import type { SqliteDb } from '../store/db.ts';
import { inTransaction } from '../store/db.ts';
import { getRun, updateRunStatus, updateRunRuntimeState, getContractRevisionAt, clearRevisionPending, markRevisionAccepted } from '../store/runs.ts';
import { getTask, insertTask, listTasks, updateTask } from '../store/tasks.ts';
import { latestExecutionFor, listActiveExecutions, listExecutions, updateExecution } from '../store/executions.ts';
import type { ExecutionRecord, PendingDispatch } from '../core/types.ts';
import { addEvent } from '../store/events.ts';
import { insertResource, markResourceState, listActiveResources, listResources } from '../store/resources.ts';
import { heartbeat, acquireLease, releaseLease, leaseHolder } from '../store/lease.ts';
import { nowIso } from '../store/ids.ts';
import { insertVerification } from '../store/verifications.ts';
import { readResultFile } from '../results/files.ts';
import { validateRoleResult } from '../results/validate.ts';
import type { WorkerResult, ReviewerResult, IntegrationResult } from '../results/types.ts';
import { stageAll, cherryPick, currentHead, revParse, squashSince, worktreeChangedFiles } from '../core/git.ts';
import { AteamError, LeaseLostError, type ExitCode } from '../core/errors.ts';
import type { HerdrEventStream, WorkspaceHandle } from '../herdr/types.ts';
import { SETTLED_TASK } from '../core/types.ts';
import type { RunRecord, RunStatus, TaskRecord } from '../core/types.ts';
import type { HerdrAgentState } from '../core/types.ts';
import { resolveAgentEntry } from '../config.ts';
import { existsSync } from 'node:fs';
import type { RunnerEnv, StartExecutionInput } from './executions.ts';
import { startExecution, resolveReviewerEntry, closePaneSafe, rebuildRolePrompt, findSourceWorkspaceId } from './executions.ts';
import { agentStartArgs } from '../herdr/agent-args.ts';
import { verifyTaskWork, type GateLedger } from './phases/verify.ts';
import { commitVerifiedTree } from './phases/commit.ts';
import { commitIntegrationResolution } from './phases/integrate.ts';
import { concludeFinalGate } from './phases/final-gate.ts';
import { cleanupGateWorktrees, cleanupIntegrationWorkspace, cleanupTaskResources, finalPassMatchesDelivery } from './cleanup.ts';
import { topologicalTasks, validateGraph } from '../core/contract.ts';

const TERMINAL_RUN: ReadonlySet<string> = new Set(['done', 'cancelled', 'abandoned', 'failed']);

/** R4-04: a dependency is satisfied only when its delivery is IN the
 * integration base. `failed`/`discarded` upstreams settle the run but never
 * unblock downstream work — scheduling them would run agents on a tree
 * missing the deliveries they build on. */
const DEP_SATISFIED: ReadonlySet<string> = new Set(['integrated', 'reclaimed']);
const DEP_DOOMED: ReadonlySet<string> = new Set(['failed', 'discarded']);

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
  /** R4-05: a fencing token acquired OUTSIDE the engine (the reconcile CLI
   * holds the lease across the whole pass). Without it ensureLease() is a
   * no-op and long control-plane operations run unguarded. */
  leaseFence?: string | null;
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
    this.leaseFence = opts.leaseFence ?? null;
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
   * another writer took over — this runner must not write delivery state.
   * R5-04: the error is a LeaseLostError so audit paths can distinguish it
   * and record nothing on behalf of a dispossessed writer. */
  private ensureLease(): void {
    if (!this.leaseFence) return;
    if (!heartbeat(this.env.db, this.env.runId, this.leaseFence)) {
      throw new LeaseLostError();
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
   *
   * Review 03 (R3-02/R3-03): only a fully applied revision is promoted to
   * the run's ACCEPTED revision — the contract every process (fresh Runner,
   * clean, reconcile) builds its env from. Rejections leave the previously
   * accepted revision authoritative; the refused candidate stays a mere
   * submitted pointer that no one reads as the contract.
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
      // R3-02/R3-03: the applied revision becomes the ACCEPTED one in the
      // SAME transaction — a crash between applying and promoting can never
      // leave a fresh process reading the old contract over applied tasks
      markRevisionAccepted(db, runId, run.contractRevision);
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
    let restartedFresh = false;
    if (!observed) {
      try {
        const entry = resolveAgentEntry(this.env.config, task.spec.agent, exec.role);
        await client.startAgent({
          name: exec.agentName,
          kind: exec.agentKind,
          paneId: exec.paneId,
          args: agentStartArgs(entry),
          readyTimeoutMs: 120_000, // same operator window as startExecution
        });
        restartedFresh = true;
      } catch (err) {
        await abandon(`dispatch_interrupted_agent_gone: ${String(err)}`);
        return;
      }
    } else if (observed.state === 'blocked') {
      // native UI still open (trust dialog, approval) — the operator is on
      // it; wait silently and re-check on the next tick. If the start had
      // FAILED, the prompt was never sent, so there is nothing to un-deliver.
      if (!exec.startFailed) {
        updateRunStatus(db, runId, 'needs_attention',
          `execution ${exec.id}: agent ${exec.agentName} is blocked in native UI during dispatch resume — resolve it in pane ${exec.paneId}`);
      }
      return;
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
    // R3-01: a persisted result file IS delivery evidence — the original
    // prompt demonstrably landed (only this execution writes that path).
    // Mark the dispatch delivered and let the result gate apply it; the
    // agent is never re-prompted.
    if (exec.resultPath && await readResultFile(exec.resultPath)) {
      updateExecution(db, exec.id, { promptSentAt: nowIso(), status: 'running' });
      addEvent(db, runId, 'EXECUTION_PROMPTED', {
        taskId: exec.taskId,
        executionId: exec.id,
        payload: { role: exec.role, attemptNo: exec.attemptNo, cycleNo: exec.cycleNo, agentName: exec.agentName, resumed: true, evidence: 'persisted_result' },
      });
      return;
    }
    // R3-01/R2-10: re-prompting a LIVE agent cannot distinguish "never
    // delivered" from "delivered, receipt lost" unless the runtime dedupes
    // by requestId (the persisted prompt digest). With a dedupe-capable
    // runtime the re-send is a no-op when the first injection landed; on a
    // transport without that guarantee the uncertain delivery escalates for
    // manual confirmation instead of gambling a double execution. The one
    // exception is a recorded start failure: the start never completed, so
    // the prompt was never even attempted and re-dispatching is certain-safe.
    if (!restartedFresh && !exec.startFailed && !client.supportsPromptDedup()) {
      updateRunStatus(db, runId, 'needs_attention',
        `execution ${exec.id}: prompt delivery is uncertain and the runtime has no request-id dedupe — attach pane ${exec.paneId} (agent ${exec.agentName}) and resolve manually`);
      addEvent(db, runId, 'RECONCILE_DECISION', {
        executionId: exec.id,
        payload: { reason: 'prompt_resume_uncertain_no_dedupe', agentName: exec.agentName, paneId: exec.paneId },
      });
      return;
    }
    if (exec.startFailed) updateExecution(db, exec.id, { startFailed: false });
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

  /**
   * R4-01: has the task worktree drifted from the VERIFIED commit? The
   * reviewer's approval and the integration cherry-pick both bind to the
   * commit the mechanical gate verified (task.commitSha): a later commit,
   * staged edits or untracked delivery files after it were never validated
   * against the task's path policy. A drifted worktree must go back through
   * the worker verification gate, never straight into integration. A missing
   * worktree is NOT drift — pane-loss recovery owns that case.
   */
  private async deliveryDriftedSinceVerification(task: TaskRecord): Promise<boolean> {
    if (!task.worktreePath || !task.commitSha) return false;
    if (!existsSync(task.worktreePath)) return false;
    const head = await currentHead(task.worktreePath).catch(() => null);
    if (head !== task.commitSha) return true;
    const files = await worktreeChangedFiles(task.worktreePath, task.commitSha);
    return files.length > 0;
  }

  /** R4-01 shared handling: route a drifted delivery back into the worker
   * verify → review cycle instead of letting it reach integration. */
  private async redeliverDriftedWork(task: TaskRecord, review: unknown, from: string): Promise<void> {
    const { db, runId } = this.env;
    const current = getTask(db, runId, task.taskId)!;
    updateTask(db, runId, task.taskId, {
      status: 'changes_requested',
      pendingDispatch: 'worker_retry',
      lastError: `worktree changed after the verified commit (${current.commitSha}); re-verification required`,
    });
    addEvent(db, runId, 'RECONCILE_DECISION', {
      taskId: task.taskId,
      payload: { reason: 'worktree_drifted_after_verification', from, commitSha: current.commitSha },
    });
    await this.retryWorker(getTask(db, runId, task.taskId)!, { lastReview: review });
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

  /** R7-06: ledger callbacks for the verification gate's disposable
   * checkout — a crash mid-gate leaves a reclaimable row, never unregistered
   * litter; a failed cleanup keeps the row active for the reclaim sweep. */
  private gateLedger(taskId: string): GateLedger {
    const { db, runId } = this.env;
    return {
      register: (path) => {
        insertResource(db, { runId, taskId, kind: 'gate-worktree', herdrId: path, path });
      },
      release: (path, removed) => {
        if (removed) {
          markResourceState(db, runId, 'gate-worktree', path, 'reclaimed');
          return;
        }
        addEvent(db, runId, 'RECONCILE_DECISION', {
          taskId,
          payload: { reason: 'gate_worktree_cleanup_failed', path, reclaimable: true },
        });
      },
    };
  }

  private async verifyAndHandToReview(exec: ExecutionRecord, task: TaskRecord): Promise<void> {
    const { db, runId, client, config, home } = this.env;
    const current = getTask(db, runId, task.taskId)!;
    // idempotent replay (review 01 #1): a previous process may have crashed
    // after persisting the transition — never redo verification/commit/review
    // once the task has advanced past this result
    if (['reviewing', 'approved', 'integrated', 'reclaimed', 'discarded', 'changes_requested'].includes(current.status)) return;
    updateTask(db, runId, task.taskId, { status: 'verifying' });
    // R5-01: stage BEFORE the gate — the gate measures index-vs-base and
    // pins the index tree, so the verification object is exactly the content
    // the commit below will carry. Edits a worker keeps making after its
    // result file landed stay unstaged and are caught by the post-commit
    // drift checks (deliveryDriftedSinceVerification), not silently committed.
    await stageAll(current.worktreePath!);
    const outcome = await verifyTaskWork({
      worktreePath: current.worktreePath!,
      task: current,
      allowlist: config.verificationAllowlist,
      baseSha: current.startSha ?? 'HEAD',
      staged: true,
      gateLedger: this.gateLedger(task.taskId),
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
        contractRevision: getRun(db, runId)?.acceptedRevision,
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

    // R5-01: commit and prove the commit carries the verified tree — content
    // staged into the index after the gate ran must not ride the delivery
    const sha = await commitVerifiedTree(
      current.worktreePath!,
      outcome.treeSha,
      `ateam(${runId}): task ${task.taskId} attempt ${exec.attemptNo}`,
    );
    if (sha === null) {
      // the committed content is NOT what the gate verified — refuse the
      // delivery and route the task back through the worker gate
      updateExecution(db, exec.id, { status: 'completed', paneState: 'retained' });
      addEvent(db, runId, 'RECONCILE_DECISION', {
        taskId: task.taskId,
        payload: { reason: 'commit_tree_mismatch_after_verification', expectedTree: outcome.treeSha },
      });
      await this.retryWorker(getTask(db, runId, task.taskId)!, {});
      return;
    }
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
      // R4-01: pin the commit under review — the reviewer is read-only and
      // the engine enforces it, but the brief states the exact SHA the
      // verdict binds to
      notes: task.commitSha
        ? `Review the verified delivery at commit ${task.commitSha} (the task worktree HEAD). The verdict binds to this SHA; the runner re-checks it on approval.`
        : undefined,
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

  /**
   * R7-03: finish an operator-persisted discard (`clean --discard-work`).
   * The intent lives on the task row; active executions on the task are
   * settled first (R6-05 order) and the step-wise, retryable sweep then
   * destroys the resources. Returns true when the task settled — the sweep's
   * own finalize step cleared the intent; a null outcome keeps it for the
   * next pass (audited per step, never re-dispatches an agent).
   */
  private async resumeDiscardIntent(task: TaskRecord): Promise<boolean> {
    const { db, runId } = this.env;
    this.ensureLease();
    for (const exec of listActiveExecutions(db, runId)) {
      if (exec.taskId !== task.taskId) continue;
      updateExecution(db, exec.id, { status: 'abandoned' });
      addEvent(db, runId, 'RECONCILE_DECISION', {
        executionId: exec.id,
        taskId: exec.taskId,
        payload: { reason: 'execution_abandoned_for_discard', source: 'discard_resume' },
      });
    }
    const current = getTask(db, runId, task.taskId);
    if (!current) return true;
    const outcome = await cleanupTaskResources(this.env, current, {
      discardUnverified: true,
      ensureLease: () => this.ensureLease(),
    });
    return outcome !== null;
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
      // R7-03: a persisted discard is settled by destruction, never by a
      // dispatch — replay it (retryable) instead of mapping it to a role
      if (intent === 'discard') {
        const current = getTask(db, runId, task.taskId);
        if (!current) continue;
        addEvent(db, runId, 'RECONCILE_DECISION', {
          taskId: task.taskId,
          payload: { reason: 'pending_dispatch_resumed', intent },
        });
        await this.resumeDiscardIntent(current);
        continue;
      }
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
      // R4-01: approval binds to the VERIFIED commit. Content appearing in
      // the task worktree after the gate ran (a reviewer-side commit, a
      // same-worktree process, leftover edits) is unverified — it re-enters
      // the worker verification + review cycle instead of being approved.
      if (await this.deliveryDriftedSinceVerification(task)) {
        updateTask(db, runId, task.taskId, { status: 'changes_requested' });
        updateExecution(db, exec.id, { status: 'completed', paneState: 'closed_success' });
        await closePaneSafe(client, exec.paneId);
        await this.redeliverDriftedWork(task, result, 'reviewer_approval');
        return;
      }
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
      // R7-01: the integrator's resolution goes through the same delivery
      // boundary as the worker gate — a pre-staged `.ateam` file or content
      // no task's path policy allows refuses the commit instead of riding
      // the integration branch unjudged
      const gate = await commitIntegrationResolution({
        worktreePath,
        baseSha: run.integrationBaseSha,
        message: `ateam(${runId}): integrate task ${task.taskId} (conflicts resolved)`,
        scopes: listTasks(db, runId).map((t) => t.spec),
      });
      if (!gate.ok) {
        addEvent(db, runId, 'RECONCILE_DECISION', {
          executionId: exec.id,
          taskId: task.taskId,
          payload: { reason: 'integration_commit_refused', violations: gate.violations },
        });
        updateRunRuntimeState(db, runId, { integrationStalled: true });
        const detail = gate.violations.join('; ');
        updateTask(db, runId, task.taskId, { lastError: `integration commit refused: ${detail}` });
        updateRunStatus(db, runId, 'needs_attention', `integration commit refused: ${detail}`);
        updateExecution(db, exec.id, { status: 'completed', paneState: 'retained' });
        return;
      }
      const sha = gate.sha!;
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

    for (const task of tasks) {
      if (slots <= 0) return;
      if (task.status !== 'pending') continue;
      // R4-04: only integrated/reclaimed dependencies unblock a task; a
      // doomed upstream (failed/discarded) marks WHY the task can never run
      const deps = task.spec.dependsOn ?? [];
      const blocker = deps.find((dep) => DEP_DOOMED.has(statusById.get(dep) ?? ''))
        ?? deps.find((dep) => !DEP_SATISFIED.has(statusById.get(dep) ?? ''));
      if (blocker !== undefined) {
        const depStatus = statusById.get(blocker) ?? 'unknown';
        if (DEP_DOOMED.has(depStatus) && task.lastError !== `dependency ${blocker} ${depStatus} — this task can never run`) {
          updateTask(db, runId, task.taskId, { lastError: `dependency ${blocker} ${depStatus} — this task can never run` });
        }
        continue;
      }
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
    // R3-04: reclamation proceeds only while the persisted final PASS still
    // describes the CURRENT delivery (accepted revision, integration HEAD,
    // task commit set). A stale conclusion falls through to re-verification
    // below instead of gating resource destruction on it.
    if (run.finalVerified && await finalPassMatchesDelivery(this.env)) {
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
      // R3-06: cherry-picks mutate the shared integration tree — the fence
      // must be current before each one
      this.ensureLease();
      await this.integrateTask(task);
    }
  }

  /** Reclaim integrated tasks step by step; done once everything is settled. */
  private async runCleanupPhase(run: RunRecord): Promise<void> {
    const { db, runId } = this.env;
    // R7-06: gate worktrees a crash left registered are reclaimed alongside
    // the run's other temp resources
    this.ensureLease();
    await cleanupGateWorktrees(this.env);
    const tasks = listTasks(db, runId);
    for (const task of tasks.filter((t) => t.status === 'integrated')) {
      // R3-06: reclamation is irreversible — renew/verify the fencing token
      // before each task's teardown, never batch it across the whole loop
      this.ensureLease();
      await cleanupTaskResources(this.env, task, {
        // R4-05: and between the individual teardown steps as well
        ensureLease: () => this.ensureLease(),
      });
    }
    // run-level temp resource: the integration worktree itself (R7-04: the
    // same shared step `clean` runs, so both paths reclaim identically)
    if (run.integrationWorkspaceId && listTasks(db, runId).every((t) => SETTLED_TASK.has(t.status))) {
      await cleanupIntegrationWorkspace(this.env, { ensureLease: () => this.ensureLease() });
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
    // already-integrated commits by silently rebuilding elsewhere.
    // herdr 0.9.x: open/create must start from the repo PARENT workspace,
    // so the branch-based fallbacks resolve the parent, not a task workspace.
    let parentWorkspaceId: string | null = null;
    try {
      parentWorkspaceId = await findSourceWorkspaceId(this.env);
    } catch {
      parentWorkspaceId = null;
    }
    let handle: WorkspaceHandle | null = null;
    if (run.integrationWorkspaceId) {
      handle = await client
        .openWorktree({ sourceWorkspaceId: run.integrationWorkspaceId })
        .catch(() => null);
    }
    if (!handle && parentWorkspaceId) {
      handle = await client
        .openWorktree({ sourceWorkspaceId: parentWorkspaceId, branch })
        .catch(() => null);
    }
    if (!handle && parentWorkspaceId) {
      handle = await client
        .createWorktreeWorkspace({
          sourceWorkspaceId: parentWorkspaceId,
          branch,
          label: `${runId}/integration`,
          focus: false,
        })
        .catch(() => null);
    }
    if (!handle && !parentWorkspaceId) {
      // legacy fallback: task-workspace-sourced creation (fakes / older runtimes)
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
    // R4-01: the squashed chain must END at the approved, verified commit —
    // squashSince(startSha..HEAD) would otherwise carry post-approval,
    // never-verified commits into the delivery
    if (await this.deliveryDriftedSinceVerification(current)) {
      await this.redeliverDriftedWork(current, current.review, 'integration');
      return;
    }
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
      // R5-03: the final gate verifies the COMMITTED delivery — a dirty
      // integration tree would make the PASS describe content no commit
      // carries, so the tree must be clean before and after the commands
      requireClean: true,
      // R7-01: the committed delivery is judged against the contract's full
      // path ownership — committed internal or out-of-scope content fails
      scopePolicies: tasks.map((t) => t.spec),
      logDir: `${home.runsDir}/${runId}/logs`,
    });
    // R2-06: renew the lease (token CAS) before the delivery conclusion; a
    // dispossessed runner must not mark the run final-verified
    this.ensureLease();
    // R2-14 + R3-04 + R7-05: the final conclusion is persisted as a
    // queryable record bound to the contract revision, the HEAD THE GATE
    // VERIFIED (never a later read) and the exact task/commit set it
    // covered — this record (not just the run flag) is what cleanup
    // eligibility reads, and cleanup re-checks the bindings before
    // destroying anything
    const integratedCommits: Record<string, string> = {};
    for (const t of tasks) {
      if (['integrated', 'reclaimed'].includes(t.status) && t.integrationCommit) {
        integratedCommits[t.taskId] = t.integrationCommit;
      }
    }
    const conclusion = await concludeFinalGate({ worktreePath: path, outcome, integratedCommits });
    insertVerification(db, {
      runId,
      kind: 'final',
      ok: conclusion.ok,
      detail: {
        phase: 'integration_final',
        // the ACCEPTED revision, never run.contractRevision: a pending
        // candidate that was refused must not become a gate's provenance
        contractRevision: run.acceptedRevision,
        headSha: conclusion.headSha,
        baseSha: run.integrationBaseSha ?? null,
        integratedCommits,
        violations: conclusion.violations,
        diffFiles: outcome.diffFiles,
        commands: outcome.commands.map((c) => ({ command: c.command, ok: c.ok, exitCode: c.exitCode })),
      },
      logPath: outcome.logPath,
    });
    addEvent(db, runId, conclusion.ok ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED', {
      payload: { phase: 'integration_final', violations: conclusion.violations, logPath: outcome.logPath },
    });
    if (conclusion.ok) {
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
    // R4-03: resources (re-)registered during this pass carry a fresh ledger
    // generation — the pre-pass snapshot cannot judge them yet
    const passStartedAt = nowIso();

    const run = getRun(db, runId);
    if (!run || TERMINAL_RUN.has(run.status)) return decisions;

    if (run.revisionPending) {
      decisions.push({ kind: 'revision_consumed', detail: `revision ${run.contractRevision}` });
      // R4-05: revision application is a delivery write — renew the fence first
      await apply(async () => {
        this.ensureLease();
        await this.consumeContractRevision();
      });
    }

    // ADR recovery order (R2-07): establish the event subscription AND wait
    // for its confirmation BEFORE reading the snapshot, so the observe gap
    // is bridged by buffered events instead of being silently missed. A
    // subscription that cannot be confirmed means the required order cannot
    // be guaranteed — report it and defer every judgment (no snapshot-only
    // degradation). herdr 0.9.x admits only pane-scoped subscriptions, so the
    // subscription tracks exactly the ledger's live panes; with none in
    // flight there is no pane judgment pending and the pass may proceed.
    const trackedPanes = new Set<string>();
    for (const exec of listActiveExecutions(db, runId)) {
      if (exec.paneId) trackedPanes.add(exec.paneId);
    }
    if (run.integrationRootPaneId) trackedPanes.add(run.integrationRootPaneId);
    let stream: HerdrEventStream | null = null;
    if (trackedPanes.size > 0) {
      try {
        stream = await client.subscribe({ paneIds: [...trackedPanes] });
      } catch (err) {
        decisions.push({
          kind: 'subscription_unavailable',
          detail: `event subscription failed (${String(err)}); recovery judgments deferred`,
        });
        return decisions;
      }
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
        // R2-07 + R3-05: merge events buffered between the subscription ACK
        // and the snapshot IN ARRIVAL ORDER — a removal event for a resource
        // the snapshot showed must remove it from the alive/observed sets,
        // and an event arriving after the removal may re-add it. Ignoring
        // deletions would keep judging closed panes as recoverable.
        const alivePanes = new Set(snap.panes.map((p) => p.paneId));
        const observedIds = new Set<string>([
          ...snap.workspaces.map((w) => w.workspaceId),
          ...snap.panes.map((p) => p.paneId),
        ]);
        for (const ev of stream?.drainPending?.() ?? []) {
          if (ev.type === 'pane.closed' || ev.type === 'pane.exited') {
            if (ev.paneId) {
              alivePanes.delete(ev.paneId);
              observedIds.delete(ev.paneId);
            }
            continue;
          }
          if (ev.type === 'worktree.removed') {
            if (ev.workspaceId) observedIds.delete(ev.workspaceId);
            continue;
          }
          if (ev.paneId) {
            alivePanes.add(ev.paneId);
            observedIds.add(ev.paneId);
          }
          if (ev.workspaceId) observedIds.add(ev.workspaceId);
        }
        const tasks = listTasks(db, runId);
        // only resources that existed before this pass may be swept as lost/orphaned
        const preExistingResources = new Set(listActiveResources(db, runId).map((r) => `${r.kind}:${r.herdrId}`));

        for (const exec of listActiveExecutions(db, runId)) {
          const task = tasks.find((t) => t.taskId === exec.taskId);
          // R6-05: a settled task (integrated/reclaimed/discarded/failed)
          // owns no further delivery work — an execution still active on one
          // (its workspace may already be reclaimed, or the task was
          // discarded by `clean --discard-work`) must never be recovered
          // into a fresh worktree/attempt
          if (task && SETTLED_TASK.has(task.status)) {
            decisions.push({
              kind: 'pane_lost_no_attempt',
              taskId: exec.taskId,
              executionId: exec.id,
              detail: `execution still active on a ${task.status} task; recovery refused`,
            });
            if (!opts.dryRun) {
              // settle the stray ledger row too — an execution left active on
              // a settled task would block run finalization forever
              this.ensureLease(); // R4-05: the write is fenced
              updateExecution(db, exec.id, { status: 'abandoned' });
              addEvent(db, runId, 'RECONCILE_DECISION', {
                executionId: exec.id,
                payload: { reason: 'execution_on_settled_task', taskStatus: task.status },
              });
            }
            continue;
          }
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
              // R4-05: applying a persisted result advances delivery state
              this.ensureLease();
              const recovered = await this.recoverPersistedResult(exec, task);
              if (recovered) {
                decisions.push({ kind: 'result_recovered', taskId: exec.taskId, executionId: exec.id, detail: 'persisted result applied' });
                continue;
              }
            }
          }
          // 2) pane 仍然存活：区分「agent 也在」与「herdr 重启后恢复的空 pane」。
          //    agent 确定不在（getAgent → null）等同 pane 丢失——tick 语义一致，
          //    走新 attempt；agent 状态不可观测（非 not_found 错误）则保守延迟。
          if (exec.paneId && alivePanes.has(exec.paneId)) {
            const agent = await client.getAgent(exec.agentName).catch((err) => err);
            if (agent === null) {
              decisions.push({
                kind: exec.promptSentAt ? 'pane_lost_new_attempt' : 'pane_lost_no_attempt',
                taskId: exec.taskId,
                executionId: exec.id,
                detail: `pane ${exec.paneId} alive but agent ${exec.agentName} is gone`,
              });
              if (opts.dryRun || !task) continue;
              // R4-05: abandonment + a rebuilt worktree + a fresh attempt are
              // writes and new resources — the fence must still be ours
              this.ensureLease();
              updateExecution(db, exec.id, { status: 'abandoned', paneState: 'gone' });
              addEvent(db, runId, 'RECONCILE_DECISION', {
                executionId: exec.id,
                payload: { reason: 'pane_lost', promptSent: !!exec.promptSentAt, agentGone: true },
              });
              await this.recoverExecutionOnFreshWorktree(exec, task, decisions);
              continue;
            }
            if (agent instanceof Error) {
              decisions.push({
                kind: 'snapshot_unavailable',
                taskId: exec.taskId,
                executionId: exec.id,
                detail: `agent ${exec.agentName} state unobservable (${String(agent)}); judgment deferred`,
              });
              continue;
            }
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
          this.ensureLease(); // R4-05: same write cluster as the pane-gone path above
          updateExecution(db, exec.id, { status: 'abandoned', paneState: 'gone' });
          addEvent(db, runId, 'RECONCILE_DECISION', {
            executionId: exec.id,
            payload: { reason: 'pane_lost', promptSent: !!exec.promptSentAt },
          });
          await this.recoverExecutionOnFreshWorktree(exec, task, decisions);
        }

      // cleanup eligibility (review 01 #2 + R2-03/R2-14 + R3-04): only while
      // a persisted PASSING final record still describes the CURRENT
      // delivery; reconciling an unverified (or stale-verified) run reports
      // the deferral instead of destroying worktrees the final gate needs
      if (run.finalVerified && await finalPassMatchesDelivery(this.env)) {
        for (const task of listTasks(db, runId).filter((t) => t.status === 'integrated')) {
          decisions.push({ kind: 'cleanup_resumed', taskId: task.taskId });
          await apply(async () => {
            await cleanupTaskResources(this.env, task, {
              // R4-05: the fence is renewed per cleanup step inside, and
              // checked once more before the task's first step
              ensureLease: () => this.ensureLease(),
            });
          });
        }
      } else if (listTasks(db, runId).some((t) => t.status === 'integrated')) {
        decisions.push({
          kind: 'cleanup_deferred',
          detail: 'integrated tasks kept until a passing final verification is persisted',
        });
      }

      // R7-03: an operator-persisted discard intent is settled by the Runner
      // OR by reconcile — retried pass after pass until the resources are
      // actually disposed (the sweep's finalize step clears the intent)
      for (const task of listTasks(db, runId).filter((t) => t.pendingDispatch === 'discard')) {
        decisions.push({
          kind: 'cleanup_resumed',
          taskId: task.taskId,
          detail: opts.dryRun ? 'dry-run: discard intent would be swept' : 'discard intent resumed',
        });
        await apply(async () => {
          await this.resumeDiscardIntent(task);
        });
      }

      for (const res of listActiveResources(db, runId)) {
        // R7-06: gate worktrees are not herdr resources — the snapshot can
        // never show them; the dedicated sweep below reclaims their rows
        if (res.kind === 'gate-worktree') continue;
        if (!preExistingResources.has(`${res.kind}:${res.herdrId}`)) continue;
        if (res.createdAt >= passStartedAt) continue; // re-registered this pass (id reuse) — judged next pass
        if (observedIds.has(res.herdrId)) continue;
        decisions.push({
          kind: res.provenance ? 'resource_lost' : 'resource_orphaned',
          taskId: res.taskId ?? undefined,
          detail: `${res.kind}:${res.herdrId}`,
        });
        // R4-05: state writes are fenced too
        await apply(() => {
          this.ensureLease();
          return markResourceState(db, runId, res.kind, res.herdrId, res.provenance ? 'lost' : 'orphaned');
        });
      }

      // R5-02 companion: the deletion gate requires an ACTIVE provenanced
      // ledger row, so a resource this run previously judged lost/orphaned
      // that the authoritative snapshot shows alive again is re-activated —
      // without this, strict identity gating could never reclaim a
      // reappeared resource and the run would stall at integrating forever
      for (const res of listResources(db, runId)) {
        // no passStartedAt guard here: insertResource always writes 'active',
        // so a non-active row necessarily predates this pass
        if (res.kind === 'gate-worktree') continue; // R7-06: not a herdr identity
        if (res.state === 'active' || !observedIds.has(res.herdrId)) continue;
        await apply(() => {
          this.ensureLease();
          markResourceState(db, runId, res.kind, res.herdrId, 'active');
          addEvent(db, runId, 'RECONCILE_DECISION', {
            payload: { reason: 'resource_reactivated', kind: res.kind, herdrId: res.herdrId },
          });
        });
      }

      // R7-06: gate worktrees registered by a crashed verification are
      // reclaimed by the sweep — never judged by the herdr snapshot loops above
      if (listActiveResources(db, runId).some((r) => r.kind === 'gate-worktree')) {
        decisions.push({
          kind: 'cleanup_resumed',
          detail: opts.dryRun ? 'dry-run: gate worktree sweep would run' : 'gate worktree sweep',
        });
        await apply(async () => {
          await cleanupGateWorktrees(this.env);
        });
      }

      return decisions;
    } finally {
      stream?.close();
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
    // R6-05 (defense in depth): never rebuild for a task that already
    // settled — the reconcile loop guards this, but a settled check at the
    // write site is what survives future callers
    if (SETTLED_TASK.has(task.status)) {
      decisions.push({
        kind: 'pane_lost_no_attempt',
        taskId: task.taskId,
        detail: `worktree rebuild refused for a ${task.status} task`,
      });
      return;
    }
    // herdr 0.9.x: rebuilds must start from the repo PARENT workspace
    let source = task.workspaceId ?? '';
    try {
      source = await findSourceWorkspaceId(this.env);
    } catch {
      /* keep the ledgered task workspace as the fallback source */
    }
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
      // R5-03: a transition must not launder away a persisted run error —
      // e.g. the aggregate may move needs_attention → integrating while a
      // failed final verification still demands attention
      updateRunStatus(db, runId, status, run.error ?? undefined);
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
