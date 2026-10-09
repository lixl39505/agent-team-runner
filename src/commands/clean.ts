// agent-team clean — finish a run: reclaim any "integrated but not yet
// reclaimed" resources (audit-driven, retryable), then mark the run
// abandoned. Holds the runner lease while operating, so it never races a
// live Runner; safe to run repeatedly.
//
// Review 02 R2-03: reclamation REQUIRES a persisted passing final
// verification — `clean` no longer bypasses it. Unverified integrated tasks
// are reported and left in place; destroying them anyway is a separate,
// explicit, audited override (`--discard-work`) that settles them as
// `discarded`, never `reclaimed`.

import { openDatabase } from '../store/db.ts';
import { loadHome } from '../config.ts';
import { getRun, updateRunStatus } from '../store/runs.ts';
import { listTasks } from '../store/tasks.ts';
import { listActiveExecutions, updateExecution } from '../store/executions.ts';
import { addEvent } from '../store/events.ts';
import { SETTLED_TASK } from '../core/types.ts';
import { AteamError, LeaseLostError } from '../core/errors.ts';
import { buildRunnerEnv, createClient, getRunOrThrow } from './run-shared.ts';
import { cleanupTaskResources } from '../runner/cleanup.ts';
import { acquireLease, heartbeat, releaseLease } from '../store/lease.ts';
import type { HerdrRuntimeClient } from '../herdr/client.ts';

export interface CleanCommandOptions {
  runId: string;
  home?: string;
  json: boolean;
  herdrPath?: string;
  /** Test seam: inject a fake runtime client. */
  client?: HerdrRuntimeClient;
  /** Audited destruction of UNVERIFIED delivery resources (R2-03). */
  discardWork?: boolean;
}

