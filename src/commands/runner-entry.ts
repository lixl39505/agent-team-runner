// agent-team runner — resident Runner entry for Herdr panes/plugins.
// `--run-id` attaches to a specific run; `--claim` picks the oldest queued run.

import { openDatabase } from '../store/db.ts';
import { loadHome } from '../config.ts';
import { RunnerEngine } from '../runner/engine.ts';
import { AteamError } from '../core/errors.ts';
import { buildRunnerEnv, createClient, getRunOrThrow } from './run-shared.ts';
import { findClaimableRun } from './submit.ts';

export interface RunnerEntryOptions {
  runId?: string;
  claim: boolean;
  home?: string;
  selfPaneId?: string;
  herdrPath?: string;
  tickMs?: number;
}

export async function cmdRunnerEntry(opts: RunnerEntryOptions): Promise<number> {
  const home = await loadHome(opts.home);
  const db = openDatabase(home.dbPath);
  try {
    const runId = opts.runId ?? (opts.claim ? findClaimableRun(db) : undefined);
    if (!runId) throw new AteamError('nothing to claim (no queued runs); pass --run-id or submit a contract first');
    const run = getRunOrThrow(db, runId);
    const engine = new RunnerEngine(
      buildRunnerEnv(home, db, createClient(opts.herdrPath), run),
      {
        selfPaneId: opts.selfPaneId ?? process.env.HERDR_PANE_ID,
        selfAgentName: 'ateam-runner',
        tickMs: opts.tickMs,
      },
    );
    const exitCode = await engine.runUntilTerminal();
    console.log(`run ${runId} finished with exit ${exitCode}`);
    return exitCode;
  } finally {
    db.close();
  }
}
