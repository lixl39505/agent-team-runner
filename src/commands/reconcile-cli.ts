// agent-team reconcile — restore the control plane after Runner crash or
// Herdr server restart: subscribe → snapshot ∩ ledger, apply persisted
// results, resume cleanups. Runs under the runner lease, so the plugin
// startup hook can invoke it for real without racing a live Runner.

import { openDatabase } from '../store/db.ts';
import { loadHome } from '../config.ts';
import { getRun, listRuns } from '../store/runs.ts';
import { acquireLease, releaseLease } from '../store/lease.ts';
import { RunnerEngine, type ReconcileDecision } from '../runner/engine.ts';
import { buildRunnerEnv, getRunOrThrow } from './run-shared.ts';
import type { HerdrRuntimeClient } from '../herdr/client.ts';
import { createRuntimeClient } from '../herdr/runtime-client.ts';

export interface ReconcileCommandOptions {
  runId?: string;
  home?: string;
  json: boolean;
  dryRun: boolean;
  herdrPath?: string;
  client?: HerdrRuntimeClient;
}

export interface RunReconcileResult {
  runId: string;
  skipped?: 'live_lease';
  /** R4-05: the pass aborted mid-way (e.g. the fencing token was lost to
   * another writer) — surfaced per run instead of killing the whole sweep. */
  error?: string;
  /** R5-06: known deferral decision kinds on this pass (runtime snapshot or
   * event subscription unavailable) — machine-readable "judgments were
   * postponed", distinct from a hard error. */
  deferred?: string[];
  decisions: ReconcileDecision[];
}

/** R5-06: decision kinds that mean "this pass could not judge" — they must
 * be reportable by machines, not silently folded into exit 0. */
const DEFERRAL_KINDS: ReadonlySet<string> = new Set(['snapshot_unavailable', 'subscription_unavailable']);

export async function cmdReconcile(opts: ReconcileCommandOptions): Promise<number> {
  const home = await loadHome(opts.home);
  const db = openDatabase(home.dbPath);
  try {
    // socket preferred: the ADR recovery order (subscribe before snapshot)
    // needs the socket transport; the hybrid client falls back to the CLI
    // wrapper for snapshot when no socket is available
    const client = opts.client ?? createRuntimeClient({ herdrPath: opts.herdrPath, preferSocket: true });
    const runs = opts.runId
      ? [getRunOrThrow(db, opts.runId)]
      : listRuns(db, { nonTerminalOnly: true });

    const results: RunReconcileResult[] = [];
    for (const run of runs) {
      const current = getRun(db, run.id)!;
      if (!current) continue;
      const fence = acquireLease(db, run.id);
      if (!fence) {
        results.push({ runId: run.id, skipped: 'live_lease', decisions: [] });
        continue;
      }
      try {
        // R4-05: the engine carries THIS pass's fencing token, so every
        // control-plane write inside reconcileOnce renews/verifies the lease
        const engine = new RunnerEngine(buildRunnerEnv(home, db, client, current), { leaseFence: fence });
        const decisions = await engine.reconcileOnce({ dryRun: opts.dryRun });
        results.push({ runId: run.id, decisions });
      } catch (err) {
        results.push({ runId: run.id, error: err instanceof Error ? err.message : String(err), decisions: [] });
      } finally {
        releaseLease(db, run.id, fence);
      }
    }

    // R5-06: the exit status must not lie — a failed pass is not success,
    // and a deferred pass is its own distinguishable state
    let hardFail = false;
    let deferred = false;
    for (const result of results) {
      const kinds = [...new Set(result.decisions.filter((d) => DEFERRAL_KINDS.has(d.kind)).map((d) => d.kind))];
      if (kinds.length > 0) {
        result.deferred = kinds;
        deferred = true;
      }
      if (result.error) hardFail = true;
    }

    if (opts.json) {
      console.log(JSON.stringify({ dryRun: opts.dryRun, results }, null, 2));
    } else {
      for (const result of results) {
        if (result.skipped) {
          console.log(`${result.runId}: skipped (${result.skipped})`);
          continue;
        }
        if (result.error) {
          console.log(`${result.runId}: FAILED — ${result.error}`);
          continue;
        }
        if (result.deferred) {
          console.log(`${result.runId}: DEFERRED (${result.deferred.join(', ')}) — recovery judgments postponed`);
        } else {
          console.log(`${result.runId}:`);
        }
        for (const d of result.decisions) {
          console.log(`  - ${d.kind}${d.taskId ? ` ${d.taskId}` : ''}${d.detail ? ` — ${d.detail}` : ''}`);
        }
        if (result.decisions.length === 0) console.log('  (nothing to do)');
      }
      if (results.length === 0) console.log('no non-terminal runs');
    }
    if (hardFail) return 1; // a pass aborted mid-way — recovery did NOT complete
    if (deferred) return 10; // needs attention: judgments postponed, retry later
    return 0;
  } finally {
    db.close();
  }
}