export async function cmdClean(opts: CleanCommandOptions): Promise<number> {
  const home = await loadHome(opts.home);
  const db = openDatabase(home.dbPath);
  try {
    const run = getRunOrThrow(db, opts.runId);
    // single-writer discipline (review 01 #2): clean operates only while
    // holding the runner lease — a live Runner is an explicit refusal, not
    // a silent concurrent reclamation
    const fence = acquireLease(db, run.id);
    if (!fence) {
      throw new AteamError(`run ${run.id} has a live runner lease; stop the runner before clean`, {
        exitCode: 1,
        remediation: 'use `agent-team status` to find the active runner and wait for it to exit',
      });
    }
    try {
      const client = opts.client ?? createClient(opts.herdrPath);
      const env = buildRunnerEnv(home, db, client, run);
      const tasks = listTasks(db, run.id);

      let reclaimed = 0;
      let discarded = 0;
      // R5-04: the fence errors are LeaseLostError so the cleanup audit path
      // can tell "the operation failed" from "we no longer own this run" and
      // record nothing in the latter case
      const leaseLost = (): LeaseLostError =>
        new LeaseLostError(`runner lease for ${run.id} was lost mid-clean — another writer took over; aborting before further destruction`);
      // R5-05: integrated tasks always sweep; an explicit --discard-work also
      // sweeps every not-yet-settled task that may still hold resources
      // (running/reviewing/blocked worktrees and branches), settling them as
      // audited discards
      const sweepable = tasks.filter((t) =>
        t.status === 'integrated'
        || (opts.discardWork === true && !['reclaimed', 'discarded'].includes(t.status)));
      // R6-05: an explicit discard must settle the control state BEFORE any
      // destruction. An execution left active on a to-be-discarded task would
      // see its workspace force-removed under it and then — with the run
      // still "resumable" — be recovered by the next reconcile into a fresh
      // worktree/attempt for a task that no longer owns delivery work.
      // Abandoning the ledger row first (the sweep's workspace removal then
      // retires the pane as `gone`, audited) keeps destruction and the discard
      // conclusion one forward-moving transition: after the sweep nothing is
      // active, nothing recoverable, and the run can actually terminate.
      if (opts.discardWork === true) {
        const discardable = new Set(
          tasks.filter((t) => !SETTLED_TASK.has(t.status)).map((t) => t.taskId),
        );
        // the abandon writes are delivery-state changes — fenced like the sweep
        if (!heartbeat(db, run.id, fence)) throw leaseLost();
        for (const exec of listActiveExecutions(db, run.id)) {
          if (!discardable.has(exec.taskId)) continue;
          updateExecution(db, exec.id, { status: 'abandoned' });
          addEvent(db, run.id, 'RECONCILE_DECISION', {
            executionId: exec.id,
            taskId: exec.taskId,
            payload: { reason: 'execution_abandoned_for_discard', source: 'clean' },
          });
        }
      }
      for (const task of sweepable) {
        // R3-06: reclamation is irreversible — the token-CAS heartbeat both
        // renews the lease and aborts the sweep the moment another writer
        // took over mid-run
        if (!heartbeat(db, run.id, fence)) throw leaseLost();
        const outcome = await cleanupTaskResources(env, task, {
          discardUnverified: opts.discardWork,
          // R4-05/R5-04: the fence is renewed between the individual teardown
          // steps and re-checked after each operation before any audit write —
          // a single slow reclamation must not outlive its lease
          ensureLease: () => {
            if (!heartbeat(db, run.id, fence)) throw leaseLost();
          },
        });
        if (outcome === 'reclaimed') reclaimed += 1;
        if (outcome === 'discarded') discarded += 1;
      }

      const stillIntegrated = listTasks(db, run.id).filter((t) => t.status === 'integrated').length;
      // R4-07: live executions mean agents may still be writing results —
      // terminating the run here would strand their panes/worktrees without
      // any coordinator. clean refuses to finalize while any execution is
      // active, whatever the integrated count says.
      const activeExecutions = listActiveExecutions(db, run.id);
      // R5-05: an execution-free window is NOT a settled run — a task still
      // reviewing/running/blocked (or carrying an unplayed dispatch intent)
      // has undelivered work and possibly un-reclaimed temp resources; the
      // default startup/reconcile path must stay able to finish it
      const remaining = listTasks(db, run.id);
      const unsettled = remaining.filter((t) => !SETTLED_TASK.has(t.status) || t.pendingDispatch !== null);
      // R3-08: with unverified work left behind (and no explicit discard),
      // the run stays RESUMABLE — terminating it here would hide it from the
      // default startup/reconcile path that re-runs the final gate and
      // finishes reclamation. Only a fully settled (or explicitly discarded)
      // run with no live executions is finalized.
      const terminate = stillIntegrated === 0 && activeExecutions.length === 0 && unsettled.length === 0;
      if (terminate && !['done', 'cancelled', 'abandoned', 'failed'].includes(run.status)) {
        updateRunStatus(db, run.id, 'abandoned');
        addEvent(db, run.id, 'RUN_STATUS_CHANGED', { payload: { to: 'abandoned', source: 'clean' } });
      }

      if (opts.json) {
        console.log(JSON.stringify({
          runId: run.id,
          reclaimed,
          discarded,
          stillIntegrated,
          activeExecutions: activeExecutions.length,
          unsettledTasks: unsettled.map((t) => ({ taskId: t.taskId, status: t.status, pendingDispatch: t.pendingDispatch })),
          status: getRun(db, run.id)?.status,
        }));
      } else {
        console.log(
          `clean ${run.id}: reclaimed ${reclaimed}, discarded ${discarded}, ${stillIntegrated} still pending, ${activeExecutions.length} active executions, ${unsettled.length} unsettled tasks, run=${getRun(db, run.id)?.status}`,
        );
        if (activeExecutions.length > 0) {
          console.log(
            `fix: ${activeExecutions.length} execution(s) are still active (${activeExecutions.map((e) => `${e.taskId}/${e.role}`).join(', ')}) — stop the runner or let them finish before terminating the run; the run was left resumable`,
          );
        }
        if (unsettled.length > 0) {
          console.log(
            `fix: ${unsettled.length} task(s) are not settled (${unsettled.map((t) => `${t.taskId}:${t.status}${t.pendingDispatch ? `+${t.pendingDispatch}` : ''}`).join(', ')}) — a run with in-flight delivery is not terminable; resume it (runner / \`agent-team reconcile\`) or re-run with --discard-work to abort the remaining work (audited, irreversible)`,
          );
        }
        if (stillIntegrated > 0 && !opts.discardWork) {
          console.log(
            'fix: these tasks have no current passing final verification, so they are not reclaimable and the run was left resumable — run the runner / `agent-team reconcile` to re-run the final verification, or re-run with --discard-work to destroy the unverified resources (audited, irreversible)',
          );
        }
      }
      return terminate ? 0 : 1;
    } finally {
      releaseLease(db, run.id, fence);
    }
  } finally {
    db.close();
  }
}
