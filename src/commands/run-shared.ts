// Shared wiring for run-oriented commands.

import type { SqliteDb } from '../store/db.ts';
import { insertRun, getRun } from '../store/runs.ts';
import { insertTask } from '../store/tasks.ts';
import { addEvent } from '../store/events.ts';
import { newRunId } from '../store/ids.ts';
import type { AteamHome } from '../config.ts';
import { HerdrCliRuntimeClient } from '../herdr/runtime-client.ts';
import type { HerdrRuntimeClient } from '../herdr/client.ts';
import { validateContract, topologicalTasks } from '../core/contract.ts';
import { revParse } from '../core/git.ts';
import { AteamError, DoctorError } from '../core/errors.ts';
import type { ExecutionContract, RunRecord } from '../core/types.ts';
import type { RunnerEnv } from '../runner/executions.ts';

export async function loadContractFile(path: string): Promise<ExecutionContract> {
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.file(path).text());
  } catch (err) {
    throw new AteamError(`cannot read contract at ${path}: ${(err as Error).message}`);
  }
  return validateContract(raw);
}

export async function probeOrFailFast(client: HerdrRuntimeClient): Promise<void> {
  let probe;
  try {
    probe = await client.probe();
  } catch (err) {
    throw new DoctorError(
      `herdr runtime probe failed: ${(err as Error).message}`,
      'start Herdr or run `agent-team doctor --runtime herdr` for details',
    );
  }
  const missing = Object.entries(probe.capabilities).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length > 0) {
    throw new DoctorError(
      `herdr ${probe.version} missing capabilities: ${missing.join(', ')}`,
      'upgrade Herdr to a version providing the required socket methods',
    );
  }
}

export function createClient(herdrPath?: string): HerdrRuntimeClient {
  return new HerdrCliRuntimeClient(herdrPath ? { herdrPath } : {});
}

/** Persist a run + seed tasks from a validated contract. */
export async function createRunRecord(
  db: SqliteDb,
  contract: ExecutionContract,
  opts: { runId?: string; status?: 'queued' | 'planned' } = {},
): Promise<RunRecord> {
  const baseSha = await revParse(contract.project.repoRoot, contract.project.baseRef);
  const runId = opts.runId ?? newRunId();
  const run = insertRun(db, {
    id: runId,
    contract,
    baseSha,
    status: opts.status ?? 'planned',
  });
  for (const taskId of topologicalTasks(contract)) {
    const spec = contract.tasks.find((t) => t.id === taskId)!;
    insertTask(db, runId, spec);
  }
  addEvent(db, runId, 'RUN_CREATED', {
    payload: { projectId: contract.project.id, tasks: contract.tasks.length, baseRef: contract.project.baseRef },
  });
  return run;
}

export function buildRunnerEnv(home: AteamHome, db: SqliteDb, client: HerdrRuntimeClient, run: RunRecord): RunnerEnv {
  const contract = getRunContract(db, run.id);
  return { home, db, client, config: home.config, runId: run.id, contract };
}

import { getContractRevision } from '../store/runs.ts';
function getRunContract(db: SqliteDb, runId: string): ExecutionContract {
  const contract = getContractRevision(db, runId);
  if (!contract) throw new AteamError(`run ${runId} has no contract revision`);
  return contract;
}

export function getRunOrThrow(db: SqliteDb, runId: string): RunRecord {
  const run = getRun(db, runId);
  if (!run) throw new AteamError(`run not found: ${runId}`);
  return run;
}
