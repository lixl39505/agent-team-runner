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
import { listActiveExecutions } from '../store/executions.ts';
import { addEvent } from '../store/events.ts';
import { AteamError } from '../core/errors.ts';
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
      for (const task of tasks.filter((t) => t.status === 'integrated')) {
        // R3-06: reclamation is irreversible — the token-CAS heartbeat both
        // renews the lease and aborts the sweep the moment another writer
        // took over mid-run
        if (!heartbeat(db, run.id, fence)) {
          throw new AteamError(`runner lease for ${run.id} was lost mid-clean — another writer took over; aborting before further destruction`, {
            exitCode: 1,
          });
        }
        const outcome = await cleanupTaskResources(env, task, {
          discardUnverified: opts.discardWork,
          // R4-05: the fence is also renewed between the individual teardown
          // steps — a single slow reclamation must not outlive its lease
          ensureLease: () => {
            if (!heartbeat(db, run.id, fence)) {
              throw new AteamError(`runner lease for ${run.id} was lost mid-clean — another writer took over; aborting before further destruction`, {
                exitCode: 1,
              });
            }
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
      // R3-08: with unverified work left behind (and no explicit discard),
      // the run stays RESUMABLE — terminating it here would hide it from the
      // default startup/reconcile path that re-runs the final gate and
      // finishes reclamation. Only a fully settled (or explicitly discarded)
      // run with no live executions is finalized.
      const terminate = (stillIntegrated === 0 || opts.discardWork) && activeExecutions.length === 0;
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
          status: getRun(db, run.id)?.status,
        }));
      } else {
        console.log(
          `clean ${run.id}: reclaimed ${reclaimed}, discarded ${discarded}, ${stillIntegrated} still pending, ${activeExecutions.length} active executions, run=${getRun(db, run.id)?.status}`,
        );
        if (activeExecutions.length > 0) {
          console.log(
            `fix: ${activeExecutions.length} execution(s) are still active (${activeExecutions.map((e) => `${e.taskId}/${e.role}`).join(', ')}) — stop the runner or let them finish before terminating the run; the run was left resumable`,
          );
        }
        if (stillIntegrated > 0 && !opts.discardWork) {
          console.log(
            'fix: these tasks have no current passing final verification, so they are not reclaimable and the run was left resumable — run the runner / `agent-team reconcile` to re-run the final verification, or re-run with --discard-work to destroy the unverified resources (audited, irreversible)',
          );
        }
      }
      return stillIntegrated > 0 || activeExecutions.length > 0 ? 1 : 0;
    } finally {
      releaseLease(db, run.id, fence);
    }
  } finally {
    db.close();
  }
}
