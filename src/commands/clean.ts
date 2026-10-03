// agent-team clean — finish a run: reclaim any "integrated but not yet
// reclaimed" resources (audit-driven, retryable), then mark the run
// abandoned. Safe to run repeatedly.

import { openDatabase } from '../store/db.ts';
import { loadHome } from '../config.ts';
import { getRun, updateRunStatus } from '../store/runs.ts';
import { listTasks } from '../store/tasks.ts';
import { addEvent } from '../store/events.ts';
import { AteamError } from '../core/errors.ts';
import { buildRunnerEnv, getRunOrThrow } from './run-shared.ts';
import { cleanupTaskResources } from '../runner/cleanup.ts';
import { releaseLease } from '../store/lease.ts';
import type { HerdrRuntimeClient } from '../herdr/client.ts';
import { createClient } from './run-shared.ts';

export interface CleanCommandOptions {
  runId: string;
  home?: string;
  json: boolean;
  herdrPath?: string;
  /** Test seam: inject a fake runtime client. */
  client?: HerdrRuntimeClient;
}

export async function cmdClean(opts: CleanCommandOptions): Promise<number> {
  const home = await loadHome(opts.home);
  const db = openDatabase(home.dbPath);
  try {
    const run = getRunOrThrow(db, opts.runId);
    const client = opts.client ?? createClient(opts.herdrPath);
    const env = buildRunnerEnv(home, db, client, run);
    const tasks = listTasks(db, run.id);

    let reclaimed = 0;
    for (const task of tasks.filter((t) => t.status === 'integrated')) {
      const ok = await cleanupTaskResources(env, task);
      if (ok) reclaimed += 1;
    }

    releaseLease(db, run.id);
    if (!['done', 'cancelled', 'abandoned', 'failed'].includes(run.status)) {
      updateRunStatus(db, run.id, 'abandoned');
      addEvent(db, run.id, 'RUN_STATUS_CHANGED', { payload: { to: 'abandoned', source: 'clean' } });
    }

    const stillIntegrated = listTasks(db, run.id).filter((t) => t.status === 'integrated').length;
    if (opts.json) {
      console.log(JSON.stringify({ runId: run.id, reclaimed, stillIntegrated, status: getRun(db, run.id)?.status }));
    } else {
      console.log(`clean ${run.id}: reclaimed ${reclaimed} task(s), ${stillIntegrated} still pending, run=${getRun(db, run.id)?.status}`);
    }
    return stillIntegrated > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}
