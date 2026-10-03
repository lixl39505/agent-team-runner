// agent-team run — validate, create the run, and become the foreground
// Runner (this pane IS the Runner pane when launched inside Herdr).

import { openDatabase } from '../store/db.ts';
import { getRun } from '../store/runs.ts';
import { loadHome } from '../config.ts';
import { RunnerEngine } from '../runner/engine.ts';
import { AteamError } from '../core/errors.ts';
import { buildRunnerEnv, createClient, createRunRecord, getRunOrThrow, loadContractFile, probeOrFailFast } from './run-shared.ts';

export interface RunCommandOptions {
  contract?: string;
  runId?: string;
  home?: string;
  maxParallel?: number;
  json: boolean;
  herdrPath?: string;
  selfPaneId?: string;
  claim?: boolean;
}

export async function cmdRun(opts: RunCommandOptions): Promise<number> {
  const home = await loadHome(opts.home);
  const db = openDatabase(home.dbPath);
  try {
    const client = createClient(opts.herdrPath);
    await probeOrFailFast(client);

    let run;
    if (opts.contract) {
      const contract = await loadContractFile(opts.contract);
      run = await createRunRecord(db, contract, { status: 'planned' });
    } else if (opts.runId) {
      run = getRunOrThrow(db, opts.runId);
      if (!['queued', 'planned', 'running', 'needs_attention', 'integrating'].includes(run.status)) {
        throw new AteamError(`run ${run.id} is terminal (${run.status}); cannot attach`);
      }
    } else {
      throw new AteamError('run requires --contract PATH or --run-id ID');
    }

    if (opts.maxParallel !== undefined) home.config.defaults.maxParallel = opts.maxParallel;

    const engine = new RunnerEngine(buildRunnerEnv(home, db, client, run), {
      selfPaneId: opts.selfPaneId ?? process.env.HERDR_PANE_ID,
      selfAgentName: 'ateam-runner',
    });
    const exitCode = await engine.runUntilTerminal();
    const final = getRun(db, run.id)?.status ?? 'unknown';
    if (opts.json) {
      console.log(JSON.stringify({ runId: run.id, status: final, exitCode }));
    } else {
      console.log(`run ${run.id}: ${final} (exit ${exitCode})`);
    }
    return exitCode;
  } finally {
    db.close();
  }
}
