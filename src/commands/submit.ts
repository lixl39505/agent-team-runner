// agent-team submit — validate a contract and enqueue it. A Runner pane
// claims queued runs later via `agent-team runner --claim`.

import { openDatabase, type SqliteDb } from '../store/db.ts';
import { loadHome } from '../config.ts';
import { listRuns } from '../store/runs.ts';
import { createRunRecord, loadContractFile, probeOrFailFast, createClient } from './run-shared.ts';

export interface SubmitCommandOptions {
  contract: string;
  home?: string;
  json: boolean;
  herdrPath?: string;
}

export async function cmdSubmit(opts: SubmitCommandOptions): Promise<number> {
  const home = await loadHome(opts.home);
  const db = openDatabase(home.dbPath);
  try {
    const contract = await loadContractFile(opts.contract);
    await probeOrFailFast(createClient(opts.herdrPath));
    const run = await createRunRecord(db, contract, { status: 'queued' });
    if (opts.json) {
      console.log(JSON.stringify({ runId: run.id, status: run.status }));
    } else {
      console.log(`queued ${run.id}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/** Pick the oldest claimable run for `runner --claim`. */
export function findClaimableRun(db: SqliteDb): string | null {
  const queued = listRuns(db, { nonTerminalOnly: true }).filter((r) => r.status === 'queued');
  return queued[0]?.id ?? null;
}
