// Shared wiring for run-oriented commands.

import type { SqliteDb } from '../store/db.ts';
import { insertRun, getRun } from '../store/runs.ts';
import { insertTask } from '../store/tasks.ts';
import { addEvent } from '../store/events.ts';
import { newRunId } from '../store/ids.ts';
import type { AteamHome } from '../config.ts';
import { resolveAgentEntry, type AgentEntry } from '../config.ts';
import { HerdrCliRuntimeClient } from '../herdr/runtime-client.ts';
import type { HerdrRuntimeClient } from '../herdr/client.ts';
import { validateContract, topologicalTasks } from '../core/contract.ts';
import { revParse } from '../core/git.ts';
import { MINIMUM_HERDR_VERSION } from '../herdr/versions.ts';
import { AteamError, DoctorError } from '../core/errors.ts';
import { checkAgentCli, type DoctorCheck } from './doctor.ts';
import { resolveReviewerEntry } from '../runner/executions.ts';
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
  if (!probe.protocolOk) {
    // unparseable version or missing/unreadable api schema — both mean the
    // runtime is below the minimum protocol the runner depends on
    throw new DoctorError(
      `herdr ${probe.version} does not satisfy the minimum protocol (>= ${MINIMUM_HERDR_VERSION} with a readable api schema)`,
      'upgrade Herdr to a version providing the required CLI/socket API surface',
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

/**
 * Fail-fast on the agent integrations THIS contract needs (review 02
 * R2-13): every distinct agent kind reachable from the contract's tasks
 * (task-level override, worker/reviewer/integrator roles, cross-kind
 * reviewer) must have a runnable CLI before the Runner starts any agent.
 * `doctor` alone cannot satisfy the ADR — the run entry has to check.
 */
export async function probeAgentsOrFailFast(
  env: RunnerEnv,
  checkKind: (kind: string) => Promise<DoctorCheck> = checkAgentCli,
): Promise<void> {
  const { config, contract } = env;
  const kinds = new Set<string>();
  const workerEntryFor = (specAgent: string | undefined): AgentEntry =>
    resolveAgentEntry(config, specAgent, 'worker');
  for (const spec of contract.tasks) {
    const workerEntry = workerEntryFor(spec.agent);
    kinds.add(workerEntry.kind);
    kinds.add(resolveReviewerEntry(config, workerEntry.kind).kind);
    kinds.add(resolveAgentEntry(config, spec.agent, 'integrator').kind);
  }
  const checks = await Promise.all([...kinds].sort().map((kind) => checkKind(kind)));
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new DoctorError(
      `agent integrations unavailable for this contract: ${failed.map((c) => c.detail).join('; ')}`,
      failed.map((c) => c.remediation).filter(Boolean).join(' ') || 'install the missing agent CLIs',
    );
  }
}

/** The Runner pane's own pane id: explicit flag > plugin action context
 * (HERDR_PLUGIN_CONTEXT_JSON, injected per herdr-plugin.toml) > Herdr pane env. */
export function resolveSelfPaneId(flag?: string): string | undefined {
  if (flag) return flag;
  const fromEnv = process.env.HERDR_PANE_ID;
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return fromEnv;
  try {
    const ctx = JSON.parse(raw) as Record<string, unknown>;
    const paneOf = (o: Record<string, unknown>): string | undefined =>
      typeof o.pane_id === 'string' && o.pane_id !== '' ? o.pane_id
        : typeof o.paneId === 'string' && o.paneId !== '' ? o.paneId : undefined;
    const nested = typeof ctx.workspace === 'object' && ctx.workspace !== null
      ? paneOf(ctx.workspace as Record<string, unknown>)
      : undefined;
    return paneOf(ctx) ?? nested ?? fromEnv;
  } catch {
    return fromEnv;
  }
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
