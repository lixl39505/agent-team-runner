// agent-team reconcile — restore the control plane after Runner crash or
// Herdr server restart: snapshot ∩ ledger, recover executions, resume
// cleanups. --dry-run is side-effect free (plugin startup hook uses it).

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
  decisions: ReconcileDecision[];
}

export async function cmdReconcile(opts: ReconcileCommandOptions): Promise<number> {
  const home = await loadHome(opts.home);
  const db = openDatabase(home.dbPath);
  try {
    const client = opts.client ?? createRuntimeClient({ herdrPath: opts.herdrPath });
    const runs = opts.runId
      ? [getRunOrThrow(db, opts.runId)]
      : listRuns(db, { nonTerminalOnly: true });

    const results: RunReconcileResult[] = [];
    for (const run of runs) {
      const current = getRun(db, run.id)!;
      if (!current) continue;
      if (!acquireLease(db, run.id)) {
        results.push({ runId: run.id, skipped: 'live_lease', decisions: [] });
        continue;
      }
      try {
        const engine = new RunnerEngine(buildRunnerEnv(home, db, client, current), {});
        const decisions = await engine.reconcileOnce({ dryRun: opts.dryRun });
        results.push({ runId: run.id, decisions });
      } finally {
        releaseLease(db, run.id);
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ dryRun: opts.dryRun, results }, null, 2));
    } else {
      for (const result of results) {
        if (result.skipped) {
          console.log(`${result.runId}: skipped (${result.skipped})`);
          continue;
        }
        console.log(`${result.runId}:`);
        for (const d of result.decisions) {
          console.log(`  - ${d.kind}${d.taskId ? ` ${d.taskId}` : ''}${d.detail ? ` — ${d.detail}` : ''}`);
        }
        if (result.decisions.length === 0) console.log('  (nothing to do)');
      }
      if (results.length === 0) console.log('no non-terminal runs');
    }
    return 0;
  } finally {
    db.close();
  }
}
