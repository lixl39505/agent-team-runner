// agent-team contract validate / revise.

import { openDatabase } from '../store/db.ts';
import { loadHome } from '../config.ts';
import { appendContractRevision } from '../store/runs.ts';
import { addEvent } from '../store/events.ts';
import { AteamError } from '../core/errors.ts';
import { getRunOrThrow, loadContractFile } from './run-shared.ts';

export interface ContractCommandOptions {
  action: 'validate' | 'revise';
  contract: string;
  runId?: string;
  home?: string;
  json: boolean;
}

export async function cmdContract(opts: ContractCommandOptions): Promise<number> {
  const contract = await loadContractFile(opts.contract);
  if (opts.action === 'validate') {
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, tasks: contract.tasks.length }));
    } else {
      console.log(`contract ok: ${contract.tasks.length} tasks, base ${contract.project.baseRef}`);
    }
    return 0;
  }

  if (!opts.runId) throw new AteamError('contract revise requires --run-id');
  const home = await loadHome(opts.home);
  const db = openDatabase(home.dbPath);
  try {
    const run = getRunOrThrow(db, opts.runId);
    if (['done', 'cancelled', 'abandoned', 'failed'].includes(run.status)) {
      throw new AteamError(`run ${run.id} is terminal; revisions only apply to live runs`);
    }
    const revision = appendContractRevision(db, run.id, contract);
    addEvent(db, run.id, 'CONTRACT_REVISED', { payload: { revision, source: 'cli' } });
    console.log(`revision ${revision} appended to ${run.id} (flagged for the runner)`);
    return 0;
  } finally {
    db.close();
  }
}
