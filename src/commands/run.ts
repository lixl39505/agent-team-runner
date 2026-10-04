// agent-team run — validate, create the run, and become the foreground
// Runner (this pane IS the Runner pane when launched inside Herdr).

import { openDatabase } from '../store/db.ts';
import { getRun } from '../store/runs.ts';
import { loadHome } from '../config.ts';
import { RunnerEngine } from '../runner/engine.ts';
import { AteamError } from '../core/errors.ts';
import {
  buildRunnerEnv, createClient, createRunRecord, getRunOrThrow, loadContractFile, probeOrFailFast, resolveSelfPaneId,
} from './run-shared.ts';
import { findClaimableRun } from './submit.ts';

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
  if (opts.contract && opts.claim) {
    throw new AteamError('run accepts either --contract PATH or --claim, not both');
  }
  if (!opts.contract && !opts.claim && !opts.runId) {
    throw new AteamError('run requires --contract PATH, --run-id ID or --claim');
  }
  const home = await loadHome(opts.home);
  const db = openDatabase(home.dbPath);
  try {
    const client = createClient(opts.herdrPath);
    await probeOrFailFast(client);

    let run;
    if (opts.contract) {
      const contract = await loadContractFile(opts.contract);
      run = await createRunRecord(db, contract, { status: 'planned' });
    } else if (opts.claim) {
      // plugin action `run --claim`: attach as the Runner for the oldest queued run
      const claimed = findClaimableRun(db);
      if (!claimed) throw new AteamError('nothing to claim (no queued runs); submit a contract first');
      run = getRunOrThrow(db, claimed);
    } else {
      run = getRunOrThrow(db, opts.runId!);
      if (!['queued', 'planned', 'running', 'needs_attention', 'integrating'].includes(run.status)) {
        throw new AteamError(`run ${run.id} is terminal (${run.status}); cannot attach`);
      }
    }

    if (opts.maxParallel !== undefined) home.config.defaults.maxParallel = opts.maxParallel;

    const engine = new RunnerEngine(buildRunnerEnv(home, db, client, run), {
      selfPaneId: resolveSelfPaneId(opts.selfPaneId),
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
