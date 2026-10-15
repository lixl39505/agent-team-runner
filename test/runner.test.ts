// Runner engine integration tests against the fake Herdr client with real
// git worktrees. These pin the ADR invariants: prompt exactly once, panes
// closed only after persisted results, blocked never creates attempts,
// revise consumption, and the verification/attempt gates.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, type SqliteDb } from '../src/store/db.ts';
import { insertRun, getRun, appendContractRevision, listRuns } from '../src/store/runs.ts';
import { insertTask, listTasks, getTask } from '../src/store/tasks.ts';
import { listExecutions } from '../src/store/executions.ts';
import { validateContract } from '../src/core/contract.ts';
import { RunnerEngine } from '../src/runner/engine.ts';
import { verifyTaskWork } from '../src/runner/phases/verify.ts';
import { commitVerifiedTree } from '../src/runner/phases/commit.ts';
import { commitIntegrationResolution } from '../src/runner/phases/integrate.ts';
import { concludeFinalGate } from '../src/runner/phases/final-gate.ts';
import { currentHead, writeTree } from '../src/core/git.ts';
import { FakeHerdrClient } from '../src/herdr/fake-client.ts';
import type { FakeAgentScript } from '../src/herdr/fake-client.ts';
import type { HerdrRuntimeClient } from '../src/herdr/client.ts';
import type { HerdrEvent, HerdrEventStream } from '../src/herdr/types.ts';
import { HerdrError } from '../src/herdr/types.ts';
import { agentName } from '../src/store/ids.ts';
import { DEFAULT_CONFIG, type AteamConfig } from '../src/config.ts';
import type { ExecutionContract, TaskRecord } from '../src/core/types.ts';
import { acquireLease, heartbeat, releaseLease } from '../src/store/lease.ts';
import { insertResource } from '../src/store/resources.ts';
import { latestCleanupSteps } from '../src/store/cleanup.ts';
import { cleanupTempDir, initRepo, makeTempDir, minimalContract, writeFileDeep } from './helpers.ts';

const RUN = 'r-20261003-run001';
const TERMINALS = ['done', 'failed', 'cancelled', 'abandoned'];

interface Fixture {
  fsRoot: string;
  home: string;
  repoRoot: string;
  db: SqliteDb;
  fake: FakeHerdrClient;
  config: AteamConfig;
  contract: ExecutionContract;
}

interface FixtureOptions {
  defaults?: Partial<AteamConfig['defaults']>;
}

const wName = (task: string, attempt = 1): string => agentName(RUN, task, 'worker', attempt);
const vName = (task: string, cycle = 1): string => agentName(RUN, task, 'reviewer', cycle);

const approvedReview = (files: string[]) => ({
  status: 'approved', summary: 'lgtm', findings: [], requiredChanges: [], reviewedFiles: files,
});

const workerOk = (file: string, content: string, summary: string) => ({
  status: 'completed', summary, testsRun: [], knownRisks: [], changedPaths: [file],
});

function workerScript(editFile: [string, string], result: unknown, extra: Partial<FakeAgentScript> = {}): FakeAgentScript {
  return {
    kind: 'claude',
    sequence: extra.sequence ?? ['working', 'done'],
    stepMs: 5,
    pauseAt: extra.pauseAt,
    onState: extra.onState ?? { done: { editFiles: [editFile], writeResultFile: result } },
  };
}

function reviewerScript(result: unknown): FakeAgentScript {
  return { kind: 'codex', sequence: ['working', 'done'], stepMs: 5, onState: { done: { writeResultFile: result } } };
}

function buildContract(repoRoot: string): ExecutionContract {
  return validateContract(
    minimalContract({
      project: { id: 'demo', repoRoot, baseRef: 'main' },
      tasks: [
        { id: 'API', title: 'api', allowedPaths: ['src/api/**'], verificationCommands: ['git rev-parse HEAD'] },
        { id: 'WEB', title: 'web', allowedPaths: ['src/web/**'] },
        { id: 'DOCS', title: 'docs', allowedPaths: ['docs/**'], dependsOn: ['API'] },
      ],
    }),
  );
}

async function makeFixture(scripts: Record<string, FakeAgentScript>, opts: FixtureOptions = {}): Promise<Fixture> {
  const fsRoot = await makeTempDir('ateam-runner-');
  const repoRoot = join(fsRoot, 'repo');
  await initRepo(repoRoot);
  const home = join(fsRoot, 'home');
  const db = openDatabase(join(home, 'state.sqlite'));
  const fake = new FakeHerdrClient({ fsRoot, repoRoot, scripts });
  process.env.HERDR_WORKSPACE_ID = 'w0'; // the Runner's own workspace in the fake
  const config = structuredClone(DEFAULT_CONFIG);
  config.roles = { worker: 'claude-worker', reviewer: 'codex-reviewer', integrator: 'claude-worker' };
  config.agents = { 'claude-worker': { kind: 'claude' }, 'codex-reviewer': { kind: 'codex' } };
  config.verificationAllowlist = ['git *'];
  config.defaults = { ...config.defaults, maxParallel: 2, ...opts.defaults };
  return { fsRoot, home, repoRoot, db, fake, config, contract: buildContract(repoRoot) };
}

function seedRun(fx: Fixture, runId = RUN): void {
  insertRun(fx.db, { id: runId, contract: fx.contract, baseSha: 'base', status: 'planned' });
  for (const task of fx.contract.tasks) {
    insertTask(fx.db, runId, task);
  }
}

function envFor(fx: Fixture, runId = RUN) {
  return {
    home: { root: fx.home, dbPath: join(fx.home, 'state.sqlite'), runsDir: join(fx.home, 'runs'), config: fx.config },
    db: fx.db,
    client: fx.fake,
    config: fx.config,
    runId,
    contract: fx.contract,
  };
}

function engineFor(fx: Fixture, runId = RUN): RunnerEngine {
  return new RunnerEngine(envFor(fx, runId), { tickMs: 5 });
}

/** Ledger the workspace a handle points at (what startExecution does). */
function insertWorkspaceLedger(
  fx: Fixture,
  ws: Awaited<ReturnType<FakeHerdrClient['createWorktreeWorkspace']>>,
  taskId = 'API',
): void {
  insertResource(fx.db, { runId: RUN, taskId, kind: 'workspace', herdrId: ws.workspace.workspaceId, branch: ws.worktree.branch, path: ws.worktree.path });
}

/** Latest recorded status of one cleanup step (test readability helper). */
function latestCleanupStepStatus(fx: Fixture, step: string): string | undefined {
  return latestCleanupSteps(fx.db, RUN, 'API').get(step as never)?.status;
}

/** Minimal HerdrRuntimeClient stub overriding just what a test exercises. */
function stubClient(partial: Partial<HerdrRuntimeClient>): HerdrRuntimeClient {
  const fail = (): Promise<never> => Promise.reject(new Error('stub: unused method'));
  return {
    probe: fail,
    createWorktreeWorkspace: fail,
    openWorktree: fail,
    removeWorktree: fail,
    splitPane: fail,
    closePane: fail,
    focusPane: fail,
    startAgent: fail,
    promptAgent: fail,
    waitAgent: fail,
    getAgent: fail,
    readPane: fail,
    reportAgentState: fail,
    snapshot: fail,
    subscribe: fail,
    ...partial,
  } as unknown as HerdrRuntimeClient;
}

/** A confirmed, event-less subscription stream (what a healthy subscribe returns). */
function emptyStream(): HerdrEventStream {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<HerdrEvent> {
      // never yields
    },
    close(): void {},
    drainPending(): HerdrEvent[] {
      return [];
    },
  };
}

/** Simulate a process crash at one engine method: the patched engine throws
 * on EVERY invocation (a dead process never recovers); recovery is observed
 * through a FRESH engine. Ticks that hit the crash are absorbed. */
function crashOnce(engine: object, method: string): void {
  (engine as Record<string, unknown>)[method] = () =>
    Promise.reject(new Error(`simulated crash in ${method}`));
}

/** tickUntil that tolerates the simulated crash throws from a dead engine. */
async function tickUntilCrashed(
  engine: RunnerEngine,
  fx: Fixture,
  pred: () => boolean,
  maxTicks = 200,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    try {
      await engine.tickOnce();
    } catch (err) {
      if (!/simulated crash/.test(String(err))) throw err;
    }
    if (pred()) return;
    await Bun.sleep(5);
  }
  throw new Error('tickUntilCrashed exhausted');
}

async function tickUntil(engine: RunnerEngine, fx: Fixture, pred: () => boolean, maxTicks = 600): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    await engine.tickOnce();
    if (pred()) return;
    await Bun.sleep(5);
  }
  const { listEvents } = await import('../src/store/events.ts');
  const events = listEvents(fx.db, RUN).map((e) => `${e.eventType} ${e.taskId ?? ''} ${JSON.stringify(e.payload)}`);
  const { readdir } = await import('node:fs/promises');
  const wtRoot = join(fx.fsRoot, 'worktrees');
  const tree = await readdir(wtRoot, { recursive: true, withFileTypes: false }).catch(() => [] as string[]);
  const agents = (await fx.fake.snapshot()).agents.map((a) => `${a.name}:${a.state}@${a.paneId}`);
  throw new Error(
    `tickUntil exhausted: run=${getRun(fx.db, RUN)?.status} tasks=${JSON.stringify(listTasks(fx.db, RUN).map((t) => [t.taskId, t.status, t.attempts]))}\nagents: ${agents.join(', ')}\nevents:\n${events.join('\n')}\nworktree tree:\n${tree.join('\n')}`,
  );
}

const registry: Array<Fixture> = [];
function track(fx: Fixture): Fixture {
  registry.push(fx);
  return fx;
}

afterAll(async () => {
  delete process.env.HERDR_WORKSPACE_ID;
  for (const fx of registry) {
    fx.db.close();
    await cleanupTempDir(fx.fsRoot);
  }
});

/** The standard three-task fleet finishing cleanly. */
function happyScripts(): Record<string, FakeAgentScript> {
  return {
    [wName('API')]: workerScript(['src/api/x.ts', 'export const a = 1;\n'], workerOk('src/api/x.ts', 'export const a = 1;\n', 'api done')),
    [vName('API')]: reviewerScript(approvedReview(['src/api/x.ts'])),
    [wName('WEB')]: workerScript(['src/web/y.ts', 'export const b = 2;\n'], workerOk('src/web/y.ts', 'export const b = 2;\n', 'web done')),
    [vName('WEB')]: reviewerScript(approvedReview(['src/web/y.ts'])),
    [wName('DOCS')]: workerScript(['docs/z.md', '# docs\n'], workerOk('docs/z.md', '# docs\n', 'docs done')),
    [vName('DOCS')]: reviewerScript(approvedReview(['docs/z.md'])),
  };
}

describe('RunnerEngine — full delivery chain', () => {
  test('parallel workers → cross-kind review → dependency → integration → done', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));

    expect(getRun(fx.db, RUN)!.status).toBe('done');
    const tasks = listTasks(fx.db, RUN);
    // full lifecycle: integrated AND reclaimed with audited cleanup
    expect(tasks.every((t) => t.status === 'reclaimed')).toBe(true);
    expect(tasks.every((t) => t.commitSha && t.integrationCommit)).toBe(true);

    const execs = listExecutions(fx.db, RUN);
    expect(execs.filter((e) => e.role === 'worker')).toHaveLength(3);
    expect(execs.filter((e) => e.role === 'reviewer')).toHaveLength(3);
    expect(execs.filter((e) => e.role === 'reviewer').every((e) => e.agentKind === 'codex')).toBe(true);
    for (const exec of execs) {
      expect(fx.fake.promptCount(exec.agentName)).toBe(1);
    }
    expect(fx.fake.agentCount()).toBe(0);

    // temp resources reclaimed: branches deleted, worktrees gone (only the fake's base workspace remains)
    const { branchExists } = await import('../src/core/git.ts');
    for (const task of tasks) {
      expect(await branchExists(fx.repoRoot, task.branch!)).toBe(false);
    }
    const workspaces = (await fx.fake.snapshot()).workspaces;
    expect(workspaces.filter((w) => w.workspaceId !== 'w0')).toHaveLength(0);
  }, 30_000);

  test('native blocked: no new attempt, resumes in the same execution', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API')]: workerScript(['src/api/x.ts', 'export const a = 1;\n'], workerOk('src/api/x.ts', 'export const a = 1;\n', 'api'), {
        sequence: ['working', 'blocked', 'working', 'done'],
        pauseAt: 'blocked',
      }),
    }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => getRun(fx.db, RUN)!.status === 'needs_attention' && fx.fake.agentState(wName('API')) === 'blocked');

    const apiExecs = listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker');
    expect(apiExecs).toHaveLength(1);
    expect(apiExecs[0]!.status).toBe('blocked');
    expect(fx.fake.promptCount(wName('API'))).toBe(1);

    fx.fake.resumeAgent(wName('API'));
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker')).toHaveLength(1);
    expect(getTask(fx.db, RUN, 'API')!.attempts).toBe(1);
  }, 30_000);

  test('result-status blocked keeps pane and re-enters the gate on rewritten result', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: workerScript(['src/api/x.ts', 'x'], {
        status: 'blocked', blockedReason: 'waiting for credentials', summary: 'stuck', testsRun: [], knownRisks: [], changedPaths: [],
      }),
      [vName('API')]: reviewerScript(approvedReview(['src/api/x.ts'])),
      [wName('WEB')]: workerScript(['src/web/y.ts', 'export const b = 2;\n'], workerOk('src/web/y.ts', 'export const b = 2;\n', 'web')),
      [vName('WEB')]: reviewerScript(approvedReview(['src/web/y.ts'])),
      [wName('DOCS')]: workerScript(['docs/z.md', '# docs\n'], workerOk('docs/z.md', '# docs\n', 'docs')),
      [vName('DOCS')]: reviewerScript(approvedReview(['docs/z.md'])),
    }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => getTask(fx.db, RUN, 'API')!.status === 'blocked');
    expect(getRun(fx.db, RUN)!.status).toBe('needs_attention');
    const apiExec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    expect(apiExec.paneState).toBe('retained');
    expect(apiExec.status).toBe('running'); // re-armable
    expect(fx.fake.getAgent(wName('API'))).not.toBeNull();

    await fx.fake.performAction(wName('API'), {
      editFiles: [['src/api/x.ts', 'export const a = 1;\n']],
      writeResultFile: workerOk('src/api/x.ts', 'export const a = 1;\n', 'done now'),
    });
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
  }, 30_000);

  test('blocked_on_contract freezes until a revision is consumed', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: workerScript(['src/api/x.ts', 'x'], {
        status: 'blocked_on_contract', summary: 'out of scope', testsRun: [], knownRisks: [], changedPaths: [],
        contractBlock: { code: 'out_of_scope', message: 'need src/shared', requestedContractChanges: ['add src/shared/**'], affectedPaths: ['src/shared/**'] },
      }),
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'export const a = 1;\n'], workerOk('src/api/x.ts', 'export const a = 1;\n', 'done')),
      [vName('API')]: reviewerScript(approvedReview(['src/api/x.ts'])),
      [wName('WEB')]: workerScript(['src/web/y.ts', 'export const b = 2;\n'], workerOk('src/web/y.ts', 'export const b = 2;\n', 'web')),
      [vName('WEB')]: reviewerScript(approvedReview(['src/web/y.ts'])),
      [wName('DOCS')]: workerScript(['docs/z.md', '# docs\n'], workerOk('docs/z.md', '# docs\n', 'docs')),
      [vName('DOCS')]: reviewerScript(approvedReview(['docs/z.md'])),
    }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => getTask(fx.db, RUN, 'API')!.status === 'blocked_on_contract');
    expect(getRun(fx.db, RUN)!.status).toBe('needs_attention');
    expect(engine.exitCodeFor(getRun(fx.db, RUN)!)).toBe(11);

    appendContractRevision(fx.db, RUN, fx.contract); // revision consumed → unblock
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
    const apiWorkers = listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker');
    expect(apiWorkers).toHaveLength(2);
    expect(apiWorkers[0]!.status).toBe('abandoned');
  }, 30_000);

  test('revision adds and removes tasks and becomes the effective contract', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: workerScript(['src/api/x.ts', 'x'], {
        status: 'blocked_on_contract', summary: 'out of scope', testsRun: [], knownRisks: [], changedPaths: [],
        contractBlock: { code: 'out_of_scope', message: 'scope changed', requestedContractChanges: [], affectedPaths: [] },
      }),
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'export const a = 1;\n'], workerOk('src/api/x.ts', 'export const a = 1;\n', 'done')),
      [vName('API')]: reviewerScript(approvedReview(['src/api/x.ts'])),
      [wName('EXTRA')]: workerScript(['extra/e.md', '# extra\n'], workerOk('extra/e.md', '# extra\n', 'extra done')),
      [vName('EXTRA')]: reviewerScript(approvedReview(['extra/e.md'])),
    }));
    // two-task v1: API + DOCS
    const contractV1 = validateContract(minimalContract({
      project: { id: 'demo', repoRoot: fx.repoRoot, baseRef: 'main' },
      tasks: [
        { id: 'API', title: 'api', allowedPaths: ['src/api/**'] },
        { id: 'DOCS', title: 'docs', allowedPaths: ['docs/**'], dependsOn: ['API'] },
      ],
    }));
    insertRun(fx.db, { id: RUN, contract: contractV1, baseSha: 'base', status: 'planned' });
    for (const t of contractV1.tasks) insertTask(fx.db, RUN, t);

    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => getTask(fx.db, RUN, 'API')!.status === 'blocked_on_contract');

    // v2: DOCS (never started) removed, EXTRA added
    const contractV2 = validateContract(minimalContract({
      project: { id: 'demo', repoRoot: fx.repoRoot, baseRef: 'main' },
      tasks: [
        { id: 'API', title: 'api', allowedPaths: ['src/api/**'] },
        { id: 'EXTRA', title: 'extra', allowedPaths: ['extra/**'] },
      ],
    }));
    appendContractRevision(fx.db, RUN, contractV2);
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));

    expect(getRun(fx.db, RUN)!.status).toBe('done');
    expect(getTask(fx.db, RUN, 'DOCS')).toBeNull(); // removed from the ledger
    expect(getTask(fx.db, RUN, 'EXTRA')!.status).toBe('reclaimed'); // added AND executed
    // the Runner's effective contract is the revision (scheduling/brief authority)
    expect(engine.env.contract.tasks.map((t) => t.id).sort()).toEqual(['API', 'EXTRA']);
    expect(engine.env.contract).toEqual(contractV2);
    expect(getRun(fx.db, RUN)!.revisionPending).toBe(false);
    // R3-02/R3-03: an APPLIED revision is the accepted one
    expect(getRun(fx.db, RUN)!.acceptedRevision).toBe(2);
  }, 60_000);

  test('incompatible revision (removes an executed task) is refused and stays pending', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: workerScript(['src/api/x.ts', 'export const a = 1;\n'], workerOk('src/api/x.ts', 'export const a = 1;\n', 'done')),
      [vName('API')]: reviewerScript(approvedReview(['src/api/x.ts'])),
    }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => getTask(fx.db, RUN, 'API')!.status === 'reviewing');

    // v2 drops API — already executed, so the revision must be refused whole
    const contractV2 = validateContract(minimalContract({
      project: { id: 'demo', repoRoot: fx.repoRoot, baseRef: 'main' },
      tasks: [{ id: 'WEB', title: 'web', allowedPaths: ['src/web/**'] }],
    }));
    appendContractRevision(fx.db, RUN, contractV2);
    await engine.tickOnce();

    expect(getRun(fx.db, RUN)!.status).toBe('needs_attention');
    expect(getRun(fx.db, RUN)!.revisionPending).toBe(true); // resolvable by a corrected revision
    expect(getRun(fx.db, RUN)!.error).toContain('removes already-executed tasks');
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('reviewing'); // untouched — nothing half-applied
    expect(engine.env.contract).not.toEqual(contractV2);
  }, 30_000);

  test('done without result file: no approval, pane stays open', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5 }, // finishes, writes nothing
      [wName('WEB')]: workerScript(['src/web/y.ts', 'export const b = 2;\n'], workerOk('src/web/y.ts', 'export const b = 2;\n', 'web')),
      [vName('WEB')]: reviewerScript(approvedReview(['src/web/y.ts'])),
      [wName('DOCS')]: workerScript(['docs/z.md', '# docs\n'], workerOk('docs/z.md', '# docs\n', 'docs')),
      [vName('DOCS')]: reviewerScript(approvedReview(['docs/z.md'])),
    }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => fx.fake.agentState(wName('API')) === 'done');
    for (let i = 0; i < 5; i++) await engine.tickOnce();
    expect(getRun(fx.db, RUN)!.status).not.toBe('done');
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('running');
    expect(fx.fake.getAgent(wName('API'))).not.toBeNull();
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'reviewer')).toHaveLength(0);
  }, 30_000);

  test('schema-invalid result → result_pending, pane retained', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: workerScript(['src/api/x.ts', 'x'], { status: 'completed', summary: 'ok', sneaky: true }),
    }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => listExecutions(fx.db, RUN).some((e) => e.status === 'result_pending'));
    expect(getRun(fx.db, RUN)!.status).toBe('needs_attention');
    expect(fx.fake.getAgent(wName('API'))).not.toBeNull();
  }, 30_000);

  test('verification failure retries in the same worktree; exhaustion fails the run', async () => {
    const fsRoot = await makeTempDir('ateam-runner-vf-');
    const repoRoot = join(fsRoot, 'repo');
    await initRepo(repoRoot);
    const contract = validateContract(
      minimalContract({
        project: { id: 'demo', repoRoot, baseRef: 'main' },
        tasks: [{ id: 'API', title: 'api', allowedPaths: ['src/api/**'], verificationCommands: ['git rev-parse --verify nope'] }],
      }),
    );
    const fx = track({
      fsRoot, home: join(fsRoot, 'home'), repoRoot,
      db: openDatabase(join(fsRoot, 'home', 'state.sqlite')),
      fake: new FakeHerdrClient({
        fsRoot, repoRoot,
        scripts: {
          [wName('API')]: workerScript(['src/api/x.ts', 'x'], workerOk('src/api/x.ts', 'x', 'a1')),
          [wName('API', 2)]: workerScript(['src/api/x2.ts', 'x'], workerOk('src/api/x2.ts', 'x', 'a2')),
        },
      }),
      config: { ...structuredClone(DEFAULT_CONFIG) } as AteamConfig,
      contract,
    });
    fx.config.roles = { worker: 'claude-worker', reviewer: 'codex-reviewer', integrator: 'claude-worker' };
    fx.config.agents = { 'claude-worker': { kind: 'claude' }, 'codex-reviewer': { kind: 'codex' } };
    fx.config.verificationAllowlist = ['git *'];
    fx.config.defaults = { ...fx.config.defaults, maxParallel: 2, maxWorkerAttempts: 2 };
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('failed');
    expect(getTask(fx.db, RUN, 'API')!.attempts).toBe(2);
    expect(engine.exitCodeFor(getRun(fx.db, RUN)!)).toBe(1);
  }, 30_000);

  test('changes_requested cycles the worker; second review approves', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API')]: workerScript(['src/api/x.ts', 'v1\n'], workerOk('src/api/x.ts', 'v1\n', 'a1')),
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'v2 fixed\n'], workerOk('src/api/x.ts', 'v2 fixed\n', 'a2')),
      [vName('API')]: reviewerScript({ status: 'changes_requested', summary: 'needs work', findings: [{ severity: 'high', file: 'src/api/x.ts', message: 'bad' }], requiredChanges: ['fix it'], reviewedFiles: ['src/api/x.ts'] }),
      [vName('API', 2)]: reviewerScript(approvedReview(['src/api/x.ts'])),
    }, { defaults: { maxReviewCycles: 3 } }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
    const api = getTask(fx.db, RUN, 'API')!;
    expect(api.reviewCycles).toBe(2);
    expect((api.review as { status: string }).status).toBe('approved');
  }, 30_000);

  test('clean reclaims verified resources and abandons the run', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    // simulate: every task delivered (WEB/DOCS already reclaimed), API
    // reached "integrated", final verification persisted, then the runner
    // died before cleanup
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    fx.db.run(`UPDATE tasks SET status='reclaimed' WHERE run_id=? AND task_id IN ('WEB','DOCS')`, [RUN]);
    const { insertResource } = await import('../src/store/resources.ts');
    insertResource(fx.db, { runId: RUN, taskId: 'API', kind: 'workspace', herdrId: ws.workspace.workspaceId, branch: ws.worktree.branch, path: ws.worktree.path });
    const { insertVerification } = await import('../src/store/verifications.ts');
    insertVerification(fx.db, { runId: RUN, kind: 'final', ok: true, detail: { contractRevision: 1, headSha: 'i1', integratedCommits: { API: 'i1' } } });
    fx.db.run("UPDATE runs SET status='needs_attention', final_verified=1 WHERE id = ?", [RUN]);

    const { cmdClean } = await import('../src/commands/clean.ts');
    const exit = await cmdClean({ runId: RUN, home: fx.home, json: false, client: fx.fake });
    expect(exit).toBe(0);
    expect(getRun(fx.db, RUN)!.status).toBe('abandoned');
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('reclaimed');
    const { branchExists } = await import('../src/core/git.ts');
    expect(await branchExists(fx.repoRoot, `ateam/${RUN}/task/API`)).toBe(false);
    expect((await fx.fake.snapshot()).workspaces.filter((w) => w.workspaceId !== 'w0')).toHaveLength(0);
    // idempotent second run
    expect(await cmdClean({ runId: RUN, home: fx.home, json: false, client: fx.fake })).toBe(0);
  }, 30_000);

  test('clean without a persisted final verification does NOT reclaim (R2-03); --discard-work does, as an audited discard', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    const { insertResource } = await import('../src/store/resources.ts');
    insertResource(fx.db, { runId: RUN, taskId: 'API', kind: 'workspace', herdrId: ws.workspace.workspaceId, branch: ws.worktree.branch, path: ws.worktree.path });
    // NOTE: no verification record — the run is unverified

    const { cmdClean } = await import('../src/commands/clean.ts');
    // default: resources untouched, exit 1 reports the deferral
    expect(await cmdClean({ runId: RUN, home: fx.home, json: true, client: fx.fake })).toBe(1);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated');
    // R3-08: the run is NOT terminated — it stays visible to the default
    // startup/reconcile path that re-runs the final verification
    expect(TERMINALS).not.toContain(getRun(fx.db, RUN)!.status);
    expect(listRuns(fx.db, { nonTerminalOnly: true }).map((r) => r.id)).toContain(RUN);
    expect((await fx.fake.snapshot()).workspaces.some((w) => w.workspaceId === ws.workspace.workspaceId)).toBe(true);
    const { branchExists } = await import('../src/core/git.ts');
    expect(await branchExists(fx.repoRoot, `ateam/${RUN}/task/API`)).toBe(true);

    // explicit override: destroy unverified resources as an audited DISCARD
    expect(await cmdClean({ runId: RUN, home: fx.home, json: true, client: fx.fake, discardWork: true })).toBe(0);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('discarded'); // never 'reclaimed'
    expect(await branchExists(fx.repoRoot, `ateam/${RUN}/task/API`)).toBe(false);
    expect((await fx.fake.snapshot()).workspaces.filter((w) => w.workspaceId !== 'w0')).toHaveLength(0);
  }, 30_000);

  test('cleanup deletes only branches minted by THIS run (R2-04 provenance)', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    // a branch whose name does NOT carry this run's provenance prefix must
    // never be a delete candidate, even if a corrupted ledger points at it
    const { insertVerification } = await import('../src/store/verifications.ts');
    insertVerification(fx.db, { runId: RUN, kind: 'final', ok: true, detail: { contractRevision: 1, integratedCommits: { API: 'i1' } } });
    fx.db.run("UPDATE runs SET final_verified=1 WHERE id=?", [RUN]);
    await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'users/someone/feature' });
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch='users/someone/feature', worktree_path='/no/where',
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [RUN],
    );

    const { cleanupTaskResources } = await import('../src/runner/cleanup.ts');
    const outcome = await cleanupTaskResources(envFor(fx), getTask(fx.db, RUN, 'API')!);
    expect(outcome).toBeNull(); // refused at verify_branch_free
    const { branchExists } = await import('../src/core/git.ts');
    expect(await branchExists(fx.repoRoot, 'users/someone/feature')).toBe(true); // untouched
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated');
  }, 30_000);

  test('R4-03: cleanup refuses when the herdr id no longer maps to the ledgered workspace (id reuse)', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    const { insertVerification } = await import('../src/store/verifications.ts');
    insertVerification(fx.db, { runId: RUN, kind: 'final', ok: true, detail: { contractRevision: 1, integratedCommits: { API: 'i1' } } });
    fx.db.run('UPDATE runs SET final_verified=1 WHERE id=?', [RUN]);

    // herdr restarted and REUSED the id for a different workspace (another
    // path): the ledger row alone must not authorize the force removal
    const doctored = Object.create(fx.fake) as FakeHerdrClient;
    doctored.snapshot = async () => {
      const snap = await fx.fake.snapshot();
      return {
        ...snap,
        workspaces: snap.workspaces.map((w) =>
          w.workspaceId === ws.workspace.workspaceId
            ? { ...w, worktree: { ...w.worktree!, path: '/elsewhere/some-other-run', branch: 'main' } }
            : w,
        ),
      };
    };
    const env = { ...envFor(fx), client: doctored as HerdrRuntimeClient };
    const { cleanupTaskResources } = await import('../src/runner/cleanup.ts');
    const outcome = await cleanupTaskResources(env, getTask(fx.db, RUN, 'API')!);
    expect(outcome).toBeNull(); // refused at remove_worktree
    expect(latestCleanupStepStatus(fx, 'remove_worktree')).toBe('failed');
    // the foreign workspace survived, the branch was never touched
    expect(fx.fake.worktreeOf(ws.workspace.workspaceId)).not.toBeNull();
    const { branchExists } = await import('../src/core/git.ts');
    expect(await branchExists(fx.repoRoot, `ateam/${RUN}/task/API`)).toBe(true);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated');

    // identity restored (the mapping matches the ledger again) → cleanup proceeds
    const outcome2 = await cleanupTaskResources(envFor(fx), getTask(fx.db, RUN, 'API')!);
    expect(outcome2).toBe('reclaimed');
    expect(fx.fake.worktreeOf(ws.workspace.workspaceId)).toBeNull();
  }, 30_000);

  test('R4-06: a vanished integration worktree voids the old final PASS for reclamation', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    const { insertVerification } = await import('../src/store/verifications.ts');
    const { currentHead } = await import('../src/core/git.ts');
    // the PASS binds to the integration HEAD it verified — here the repo
    // HEAD stands in for it while the tree is "elsewhere"
    insertVerification(fx.db, {
      runId: RUN, kind: 'final', ok: true,
      detail: { contractRevision: 1, headSha: await currentHead(fx.repoRoot), integratedCommits: { API: 'i1' } },
    });
    fx.db.run(`UPDATE runs SET final_verified=1, integration_path=? WHERE id=?`, [join(fx.fsRoot, 'integration-lost'), RUN]);

    const { cleanupTaskResources } = await import('../src/runner/cleanup.ts');
    // the integration tree is gone: the persisted PASS cannot prove the
    // delivered HEAD, so the task worktree must NOT be reclaimed on it
    const outcome = await cleanupTaskResources(envFor(fx), getTask(fx.db, RUN, 'API')!);
    expect(outcome).toBeNull();
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated');
    expect(fx.fake.worktreeOf(ws.workspace.workspaceId)).not.toBeNull();

    // with the integration tree PRESENT (and the HEAD verified) cleanup proceeds
    fx.db.run(`UPDATE runs SET integration_path=? WHERE id=?`, [fx.repoRoot, RUN]);
    const outcome2 = await cleanupTaskResources(envFor(fx), getTask(fx.db, RUN, 'API')!);
    expect(outcome2).toBe('reclaimed');
  }, 30_000);

  test('clean refuses while a live runner holds the lease', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    acquireLease(fx.db, RUN);
    fx.db.run("UPDATE runner_leases SET holder = '99999@other' WHERE run_id = ?", [RUN]);
    const { cmdClean } = await import('../src/commands/clean.ts');
    await expect(cmdClean({ runId: RUN, home: fx.home, json: false, client: fx.fake })).rejects.toThrow(/lease/);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('pending'); // untouched
  });

  test('reconcile defers cleanup until final verification is persisted', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    const { insertResource } = await import('../src/store/resources.ts');
    insertResource(fx.db, { runId: RUN, taskId: 'API', kind: 'workspace', herdrId: ws.workspace.workspaceId, branch: ws.worktree.branch, path: ws.worktree.path });

    const engine = engineFor(fx);
    const decisions = await engine.reconcileOnce({});
    expect(decisions.some((d) => d.kind === 'cleanup_deferred')).toBe(true);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated'); // NOT reclaimed
    const { branchExists } = await import('../src/core/git.ts');
    expect(await branchExists(fx.repoRoot, `ateam/${RUN}/task/API`)).toBe(true);
    expect((await fx.fake.snapshot()).workspaces.some((w) => w.workspaceId === ws.workspace.workspaceId)).toBe(true);
  });

  test('cleanup resumes safely after a crash mid-reclaim (already-removed resources)', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    // the previous process closed panes and removed the worktree, audited
    // both ok, then crashed before the branch steps
    await fx.fake.removeWorktree({ workspaceId: ws.workspace.workspaceId, force: true });
    const { recordCleanupStep } = await import('../src/store/cleanup.ts');
    recordCleanupStep(fx.db, { runId: RUN, taskId: 'API', step: 'close_pane', status: 'ok' });
    recordCleanupStep(fx.db, { runId: RUN, taskId: 'API', step: 'remove_worktree', status: 'ok' });
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    fx.db.run('UPDATE runs SET final_verified=1 WHERE id=?', [RUN]);
    const { insertVerification } = await import('../src/store/verifications.ts');
    insertVerification(fx.db, { runId: RUN, kind: 'final', ok: true, detail: { contractRevision: 1, integratedCommits: { API: 'i1' } } });

    const { cleanupTaskResources } = await import('../src/runner/cleanup.ts');
    const outcome = await cleanupTaskResources(envFor(fx), getTask(fx.db, RUN, 'API')!);
    expect(outcome).toBe('reclaimed');
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('reclaimed');
    const { branchExists } = await import('../src/core/git.ts');
    expect(await branchExists(fx.repoRoot, `ateam/${RUN}/task/API`)).toBe(false);
  }, 30_000);

  test('reconcile: after server restart, lost panes get fresh attempts on rebuilt worktrees', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5 }, // finishes, no result
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'export const a = 1;\n'], workerOk('src/api/x.ts', 'export const a = 1;\n', 'recovered')),
    }, { defaults: { maxParallel: 1 } }));
    seedRun(fx);
    const engine = engineFor(fx);
    // API a1 finishes WITHOUT writing a result (script has no onState)
    await tickUntil(engine, fx, () => fx.fake.agentState(wName('API')) === 'done');
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker')).toHaveLength(1);

    // simulate Herdr server restart: runtime registry wiped, worktree dirs remain
    fx.fake.restartServer();

    const engine2 = engineFor(fx);
    const dry = await engine2.reconcileOnce({ dryRun: true });
    expect(dry.some((d) => d.kind === 'pane_lost_new_attempt')).toBe(true);
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker')).toHaveLength(1); // dry-run: unchanged

    const decisions = await engine2.reconcileOnce({});
    expect(decisions.some((d) => d.kind === 'pane_lost_new_attempt')).toBe(true);

    await tickUntil(engine2, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
    const apiWorkers = listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker');
    expect(apiWorkers).toHaveLength(2);
    expect(apiWorkers[0]!.status).toBe('abandoned');
    expect(fx.fake.promptCount(wName('API'))).toBe(1);
    expect(fx.fake.promptCount(wName('API', 2))).toBe(1);
  }, 60_000);

  test('reconcile subscribes before snapshotting; snapshot failure defers pane-loss judgments', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5 }, // finishes, no result
    }));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const scheduled = getTask(fx.db, RUN, 'API')!;
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: scheduled, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    fx.fake.dropPane(exec.paneId!); // pane gone, no result written

    // subscription unavailable (R2-07) ⇒ the required subscribe-before-
    // snapshot order cannot be guaranteed: judgments stop entirely, no
    // snapshot-only degradation
    const broken = stubClient({
      subscribe: () => Promise.reject(new Error('no subscription')),
      snapshot: () => Promise.reject(new Error('snapshot down')),
    });
    const brokenEngine = new RunnerEngine({ ...envFor(fx), client: broken }, {});
    const decisions = await brokenEngine.reconcileOnce({});
    expect(decisions.some((d) => d.kind === 'subscription_unavailable')).toBe(true);
    expect(decisions.some((d) => d.kind === 'pane_lost_new_attempt' || d.kind === 'pane_lost_no_attempt')).toBe(false);
    // the execution is untouched — the next pass with a healthy runtime decides
    expect(listExecutions(fx.db, RUN).filter((e) => e.status === 'abandoned')).toHaveLength(0);
    expect(listExecutions(fx.db, RUN).find((e) => e.id === exec.id)!.status).toBe('running');

    // a confirmed subscription with a FAILING snapshot still stops judgments
    const { HerdrError } = await import('../src/herdr/types.ts');
    const noSnapshot = stubClient({
      subscribe: () => Promise.resolve(emptyStream()),
      snapshot: () => Promise.reject(new HerdrError('timeout', 'snapshot down')),
    });
    const noSnapEngine = new RunnerEngine({ ...envFor(fx), client: noSnapshot }, {});
    const snapDecisions = await noSnapEngine.reconcileOnce({});
    expect(snapDecisions.some((d) => d.kind === 'snapshot_unavailable')).toBe(true);
    expect(listExecutions(fx.db, RUN).filter((e) => e.status === 'abandoned')).toHaveLength(0);

    // with a healthy snapshot the same state gets judged: subscribe BEFORE snapshot
    const beforeReconcile = fx.fake.calls.map((c) => c.method).length;
    await engineFor(fx).reconcileOnce({});
    const orderNow = fx.fake.calls.map((c) => c.method).slice(beforeReconcile);
    expect(orderNow.indexOf('subscribe')).toBeGreaterThanOrEqual(0);
    expect(orderNow.indexOf('subscribe')).toBeLessThan(orderNow.indexOf('snapshot'));
    expect(listExecutions(fx.db, RUN).find((e) => e.id === exec.id)!.status).toBe('abandoned');
  }, 30_000);

  test('reconcile: pane lost after the result landed is recovered, never re-attempted', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5 },
      [vName('API')]: reviewerScript(approvedReview(['src/api/x.ts'])),
    }));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const scheduled = getTask(fx.db, RUN, 'API')!;
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: scheduled, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    // the agent delivers a full valid result, THEN its pane vanishes
    await fx.fake.performAction(wName('API'), {
      editFiles: [['src/api/x.ts', 'export const a = 1;\n']],
      writeResultFile: workerOk('src/api/x.ts', 'export const a = 1;\n', 'done'),
    });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    fx.fake.dropPane(exec.paneId!);

    const engine = engineFor(fx);
    const decisions = await engine.reconcileOnce({});
    expect(decisions.some((d) => d.kind === 'result_recovered' && d.taskId === 'API')).toBe(true);
    expect(decisions.some((d) => d.kind === 'pane_lost_new_attempt' || d.kind === 'pane_lost_no_attempt')).toBe(false);
    // the persisted result was applied: reviewing with a reviewer cycle started
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('reviewing');
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker')).toHaveLength(1);
  }, 30_000);

  test('dispatch interrupted before the prompt: a live idle agent gets it exactly once', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API')]: { kind: 'claude', sequence: ['idle'], stepMs: 5 },
    }));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const scheduled = getTask(fx.db, RUN, 'API')!;
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: scheduled, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    // rewind to the crash point: row + digest persisted, prompt unconfirmed
    // and undelivered
    fx.fake.resetToIdle(wName('API'));
    fx.db.run("UPDATE executions SET status='starting', prompt_sent_at=NULL WHERE id=?", [exec.id]);

    const engine = engineFor(fx);
    await engine.tickOnce();
    const resumed = listExecutions(fx.db, RUN).find((e) => e.id === exec.id)!;
    expect(resumed.status).toBe('running');
    expect(resumed.promptSentAt).not.toBeNull();
    expect(fx.fake.promptCount(wName('API'))).toBe(1);

    // from here the delivery chain completes normally
    await fx.fake.performAction(wName('API'), {
      editFiles: [['src/api/x.ts', 'export const a = 1;\n']],
      writeResultFile: workerOk('src/api/x.ts', 'export const a = 1;\n', 'done'),
    });
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
  }, 30_000);

  test('dispatch interrupted, pane lost: fresh attempt instead of a permanent stall', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5 },
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'export const a = 1;\n'], workerOk('src/api/x.ts', 'export const a = 1;\n', 'a2')),
    }));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const scheduled = getTask(fx.db, RUN, 'API')!;
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: scheduled, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    // crash after the row landed but before the prompt: promptSentAt null
    fx.db.run("UPDATE executions SET status='starting', prompt_sent_at=NULL WHERE id=?", [exec.id]);
    fx.fake.dropPane(exec.paneId!);

    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
    const apiWorkers = listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker');
    expect(apiWorkers).toHaveLength(2);
    expect(apiWorkers[0]!.status).toBe('abandoned');
    expect(getTask(fx.db, RUN, 'API')!.attempts).toBe(2);
  }, 60_000);

  test('dispatch resume with a non-reproducible prompt escalates instead of guessing', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: { kind: 'claude', sequence: ['idle'], stepMs: 5 },
    }));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const scheduled = getTask(fx.db, RUN, 'API')!;
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: scheduled, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    fx.db.run("UPDATE executions SET status='starting', prompt_sent_at=NULL, prompt_digest='deadbeef' WHERE id=?", [exec.id]);

    const engine = engineFor(fx);
    const promptsBefore = fx.fake.promptCount(wName('API'));
    await engine.tickOnce();
    const stuck = listExecutions(fx.db, RUN).find((e) => e.id === exec.id)!;
    expect(stuck.status).toBe('abandoned');
    expect(stuck.paneState).toBe('retained'); // pane kept for human inspection
    expect(fx.fake.promptCount(wName('API'))).toBe(promptsBefore); // nothing sent on a guess
  }, 30_000);

  test('runUntilTerminal refuses without a free lease', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    expect(acquireLease(fx.db, RUN)).not.toBeNull();
    fx.db.run("UPDATE runner_leases SET holder = '99999@other' WHERE run_id = ?", [RUN]);
    const engine = engineFor(fx);
    await expect(engine.runUntilTerminal()).rejects.toThrow(/lease/);
  });

  test('crash between receipt and application: the stored result is replayed, not dropped', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      // worker finishes but writes nothing; we stage the crash manually
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5 },
    }));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const scheduled = getTask(fx.db, RUN, 'API')!;
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: scheduled, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });

    // the agent delivers a valid result; the previous Runner persisted the
    // RECEIPT (digest/result/received_at) and crashed before applying it
    await fx.fake.performAction(wName('API'), {
      editFiles: [['src/api/x.ts', 'export const a = 1;\n']],
      writeResultFile: workerOk('src/api/x.ts', 'export const a = 1;\n', 'done'),
    });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    const { readResultFile } = await import('../src/results/files.ts');
    const read = await readResultFile(exec.resultPath!);
    const { updateExecution } = await import('../src/store/executions.ts');
    updateExecution(fx.db, exec.id, { resultDigest: read!.digest, result: read!.value, resultReceivedAt: new Date().toISOString() });
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('running'); // transition NOT applied yet

    const engine = engineFor(fx); // a fresh Runner process
    await tickUntil(engine, fx, () => getTask(fx.db, RUN, 'API')!.status === 'reviewing');
    const replayed = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    expect(replayed.resultAppliedDigest).toBe(read!.digest); // applied exactly once
    expect(fx.fake.promptCount(wName('API'))).toBe(1); // never re-prompted
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
  }, 30_000);

  test('apply failure leaves the result replayable; recovery applies it without a new attempt', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5 },
    }));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const scheduled = getTask(fx.db, RUN, 'API')!;
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: scheduled, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const realWorktree = getTask(fx.db, RUN, 'API')!.worktreePath!;
    // sabotage so verification throws instead of failing cleanly
    fx.db.run("UPDATE tasks SET worktree_path='/no/such/worktree' WHERE run_id=? AND task_id='API'", [RUN]);
    await fx.fake.performAction(wName('API'), {
      editFiles: [['src/api/x.ts', 'export const a = 1;\n']],
      writeResultFile: workerOk('src/api/x.ts', 'export const a = 1;\n', 'done'),
    });

    const engine = engineFor(fx);
    await engine.tickOnce();
    await engine.tickOnce();
    const stuck = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    expect(stuck.resultDigest).not.toBeNull(); // phase 1 (receipt) persisted
    expect(stuck.resultAppliedDigest).toBeNull(); // phase 2 (application) did not complete
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker')).toHaveLength(1);

    // operator repairs the environment; the next tick replays the stored result
    fx.db.run("UPDATE tasks SET worktree_path=? WHERE run_id=? AND task_id='API'", [realWorktree, RUN]);
    await tickUntil(engine, fx, () => getTask(fx.db, RUN, 'API')!.status === 'reviewing');
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker')).toHaveLength(1);
  }, 30_000);

  test('integration state and final verification survive a Runner restart', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    // drive the predecessor runner until every task is integrated but final
    // verification has NOT run yet, then it "crashes"
    await tickUntil(engine, fx, () => {
      const run = getRun(fx.db, RUN)!;
      return listTasks(fx.db, RUN).every((t) => t.status === 'integrated')
        && !run.finalVerified
        && !!run.integrationPath;
    });
    const before = {
      path: getRun(fx.db, RUN)!.integrationPath,
      ws: getRun(fx.db, RUN)!.integrationWorkspaceId,
      api: getTask(fx.db, RUN, 'API')!.integrationCommit,
    };
    expect(before.path).toBeTruthy();
    fx.db.run("UPDATE runner_leases SET state='released' WHERE run_id=?", [RUN]);

    const engine2 = engineFor(fx); // fresh process: no in-memory state
    await engine2.tickOnce(); // resume: reopen from the ledger, run the final gate
    const resumed = getRun(fx.db, RUN)!;
    expect(resumed.finalVerified).toBe(true);
    expect(resumed.integrationPath).toBe(before.path); // reused, not rebuilt
    await tickUntil(engine2, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    const run = getRun(fx.db, RUN)!;
    expect(run.status).toBe('done');
    expect(getTask(fx.db, RUN, 'API')!.integrationCommit).toBe(before.api);
    expect(listTasks(fx.db, RUN).every((t) => t.status === 'reclaimed')).toBe(true);
    // the integration worktree is reclaimed too once everything is done
    expect((await fx.fake.snapshot()).workspaces.filter((w) => w.workspaceId !== 'w0')).toHaveLength(0);
  }, 60_000);

  test('detach/reattach: prompt_sent_at guard prevents re-prompting a live execution', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    // simulate the predecessor runner: scheduled + prompted, then vanished
    const { startExecution } = await import('../src/runner/executions.ts');
    fx.db.run("UPDATE tasks SET status = 'running', attempts = 1 WHERE run_id = ? AND task_id = 'API'", [RUN]);
    const scheduled = getTask(fx.db, RUN, 'API')!;
    await startExecution(envFor(fx), { role: 'worker', task: scheduled, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    expect(fx.fake.promptCount(wName('API'))).toBe(1);

    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
    // still exactly one prompt for the API worker; no new attempt was created
    expect(fx.fake.promptCount(wName('API'))).toBe(1);
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker')).toHaveLength(1);
  }, 30_000);

  test('R2-10: prompt DELIVERED but prompt_sent_at lost → resume dedupes by requestId, never double-injects', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const scheduled = getTask(fx.db, RUN, 'API')!;
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: scheduled, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    // crash window: the prompt WAS delivered (runtime holds the requestId),
    // but the process died before persisting prompt_sent_at
    fx.db.run("UPDATE executions SET status='starting', prompt_sent_at=NULL WHERE id=?", [exec.id]);

    const engine = engineFor(fx);
    await engine.tickOnce();
    const resumed = listExecutions(fx.db, RUN).find((e) => e.id === exec.id)!;
    expect(resumed.status).toBe('running');
    expect(resumed.promptSentAt).not.toBeNull();
    // the runtime deduped the re-sent requestId — still exactly ONE injection
    expect(fx.fake.promptCount(wName('API'))).toBe(1);
  }, 30_000);

  test('R3-01: a runtime WITHOUT prompt dedupe escalates an uncertain resume instead of re-sending', async () => {
    const fx = track(await makeFixture({
      // never finishes → no result file can exist, so the resume stays uncertain
      [wName('API')]: { kind: 'claude', sequence: ['working'], stepMs: 5 },
    }));
    fx.fake.supportsPromptDedup = () => false; // CLI-like transport: no request-id flag
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: getTask(fx.db, RUN, 'API')!, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    // crash window: the prompt MAY have landed; prompt_sent_at was lost
    fx.db.run("UPDATE executions SET status='starting', prompt_sent_at=NULL WHERE id=?", [exec.id]);

    const engine = engineFor(fx);
    await engine.tickOnce();

    // no second promptAgent call reached THIS agent, and the execution is
    // parked for manual confirmation — not re-prompted on a guess
    const promptsFor = (agent: string): number =>
      fx.fake.calls.filter((c) => c.method === 'promptAgent' && (c.args as { target: string }).target === agent).length;
    expect(promptsFor(wName('API'))).toBe(1);
    const resumed = listExecutions(fx.db, RUN).find((e) => e.id === exec.id)!;
    expect(resumed.promptSentAt).toBeNull();
    expect(resumed.status).toBe('starting');
    expect(getRun(fx.db, RUN)!.status).toBe('needs_attention');
    expect(getRun(fx.db, RUN)!.error).toContain('no request-id dedupe');
  }, 30_000);

  test('R3-01: a persisted result proves prompt delivery — resume marks it sent and never re-prompts', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: getTask(fx.db, RUN, 'API')!, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    // the agent finished and wrote its result, but the runner died before
    // persisting prompt_sent_at
    for (let i = 0; i < 200 && !exec.resultPath; i++) await Bun.sleep(5);
    expect(exec.resultPath).toBeTruthy();
    let resultExists = false;
    for (let i = 0; i < 200 && !resultExists; i++) {
      resultExists = await (await import('../src/results/files.ts')).readResultFile(exec.resultPath!).then((r) => !!r);
      await Bun.sleep(5);
    }
    expect(resultExists).toBe(true);
    fx.db.run("UPDATE executions SET status='starting', prompt_sent_at=NULL WHERE id=?", [exec.id]);

    // even a NO-dedupe transport is safe here: the result file is delivery evidence
    fx.fake.supportsPromptDedup = () => false;
    const engine = engineFor(fx);
    await engine.tickOnce();
    const resumed = listExecutions(fx.db, RUN).find((e) => e.id === exec.id)!;
    expect(resumed.promptSentAt).not.toBeNull();
    // never re-sent to THIS agent
    expect(fx.fake.calls.filter((c) => c.method === 'promptAgent' && (c.args as { target: string }).target === wName('API'))).toHaveLength(1);

    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
    expect(fx.fake.promptCount(wName('API'))).toBe(1);
  }, 30_000);

  test('R3-05: a close event arriving after the snapshot removes the pane from the alive set', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: getTask(fx.db, RUN, 'API')!, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    const snap = await fx.fake.snapshot();
    expect(snap.panes.some((p) => p.paneId === exec.paneId)).toBe(true); // snapshot STILL shows it

    // the subscription buffered a close for that pane AFTER the snapshot:
    // arrival order decides — the pane must judge as gone, not alive
    const streamWith = (...events: HerdrEvent[]): HerdrEventStream => {
      let drained = false;
      return {
        async *[Symbol.asyncIterator]() { /* never yields */ },
        close(): void {},
        drainPending(): HerdrEvent[] {
          if (drained) return [];
          drained = true;
          return events;
        },
      };
    };
    const env = { ...envFor(fx) };
    const liveAgent = { name: exec.agentName, paneId: exec.paneId!, state: 'idle' as const };
    const engine = new RunnerEngine({
      ...env,
      client: stubClient({
        subscribe: () => Promise.resolve(streamWith({ type: 'pane.closed', paneId: exec.paneId! })),
        snapshot: () => Promise.resolve(snap),
        getAgent: () => Promise.resolve(liveAgent),
      }),
    }, { tickMs: 5 });
    const decisions = await engine.reconcileOnce({ dryRun: true });
    const judged = decisions.find((d) => d.executionId === exec.id);
    expect(judged?.kind).toBe('pane_lost_new_attempt'); // NOT 'result_recovered / pane alive'

    // a later pane event re-adds liveness: closed → updated is alive again
    const engine2 = new RunnerEngine({
      ...env,
      client: stubClient({
        subscribe: () => Promise.resolve(streamWith({ type: 'pane.closed', paneId: exec.paneId! }, { type: 'pane.updated', paneId: exec.paneId! })),
        snapshot: () => Promise.resolve(snap),
        getAgent: () => Promise.resolve(liveAgent),
      }),
    }, { tickMs: 5 });
    const decisions2 = await engine2.reconcileOnce({ dryRun: true });
    const judged2 = decisions2.find((d) => d.executionId === exec.id);
    expect(judged2?.kind).toBe('result_recovered');
    expect(judged2?.detail).toContain('pane alive');
  }, 30_000);

  test('R3-e2e: herdr restores empty panes after a restart — pane alive but agent gone judges pane_lost', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: getTask(fx.db, RUN, 'API')!, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    const snap = await fx.fake.snapshot(); // pane alive in the snapshot…
    const env = { ...envFor(fx) };

    // …but the agent process is definitively gone (herdr not_found → null):
    // the same pane_lost judgment as a vanished pane — never a prompt guess
    const engine = new RunnerEngine({
      ...env,
      client: stubClient({
        subscribe: () => Promise.resolve(emptyStream()),
        snapshot: () => Promise.resolve(snap),
        getAgent: () => Promise.resolve(null),
      }),
    }, { tickMs: 5 });
    const decisions = await engine.reconcileOnce({ dryRun: true });
    const judged = decisions.find((d) => d.executionId === exec.id);
    expect(judged?.kind).toBe('pane_lost_new_attempt');
    expect(judged?.detail).toContain('agent');

    // an observability ERROR (not definitive absence) defers the judgment
    const engine2 = new RunnerEngine({
      ...env,
      client: stubClient({
        subscribe: () => Promise.resolve(emptyStream()),
        snapshot: () => Promise.resolve(snap),
        getAgent: () => Promise.reject(new Error('transport hiccup')),
      }),
    }, { tickMs: 5 });
    const decisions2 = await engine2.reconcileOnce({ dryRun: true });
    const judged2 = decisions2.find((d) => d.executionId === exec.id);
    expect(judged2?.kind).toBe('snapshot_unavailable');
    expect(judged2?.detail).toContain('unobservable');
  }, 30_000);

  test('R3-06: a live lease refuses a second fence even inside the same process', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const first = acquireLease(fx.db, RUN);
    expect(first).not.toBeNull();
    // same holder string (same PID@host), same process: still refused — a
    // second engine must never write alongside the first (R3-06)
    expect(acquireLease(fx.db, RUN)).toBeNull();
    // the holder renews via heartbeat, not by re-acquiring
    expect(heartbeat(fx.db, RUN, first)).toBe(true);
    expect(acquireLease(fx.db, RUN)).toBeNull();
    // release frees the run for the next acquirer
    releaseLease(fx.db, RUN, first);
    expect(acquireLease(fx.db, RUN)).not.toBeNull();
  });

  test('herdr blocked-at-startup rejection: start_failed marks the dispatch safe and the run resumes it', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    // wrap the fake with herdr 0.9.x startup semantics: the FIRST agent start
    // is rejected instantly (agent entered native UI during startup)
    let startCalls = 0;
    let promptCalls = 0;
    const client = Object.create(fx.fake) as typeof fx.fake;
    client.startAgent = async (input) => {
      startCalls += 1;
      if (startCalls === 1) throw new HerdrError('herdr_error', 'agent is blocked during startup and is not ready for prompts');
      return { name: input.name, paneId: input.paneId, state: 'idle' as const };
    };
    client.getAgent = async () => ({ name: wName('API'), paneId: 'w0:px', state: 'idle' as const });
    client.promptAgent = (async (input: { target: string }) => {
      promptCalls += 1;
      return { paneId: 'w0:px', state: 'working' as const, target: input.target };
    }) as typeof client.promptAgent;

    const env = { ...envFor(fx), client };
    const engine = new RunnerEngine(env, { tickMs: 5 });
    await engine.tickOnce(); // scheduleReady → start rejected → marked, run alive
    expect(getRun(fx.db, RUN)!.status).toBe('needs_attention');
    let exec = listExecutions(fx.db, RUN).find((e) => e.role === 'worker')!;
    expect(exec.startFailed).toBe(true);
    expect(exec.promptSentAt).toBeNull();

    // the operator resolved the pane; the next tick re-dispatches EXACTLY once
    await engine.tickOnce();
    exec = listExecutions(fx.db, RUN).find((e) => e.role === 'worker')!;
    expect(exec.startFailed).toBe(false);
    expect(exec.promptSentAt).not.toBeNull();
    expect(promptCalls).toBe(1);
    expect(startCalls).toBe(1); // the living agent was NOT restarted
  });

  test('R2-11: a failed worker result retains the pane and re-dispatches into a fresh pane', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API')]: workerScript(['src/api/x.ts', 'x'], {
        status: 'failed', summary: 'could not implement', blockedReason: 'implementation failed', testsRun: [], knownRisks: [], changedPaths: [],
      }),
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'export const a = 1;\n'], workerOk('src/api/x.ts', 'export const a = 1;\n', 'a2 ok')),
      [vName('API')]: reviewerScript(approvedReview(['src/api/x.ts'])),
    }, { defaults: { maxParallel: 1 } }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => listExecutions(fx.db, RUN).some((e) => e.taskId === 'API' && e.role === 'worker' && e.attemptNo === 2));

    const failed = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    expect(failed.paneState).toBe('retained'); // failed pane kept for attach (ADR)
    expect(fx.fake.getAgent(wName('API'))).not.toBeNull(); // NOT closed
    const retry = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API', 2))!;
    expect(['starting', 'running']).toContain(retry.status);

    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
  }, 60_000);

  test('R3-07: cleanup never marks a retained failure pane closed_success — it retires as gone', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API')]: workerScript(['src/api/x.ts', 'x'], {
        status: 'failed', summary: 'could not implement', blockedReason: 'implementation failed', testsRun: [], knownRisks: [], changedPaths: [],
      }),
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'export const a = 1;\n'], workerOk('src/api/x.ts', 'export const a = 1;\n', 'a2 ok')),
      [vName('API')]: reviewerScript(approvedReview(['src/api/x.ts'])),
    }, { defaults: { maxParallel: 1 } }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done'); // full reclamation ran

    const failed = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    // the failure record survives the sweep honestly: retired with the
    // removed workspace as `gone`, never rewritten to closed_success
    expect(failed.paneState).toBe('gone');
    const retried = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API', 2))!;
    expect(retried.paneState).toBe('closed_success');
    const reviewer = listExecutions(fx.db, RUN).find((e) => e.agentName === vName('API'))!;
    expect(reviewer.paneState).toBe('closed_success');
  }, 60_000);

  test('R2-02: crash after a result was consumed but before the review dispatch replays from pending_dispatch', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    // crash injection: the process dies at the exact window between "task
    // advanced to reviewing with the dispatch intent" and startReviewer —
    // once; afterwards the (same) engine behaves normally again
    crashOnce(engine, 'startReviewer');
    await tickUntilCrashed(engine, fx, () => getTask(fx.db, RUN, 'API')!.status === 'reviewing');
    expect(getTask(fx.db, RUN, 'API')!.pendingDispatch).toBe('review'); // intent persisted first
    expect(listExecutions(fx.db, RUN).filter((e) => e.role === 'reviewer')).toHaveLength(0); // dispatch never landed

    const engine2 = engineFor(fx); // fresh process, no in-memory state
    await engine2.tickOnce();
    const reviewers = listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'reviewer');
    expect(reviewers).toHaveLength(1); // recovered exactly one review cycle
    expect(getTask(fx.db, RUN, 'API')!.pendingDispatch).toBeNull(); // intent served
    await tickUntil(engine2, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
  }, 60_000);

  test('R2-02: crash after a review requested changes replays the worker retry', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API')]: workerScript(['src/api/x.ts', 'v1\n'], workerOk('src/api/x.ts', 'v1\n', 'a1')),
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'v2 fixed\n'], workerOk('src/api/x.ts', 'v2 fixed\n', 'a2')),
      [vName('API')]: reviewerScript({ status: 'changes_requested', summary: 'needs work', findings: [], requiredChanges: ['fix'], reviewedFiles: ['src/api/x.ts'] }),
      [vName('API', 2)]: reviewerScript(approvedReview(['src/api/x.ts'])),
    }, { defaults: { maxParallel: 1, maxReviewCycles: 3 } }));
    seedRun(fx);
    const engine = engineFor(fx);
    // crash injection: dies between consuming the changes_requested verdict
    // (review persisted + retry intent) and retryWorker
    crashOnce(engine, 'retryWorker');
    await tickUntilCrashed(engine, fx, () => !!getTask(fx.db, RUN, 'API')!.review);
    expect(getTask(fx.db, RUN, 'API')!.pendingDispatch).toBe('worker_retry');
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker' && e.attemptNo >= 2)).toHaveLength(0);

    const engine2 = engineFor(fx);
    await engine2.tickOnce();
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker' && e.attemptNo === 2)).toHaveLength(1);
    expect(getTask(fx.db, RUN, 'API')!.pendingDispatch).toBeNull();
    await tickUntil(engine2, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
    expect(getTask(fx.db, RUN, 'API')!.attempts).toBe(2);
  }, 60_000);

  test('R2-14: verification outcomes persist as queryable records bound to revision and HEAD', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));

    const { listVerifications } = await import('../src/store/verifications.ts');
    const records = listVerifications(fx.db, RUN);
    const taskRecords = records.filter((r) => r.kind === 'task' && r.taskId === 'API');
    expect(taskRecords.length).toBeGreaterThanOrEqual(1);
    expect(taskRecords.every((r) => r.ok));
    expect(taskRecords[0]!.detail!.commands!.length).toBeGreaterThanOrEqual(1);
    expect(taskRecords[0]!.detail!.headSha).toBeTruthy();
    const final = records.filter((r) => r.kind === 'final');
    expect(final).toHaveLength(1);
    expect(final[0]!.ok).toBe(true);
    expect(final[0]!.detail!.contractRevision).toBe(1);
    expect(final[0]!.detail!.headSha).toBeTruthy(); // the verified integration HEAD
  }, 60_000);

  test('R2-05: a revision changing the delivered set after final verification is rejected outright', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => getRun(fx.db, RUN)!.finalVerified === true);

    const contractV2 = validateContract(minimalContract({
      project: { id: 'demo', repoRoot: fx.repoRoot, baseRef: 'main' },
      tasks: [
        { id: 'API', title: 'api', allowedPaths: ['src/api/**'] },
        { id: 'WEB', title: 'web', allowedPaths: ['src/web/**'] },
        { id: 'DOCS', title: 'docs', allowedPaths: ['docs/**'], dependsOn: ['API'] },
        { id: 'EXTRA', title: 'extra', allowedPaths: ['extra/**'] },
      ],
    }));
    appendContractRevision(fx.db, RUN, contractV2);
    await engine.tickOnce();

    // the stale finalVerified does NOT silently swallow the revision: it is
    // rejected (audited), nothing half-applies, and the run can finish
    expect(getTask(fx.db, RUN, 'EXTRA')).toBeNull();
    expect(getRun(fx.db, RUN)!.revisionPending).toBe(false);
    expect(engine.env.contract).not.toEqual(contractV2);
    const { listEvents } = await import('../src/store/events.ts');
    const rejected = listEvents(fx.db, RUN).find(
      (e) => e.eventType === 'CONTRACT_REVISED' && (e.payload as { rejected?: boolean })?.rejected === true,
    );
    expect(rejected).toBeDefined();
    expect((rejected!.payload as { reason?: string }).reason).toContain('final verification');
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
  }, 60_000);

  test('R2-04: a revision moving the project binding is refused outright', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => getTask(fx.db, RUN, 'API')!.status === 'reviewing');

    const moved = validateContract(minimalContract({
      project: { id: 'demo', repoRoot: '/elsewhere/repo', baseRef: 'main' },
      tasks: [
        { id: 'API', title: 'api', allowedPaths: ['src/api/**'] },
        { id: 'WEB', title: 'web', allowedPaths: ['src/web/**'] },
        { id: 'DOCS', title: 'docs', allowedPaths: ['docs/**'], dependsOn: ['API'] },
      ],
    }));
    appendContractRevision(fx.db, RUN, moved);
    await engine.tickOnce();

    expect(getRun(fx.db, RUN)!.status).toBe('needs_attention');
    expect(getRun(fx.db, RUN)!.revisionPending).toBe(true);
    expect(getRun(fx.db, RUN)!.error).toContain('project binding');
    expect(engine.env.contract).not.toEqual(moved);
  }, 60_000);

  test('R3-02: a rejected binding revision never becomes the contract a fresh process reads', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => getTask(fx.db, RUN, 'API')!.status === 'reviewing');

    const moved = validateContract(minimalContract({
      project: { id: 'demo', repoRoot: '/elsewhere/repo', baseRef: 'main' },
      tasks: [
        { id: 'API', title: 'api', allowedPaths: ['src/api/**'] },
        { id: 'WEB', title: 'web', allowedPaths: ['src/web/**'] },
        { id: 'DOCS', title: 'docs', allowedPaths: ['docs/**'], dependsOn: ['API'] },
      ],
    }));
    appendContractRevision(fx.db, RUN, moved);
    await engine.tickOnce();
    expect(getRun(fx.db, RUN)!.acceptedRevision).toBe(1); // refusal keeps the accepted pointer

    // a FRESH process (run --run-id / clean / reconcile) builds its env from
    // the run row — the accepted revision, never the rejected candidate
    const { buildRunnerEnv } = await import('../src/commands/run-shared.ts');
    const home = { root: fx.home, dbPath: join(fx.home, 'state.sqlite'), runsDir: join(fx.home, 'runs'), config: fx.config };
    const env = buildRunnerEnv(home as never, fx.db, fx.fake, getRun(fx.db, RUN)!);
    expect(env.contract).not.toEqual(moved);
    expect(env.contract.project.repoRoot).toBe(fx.repoRoot); // the immutable run binding
    expect(env.contract.tasks.map((t) => t.id).sort()).toEqual(['API', 'DOCS', 'WEB']);
  }, 60_000);

  test('R3-03: a rejected post-verification revision is not the contract a restarted Runner resumes with', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => getRun(fx.db, RUN)!.finalVerified === true);

    const contractV2 = validateContract(minimalContract({
      project: { id: 'demo', repoRoot: fx.repoRoot, baseRef: 'main' },
      tasks: [
        { id: 'API', title: 'api', allowedPaths: ['src/api/**'], verificationCommands: ['git rev-parse HEAD'] },
        { id: 'WEB', title: 'web', allowedPaths: ['src/web/**'] },
        { id: 'DOCS', title: 'docs', allowedPaths: ['docs/**'], dependsOn: ['API'] },
        { id: 'EXTRA', title: 'extra', allowedPaths: ['extra/**'] },
      ],
    }));
    appendContractRevision(fx.db, RUN, contractV2);
    await engine.tickOnce(); // rejected outright (R2-05)
    expect(getTask(fx.db, RUN, 'EXTRA')).toBeNull();
    expect(getRun(fx.db, RUN)!.revisionPending).toBe(false);
    expect(getRun(fx.db, RUN)!.acceptedRevision).toBe(1);

    // restart verification: a NEW Runner env from buildRunnerEnv must see the
    // SAME contract, task set and verification evidence — not the candidate
    const { buildRunnerEnv } = await import('../src/commands/run-shared.ts');
    const { hasPassingFinalVerification } = await import('../src/store/verifications.ts');
    const home = { root: fx.home, dbPath: join(fx.home, 'state.sqlite'), runsDir: join(fx.home, 'runs'), config: fx.config };
    const env = buildRunnerEnv(home as never, fx.db, fx.fake, getRun(fx.db, RUN)!);
    expect(env.contract.tasks.map((t) => t.id).sort()).toEqual(['API', 'DOCS', 'WEB']);
    expect(listTasks(fx.db, RUN).map((t) => t.taskId).sort()).toEqual(['API', 'DOCS', 'WEB']);
    const final = hasPassingFinalVerification(env.db, RUN);
    expect(final).toBe(true);
    const acceptedRev = getRun(fx.db, RUN)!.acceptedRevision;

    // and the fresh engine can still finish: cleanup runs against the accepted world
    const engine2 = new RunnerEngine(env, { tickMs: 5 });
    await tickUntil(engine2, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
    expect(getRun(fx.db, RUN)!.acceptedRevision).toBe(acceptedRev);
  }, 60_000);

  test('R3-04: a stale final PASS (integration HEAD moved after it) never gates cleanup — the gate is re-run', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => getRun(fx.db, RUN)!.finalVerified === true);
    const { latestVerification, listVerifications } = await import('../src/store/verifications.ts');
    const first = latestVerification(fx.db, RUN, 'final')!;
    expect(first.ok).toBe(true);

    // a stray commit moves the integration HEAD after the PASS was recorded
    const path = getRun(fx.db, RUN)!.integrationPath!;
    const tamper = Bun.spawn(['git', '-C', path, 'commit', '--allow-empty', '-m', 'post-verification tamper'],
      { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    expect(await tamper.exited).toBe(0);
    const { currentHead } = await import('../src/core/git.ts');
    const newHead = await currentHead(path);

    // one tick: nothing is reclaimed on the stale PASS; the gate re-runs and
    // persists a NEW record bound to the current HEAD
    await engine.tickOnce();
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated');
    const second = latestVerification(fx.db, RUN, 'final')!;
    expect(second.id).not.toBe(first.id);
    expect(second.ok).toBe(true);
    expect(second.detail!.headSha).toBe(newHead);

    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
    expect(listVerifications(fx.db, RUN).filter((r) => r.kind === 'final')).toHaveLength(2);
  }, 60_000);

  test('R3-04: a PASS bound to an older accepted revision never gates cleanup — the gate is re-run', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => getRun(fx.db, RUN)!.finalVerified === true);
    const { latestVerification } = await import('../src/store/verifications.ts');
    const first = latestVerification(fx.db, RUN, 'final')!;
    expect(first.detail!.contractRevision).toBe(1);

    // a compatible (delivery-preserving) revision is accepted afterwards —
    // the recorded PASS no longer carries the accepted revision
    const contractV2 = validateContract(minimalContract({
      project: { id: 'demo', repoRoot: fx.repoRoot, baseRef: 'main' },
      provenance: { documents: [{ kind: 'note', reference: 'scope-note-rev2' }] },
      tasks: [
        { id: 'API', title: 'api', allowedPaths: ['src/api/**'], verificationCommands: ['git rev-parse HEAD'] },
        { id: 'WEB', title: 'web', allowedPaths: ['src/web/**'] },
        { id: 'DOCS', title: 'docs', allowedPaths: ['docs/**'], dependsOn: ['API'] },
      ],
    }));
    appendContractRevision(fx.db, RUN, contractV2);
    await engine.tickOnce(); // consume → acceptedRevision=2, stale PASS redone
    expect(getRun(fx.db, RUN)!.acceptedRevision).toBe(2);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated'); // nothing reclaimed on the v1 PASS
    const second = latestVerification(fx.db, RUN, 'final')!;
    expect(second.id).not.toBe(first.id);
    expect(second.detail!.contractRevision).toBe(2);

    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
  }, 60_000);

  test('R2-12: a stale integration mapping is reconfirmed against Herdr, reopened by branch, and keeps its base SHA', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => {
      const run = getRun(fx.db, RUN)!;
      return listTasks(fx.db, RUN).every((t) => t.status === 'integrated') && !!run.integrationPath;
    });
    const before = getRun(fx.db, RUN)!;
    expect(before.integrationBaseSha).toBeTruthy();
    // simulate a lost/stale mapping (e.g. schema v1 upgrade): the ledger
    // points at a workspace Herdr no longer knows, while the branch survives
    fx.db.run("UPDATE runs SET integration_workspace_id='w-gone' WHERE id=?", [RUN]);

    const engine2 = engineFor(fx);
    // stop at final verification — cleanup has not nulled the mapping yet
    await tickUntil(engine2, fx, () => getRun(fx.db, RUN)!.finalVerified === true);

    const verified = getRun(fx.db, RUN)!;
    // reopened from the recorded branch, back to the real workspace
    expect(verified.integrationWorkspaceId).toBe(before.integrationWorkspaceId);
    expect(verified.integrationPath).toBe(before.integrationPath);
    // the FIRST creation's baseline survived the reopen — not the post-integration HEAD
    expect(verified.integrationBaseSha).toBe(before.integrationBaseSha);
    const { listVerifications } = await import('../src/store/verifications.ts');
    const final = listVerifications(fx.db, RUN).filter((r) => r.kind === 'final');
    expect(final).toHaveLength(1);
    expect(final[0]!.ok).toBe(true);
    expect(final[0]!.detail!.baseSha).toBe(before.integrationBaseSha);
    await tickUntil(engine2, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
  }, 60_000);

  test('R2-12: after a Herdr restart the ledgered mapping is reconfirmed, not blindly trusted or rebuilt', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => {
      const run = getRun(fx.db, RUN)!;
      return listTasks(fx.db, RUN).every((t) => t.status === 'integrated') && !!run.integrationPath;
    });
    const before = getRun(fx.db, RUN)!;
    fx.fake.restartServer(); // panes/agents die; Herdr session restore brings worktrees back

    const engine2 = engineFor(fx);
    // stop before cleanup nulls the run-level mapping
    await tickUntil(engine2, fx, () => getRun(fx.db, RUN)!.finalVerified === true);
    const verified = getRun(fx.db, RUN)!;
    expect(verified.integrationWorkspaceId).toBe(before.integrationWorkspaceId); // reconfirmed, not rebuilt
    expect(verified.integrationPath).toBe(before.integrationPath);
    expect(verified.integrationBaseSha).toBe(before.integrationBaseSha);
    const { listVerifications } = await import('../src/store/verifications.ts');
    const final = listVerifications(fx.db, RUN).filter((r) => r.kind === 'final');
    expect(final).toHaveLength(1);
    expect(final[0]!.detail!.baseSha).toBe(before.integrationBaseSha);
    await tickUntil(engine2, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));
    expect(getRun(fx.db, RUN)!.status).toBe('done');
  }, 60_000);

  test('R2-13: the run entry refuses when an agent integration the contract needs is missing', async () => {
    const fx = track(await makeFixture(happyScripts()));
    seedRun(fx);
    const env = envFor(fx);
    const { probeAgentsOrFailFast } = await import('../src/commands/run-shared.ts');
    const { DoctorError } = await import('../src/core/errors.ts');
    // contract needs claude (worker/integrator) AND codex (cross-kind reviewer)
    await expect(probeAgentsOrFailFast(env, async (kind) => ({
      name: `agent.${kind}`,
      ok: kind !== 'codex',
      detail: kind === 'codex' ? 'codex CLI not runnable (exit 127)' : kind,
      remediation: kind === 'codex' ? 'install the codex CLI' : undefined,
    }))).rejects.toThrow(DoctorError);
    await expect(probeAgentsOrFailFast(env, async (kind) => ({
      name: `agent.${kind}`,
      ok: true,
      detail: kind,
    }))).resolves.toBeUndefined();
  });

  test('R2-08: reconcile --dry-run does not apply a persisted result', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5 },
      [vName('API')]: reviewerScript(approvedReview(['src/api/x.ts'])),
    }));
    seedRun(fx);
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const scheduled = getTask(fx.db, RUN, 'API')!;
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: scheduled, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    // the worker delivers a valid result, then its pane vanishes
    await fx.fake.performAction(wName('API'), {
      editFiles: [['src/api/x.ts', 'export const a = 1;\n']],
      writeResultFile: workerOk('src/api/x.ts', 'export const a = 1;\n', 'done'),
    });
    const exec = listExecutions(fx.db, RUN).find((e) => e.agentName === wName('API'))!;
    fx.fake.dropPane(exec.paneId!);

    const engine = engineFor(fx);
    const dry = await engine.reconcileOnce({ dryRun: true });
    expect(dry.some((d) => d.kind === 'result_recovered')).toBe(true); // WOULD recover
    // ...but nothing was applied: the task is untouched, no reviewer exists
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('running');
    expect(listExecutions(fx.db, RUN).filter((e) => e.role === 'reviewer')).toHaveLength(0);
    const unchanged = listExecutions(fx.db, RUN).find((e) => e.id === exec.id)!;
    expect(unchanged.resultAppliedDigest).toBeNull();
    expect(unchanged.status).not.toBe('abandoned');

    // the real pass applies it
    await engine.reconcileOnce({});
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('reviewing');
  }, 30_000);

  test('R4-01: content appearing in the worktree after verification re-enters the worker gate instead of being approved', async () => {
    const injectedReview = {
      ...approvedReview(['src/api/x.ts']),
      summary: 'lgtm (but I also touched a file — reviewers must not)',
    };
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'v2 after drift\n'], workerOk('src/api/x.ts', 'v2 after drift\n', 'redo')),
      // the reviewer approving AND leaving uncommitted delivery content in
      // the same worktree: exactly the post-verification change R4-01 forbids
      [vName('API')]: {
        kind: 'codex',
        sequence: ['working', 'done'],
        stepMs: 5,
        onState: {
          done: {
            editFiles: [['src/api/injected.ts', 'tampered after the gate ran\n']],
            writeResultFile: injectedReview,
          },
        },
      },
      [vName('API', 2)]: reviewerScript(approvedReview(['src/api/x.ts'])),
    }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));

    // the drift was caught: the approval was demoted to a re-verification
    const { listEvents } = await import('../src/store/events.ts');
    const decisions = listEvents(fx.db, RUN).filter((e) => e.eventType === 'RECONCILE_DECISION')
      .filter((e) => (e.payload as { reason?: string }).reason === 'worktree_drifted_after_verification');
    expect(decisions.some((e) => e.taskId === 'API')).toBe(true);
    // exactly ONE TASK_APPROVED: the first verdict was demoted, the second earned it
    expect(listEvents(fx.db, RUN).filter((e) => e.eventType === 'TASK_APPROVED' && e.taskId === 'API')).toHaveLength(1);
    // the delivery went through the FULL cycle again: worker attempt 2 +
    // review cycle 2, and only then integration
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'worker')).toHaveLength(2);
    expect(listExecutions(fx.db, RUN).filter((e) => e.taskId === 'API' && e.role === 'reviewer')).toHaveLength(2);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('reclaimed');
    expect(getRun(fx.db, RUN)!.status).toBe('done');
  }, 30_000);

  test('R4-01: a task worktree whose HEAD moved past the verified commit is re-verified before integration', async () => {
    const fx = track(await makeFixture({
      ...happyScripts(),
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'v2 redo\n'], workerOk('src/api/x.ts', 'v2 redo\n', 'redo')),
      // the reviewer pauses before delivering: its approval is injected manually
      [vName('API')]: { kind: 'codex', sequence: ['working', 'done'], stepMs: 5, pauseAt: 'working', onState: { done: { writeResultFile: approvedReview(['src/api/x.ts']) } } },
    }));
    seedRun(fx);
    // drive the delivery chain to 'reviewing' with a REAL verified commit
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => {
      const t = getTask(fx.db, RUN, 'API')!;
      return t.status === 'reviewing' && !!t.commitSha;
    }, 2000);
    const apiTask = getTask(fx.db, RUN, 'API')!;
    // a same-worktree process commits AFTER the gate verified commitSha
    const { writeFile } = await import('node:fs/promises');
    const { stageAll, commit } = await import('../src/core/git.ts');
    await writeFile(`${apiTask.worktreePath}/src/api/late.ts`, 'committed after verification\n', 'utf8');
    await stageAll(apiTask.worktreePath!);
    await commit(apiTask.worktreePath!, 'post-verification commit');

    // the (now drifted) delivery is approved: the verdict must be demoted —
    // integration never sees the post-verification commit
    await fx.fake.performAction(vName('API'), { writeResultFile: approvedReview(['src/api/x.ts']) });
    await tickUntil(engine, fx, () => getTask(fx.db, RUN, 'API')!.attempts >= 2);
    const { listEvents } = await import('../src/store/events.ts');
    const decisions = listEvents(fx.db, RUN).filter((e) => e.eventType === 'RECONCILE_DECISION')
      .filter((e) => (e.payload as { reason?: string }).reason === 'worktree_drifted_after_verification');
    expect(decisions.some((e) => e.taskId === 'API')).toBe(true);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('running'); // fresh worker attempt owns the tree again
  }, 30_000);

  test('R5-01/R6-04: a verification command cannot smuggle content past the stage-first gate', async () => {
    const fx = track(await makeFixture({
      // the worker delivers a legal result AND plants smuggled.txt, which
      // .gitignore keeps OUT of the stage-first pin; the "verification
      // command" then tries to force-stage it mid-gate. R6-04: the command
      // runs in the isolated gate tree, where the never-staged smuggled.txt
      // does not exist — the smuggle fails and the gate refuses.
      [wName('API')]: {
        kind: 'claude', sequence: ['working', 'done'], stepMs: 5,
        onState: {
          done: {
            editFiles: [
              ['src/api/x.ts', 'export const a = 1;\n'],
              ['.gitignore', 'smuggled.txt\n'],
              ['smuggled.txt', 'never verified\n'],
            ],
            writeResultFile: workerOk('src/api/x.ts', 'export const a = 1;\n', 'api done'),
          },
        },
      },
    }, { defaults: { maxWorkerAttempts: 1, maxParallel: 1 } }));
    fx.contract = validateContract(minimalContract({
      project: { id: 'demo', repoRoot: fx.repoRoot, baseRef: 'main' },
      tasks: [{ id: 'API', title: 'api', allowedPaths: ['src/api/**'], verificationCommands: ['git add -f smuggled.txt'] }],
    }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));

    expect(getTask(fx.db, RUN, 'API')!.status).toBe('failed'); // gate refused → attempts exhausted
    const { listVerifications } = await import('../src/store/verifications.ts');
    const gate = listVerifications(fx.db, RUN).find((v) => v.kind === 'task');
    expect(gate!.ok).toBe(false);
    // the smuggle command failed inside the isolated tree: no commit landed
    expect(gate!.detail!.commands?.[0]?.ok).toBe(false);
    expect(getTask(fx.db, RUN, 'API')!.commitSha).toBeNull();
  }, 30_000);

  test('R5-01: worker edits landing after the gate never ride the delivery commit', async () => {
    const fx = track(await makeFixture({
      // both agents pause: the test injects the result, then the late edit,
      // then the approval — deterministic ordering, no races
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5, pauseAt: 'working' },
      [vName('API')]: { kind: 'codex', sequence: ['working', 'done'], stepMs: 5, pauseAt: 'working', onState: { done: { writeResultFile: approvedReview(['src/api/x.ts']) } } },
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'v2 redo\n'], workerOk('src/api/x.ts', 'v2 redo\n', 'redo')),
      [vName('API', 2)]: reviewerScript(approvedReview(['src/api/x.ts'])),
    }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => fx.fake.agentState(wName('API')) === 'working');

    // the worker delivers its legal result; the gate stages + verifies + commits
    await fx.fake.performAction(wName('API'), {
      editFiles: [['src/api/x.ts', 'export const a = 1;\n']],
      writeResultFile: workerOk('src/api/x.ts', 'export const a = 1;\n', 'api done'),
    });
    await tickUntil(engine, fx, () => {
      const t = getTask(fx.db, RUN, 'API')!;
      return t.status === 'reviewing' && !!t.commitSha;
    });
    const commitSha = getTask(fx.db, RUN, 'API')!.commitSha!;

    // a same-worktree process keeps editing AFTER the commit — unstaged,
    // never verified (the worker pane is already closed; this is the R5-01
    // window the commit pin plus drift detection must close)
    const { writeFile } = await import('node:fs/promises');
    const apiWorktree = getTask(fx.db, RUN, 'API')!.worktreePath!;
    await writeFile(join(apiWorktree, 'src/api/late.ts'), 'late\n', 'utf8');

    // the commit content is exactly the verified staged set — no late.ts
    const show = Bun.spawn(['git', '-C', getTask(fx.db, RUN, 'API')!.worktreePath!, 'show', '--name-only', '--format=', commitSha], {
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const files = (await new Response(show.stdout).text()).split('\n').map((l) => l.trim()).filter(Boolean);
    expect(files).toContain('src/api/x.ts');
    expect(files).not.toContain('src/api/late.ts');

    // and the leftover late.ts is drift: the approval is demoted, the task
    // re-enters the worker gate (R4-01 handling on top of the pinned commit)
    await fx.fake.performAction(vName('API'), { writeResultFile: approvedReview(['src/api/x.ts']) });
    await tickUntil(engine, fx, () => getTask(fx.db, RUN, 'API')!.attempts >= 2);
    const { listEvents } = await import('../src/store/events.ts');
    expect(listEvents(fx.db, RUN).some((e) =>
      e.eventType === 'RECONCILE_DECISION'
      && e.taskId === 'API'
      && (e.payload as { reason?: string }).reason === 'worktree_drifted_after_verification',
    )).toBe(true);
  }, 30_000);

  test('R5-03: a dirty integration tree fails the final gate instead of passing over uncommitted content', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const { currentHead } = await import('../src/core/git.ts');
    // settle EVERY task as integrated (a pending task would be scheduled and
    // blow up on the fake commit shas) with a real integration worktree
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/integration` });
    insertResource(fx.db, { runId: RUN, kind: 'workspace', herdrId: ws.workspace.workspaceId, branch: ws.worktree.branch, path: ws.worktree.path });
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?, start_sha='s0',
       commit_sha='c1', integration_commit=? WHERE run_id=?`,
      [ws.worktree.branch, ws.worktree.path, ws.workspace.workspaceId, await currentHead(fx.repoRoot), RUN],
    );
    fx.db.run('UPDATE runs SET integration_path=?, integration_workspace_id=?, integration_branch=?, integration_base_sha=? WHERE id=?', [
      ws.worktree.path, ws.workspace.workspaceId, ws.worktree.branch, await currentHead(ws.worktree.path), RUN,
    ]);

    // uncommitted content sits in the integration tree BEFORE the gate
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(ws.worktree.path, 'uncommitted.txt'), 'never committed\n', 'utf8');

    const engine = engineFor(fx);
    await engine.tickOnce(); // maybeIntegrate → finalVerification

    // the gate REFUSED the dirty tree: no final flag, a persisted FAILING
    // record naming the dirt, and the run carries the attention error
    expect(getRun(fx.db, RUN)!.finalVerified).toBe(false);
    expect(getRun(fx.db, RUN)!.error).toMatch(/integration final verification failed/);
    const { latestVerification } = await import('../src/store/verifications.ts');
    const final = latestVerification(fx.db, RUN, 'final')!;
    expect(final.ok).toBe(false);
    expect((final.detail!.violations ?? []).some((v) => v.includes('not clean before verification'))).toBe(true);
    expect((final.detail!.violations ?? []).some((v) => v.includes('uncommitted.txt'))).toBe(true);
    // the stale PASS never existed, so nothing was reclaimed either
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated');
  }, 30_000);

  test('R4-04: a failed dependency never schedules downstream — the pending task records why', async () => {
    const workerFail = (why: string) => ({
      status: 'failed', summary: 'gave up', testsRun: [], knownRisks: [], changedPaths: [], blockedReason: why,
    });
    const fx = track(await makeFixture({
      [wName('API')]: workerScript(['src/api/x.ts', 'v1\n'], workerFail('cannot do it')),
      [wName('API', 2)]: workerScript(['src/api/x.ts', 'v2\n'], workerFail('still cannot')),
      [wName('API', 3)]: workerScript(['src/api/x.ts', 'v3\n'], workerFail('hopeless')),
      // DOCS must NEVER run — give it a script whose side effect is observable
      [wName('DOCS')]: workerScript(['docs/z.md', '# should never exist\n'], workerOk('docs/z.md', '# docs\n', 'docs')),
    }));
    seedRun(fx);
    const engine = engineFor(fx);
    await tickUntil(engine, fx, () => TERMINALS.includes(getRun(fx.db, RUN)!.status));

    expect(getRun(fx.db, RUN)!.status).toBe('failed');
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('failed');
    const docs = getTask(fx.db, RUN, 'DOCS')!;
    expect(docs.status).toBe('pending'); // never started…
    expect(docs.attempts).toBe(0);
    expect(docs.lastError).toMatch(/dependency API failed/);
    expect(listExecutions(fx.db, RUN).some((e) => e.taskId === 'DOCS')).toBe(false); // …and no execution exists
  }, 30_000);

  test('R4-05: reconcile carries the fencing token — a writer that lost the lease stops mid-pass', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    const { insertVerification } = await import('../src/store/verifications.ts');
    insertVerification(fx.db, { runId: RUN, kind: 'final', ok: true, detail: { contractRevision: 1, integratedCommits: { API: 'i1' } } });
    fx.db.run('UPDATE runs SET final_verified=1 WHERE id=?', [RUN]);

    // the pass's FIRST snapshot is where a second writer steals the lease
    const fence = acquireLease(fx.db, RUN)!;
    const stealing = Object.create(fx.fake) as FakeHerdrClient;
    stealing.snapshot = async () => {
      fx.db.run('UPDATE runner_leases SET heartbeat_at = ? WHERE run_id = ?', [new Date(Date.now() - 60_000).toISOString(), RUN]);
      expect(acquireLease(fx.db, RUN)).not.toBeNull(); // the second writer takes over
      return fx.fake.snapshot();
    };
    const env = { ...envFor(fx), client: stealing as HerdrRuntimeClient };
    const engine = new RunnerEngine(env, { leaseFence: fence });

    await expect(engine.reconcileOnce({})).rejects.toThrow(/lease lost/);
    // the destruction never finalized: task not reclaimed, branch intact
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated');
    const { branchExists } = await import('../src/core/git.ts');
    expect(await branchExists(fx.repoRoot, `ateam/${RUN}/task/API`)).toBe(true);
  }, 30_000);

  test('R4-05: clean renews the fence between teardown steps and aborts when it is lost', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    const { insertVerification } = await import('../src/store/verifications.ts');
    insertVerification(fx.db, { runId: RUN, kind: 'final', ok: true, detail: { contractRevision: 1, integratedCommits: { API: 'i1' } } });
    fx.db.run("UPDATE runs SET status='needs_attention', final_verified=1 WHERE id=?", [RUN]);

    const stealing = Object.create(fx.fake) as FakeHerdrClient;
    stealing.snapshot = async () => {
      fx.db.run('UPDATE runner_leases SET heartbeat_at = ? WHERE run_id = ?', [new Date(Date.now() - 60_000).toISOString(), RUN]);
      expect(acquireLease(fx.db, RUN)).not.toBeNull();
      return fx.fake.snapshot();
    };
    const { cmdClean } = await import('../src/commands/clean.ts');
    await expect(cmdClean({ runId: RUN, home: fx.home, json: false, client: stealing as HerdrRuntimeClient }))
      .rejects.toThrow(/lease.*lost|lost.*lease/i);
    // the abort preserved the resumable state: no termination, no branch deletion
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated');
    const { branchExists } = await import('../src/core/git.ts');
    expect(await branchExists(fx.repoRoot, `ateam/${RUN}/task/API`)).toBe(true);
    expect(TERMINALS).not.toContain(getRun(fx.db, RUN)!.status);
  }, 30_000);

  test('R5-02: deletion gate refuses a snapshot with no worktree mapping and an id this run cannot prove', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    const { insertVerification } = await import('../src/store/verifications.ts');
    insertVerification(fx.db, { runId: RUN, kind: 'final', ok: true, detail: { contractRevision: 1, integratedCommits: { API: 'i1' } } });
    fx.db.run('UPDATE runs SET final_verified=1 WHERE id=?', [RUN]);

    // herdr restarted and the reused id now maps to a workspace it describes
    // WITHOUT a worktree record — no identity evidence, no force removal
    const doctored = Object.create(fx.fake) as FakeHerdrClient;
    doctored.snapshot = async () => {
      const snap = await fx.fake.snapshot();
      return {
        ...snap,
        workspaces: snap.workspaces.map((w) =>
          w.workspaceId === ws.workspace.workspaceId ? { workspaceId: w.workspaceId, label: w.label, cwd: w.cwd } : w,
        ),
      };
    };
    const env = { ...envFor(fx), client: doctored as HerdrRuntimeClient };
    const { cleanupTaskResources } = await import('../src/runner/cleanup.ts');
    const outcome = await cleanupTaskResources(env, getTask(fx.db, RUN, 'API')!);
    expect(outcome).toBeNull();
    expect(latestCleanupStepStatus(fx, 'remove_worktree')).toBe('failed');
    expect(fx.fake.worktreeOf(ws.workspace.workspaceId)).not.toBeNull(); // foreign workspace survived

    // no ledger row in THIS run at all (and none in another run): equally
    // unprovable — refused even though the snapshot "matches" nothing
    fx.db.run('DELETE FROM herdr_resources WHERE run_id=? AND herdr_id=?', [RUN, ws.workspace.workspaceId]);
    const outcome2 = await cleanupTaskResources(envFor(fx), getTask(fx.db, RUN, 'API')!);
    expect(outcome2).toBeNull();
    expect(fx.fake.worktreeOf(ws.workspace.workspaceId)).not.toBeNull();
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated');
  }, 30_000);

  test('R6-01: a same-run id reuse onto the integration ledger row cannot authorize a task deletion', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    const wsId = ws.workspace.workspaceId;
    const { assertRemovableWorkspace } = await import('../src/runner/cleanup.ts');
    const env = envFor(fx);

    // sanity: the genuine task generation is removable in principle (the
    // snapshot matches the ledger)
    await assertRemovableWorkspace(env, wsId, { taskId: 'API' });

    // herdr restart reuses the SAME id for the run's INTEGRATION workspace:
    // insertResource's UPSERT re-ledgers the row to the integration
    // generation (taskId=null, integration path/branch)
    const integ = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/integration` });
    insertResource(fx.db, {
      runId: RUN, kind: 'workspace', herdrId: wsId,
      branch: `ateam/${RUN}/integration`, path: integ.worktree.path,
    });
    // the review-06 repro: the stale task cleanup must NOT be authorized by
    // the reused id — a taskId-less row is the integration's, not the task's
    await expect(assertRemovableWorkspace(env, wsId, { taskId: 'API' })).rejects.toThrow(/integration/);

    // the mirror: an integration removal may not use a TASK-generation row
    fx.db.run('DELETE FROM herdr_resources WHERE run_id=? AND herdr_id=?', [RUN, wsId]);
    insertWorkspaceLedger(fx, ws); // re-ledger to the task generation
    await expect(assertRemovableWorkspace(env, wsId)).rejects.toThrow(/task API/);
  }, 30_000);

  test('R5-04: a fence lost DURING remove_worktree records nothing — the new owner re-runs the step', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    const { insertVerification } = await import('../src/store/verifications.ts');
    insertVerification(fx.db, { runId: RUN, kind: 'final', ok: true, detail: { contractRevision: 1, integratedCommits: { API: 'i1' } } });
    fx.db.run('UPDATE runs SET final_verified=1 WHERE id=?', [RUN]);

    // the removal SUCCEEDS, but the lease is stolen while it runs — the old
    // writer must record neither ok nor failed, and must not conclude anything
    const fence = acquireLease(fx.db, RUN)!;
    const stealing = Object.create(fx.fake) as FakeHerdrClient;
    stealing.removeWorktree = async (input: { workspaceId: string; force?: boolean }) => {
      fx.db.run('UPDATE runner_leases SET heartbeat_at = ? WHERE run_id = ?', [new Date(Date.now() - 60_000).toISOString(), RUN]);
      expect(acquireLease(fx.db, RUN)).not.toBeNull();
      return fx.fake.removeWorktree(input);
    };
    const env = { ...envFor(fx), client: stealing as HerdrRuntimeClient };
    const { cleanupTaskResources } = await import('../src/runner/cleanup.ts');
    const { LeaseLostError } = await import('../src/core/errors.ts');
    await expect(cleanupTaskResources(env, getTask(fx.db, RUN, 'API')!, {
      ensureLease: () => {
        if (!heartbeat(fx.db, RUN, fence)) throw new LeaseLostError('runner lease lost mid-clean');
      },
    })).rejects.toThrow(LeaseLostError);

    // the irreversible op DID happen, but nothing was concluded on it
    expect(fx.fake.worktreeOf(ws.workspace.workspaceId)).toBeNull();
    expect(latestCleanupSteps(fx.db, RUN, 'API').get('remove_worktree')).toBeUndefined();
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated');
    const { getResourceForRun } = await import('../src/store/resources.ts');
    expect(getResourceForRun(fx.db, RUN, 'workspace', ws.workspace.workspaceId)!.state).toBe('active');

    // the new owner re-runs the sweep: the already-removed worktree is the
    // postcondition, the step completes idempotently
    const outcome = await cleanupTaskResources(envFor(fx), getTask(fx.db, RUN, 'API')!, {
      ensureLease: () => {},
    });
    expect(outcome).toBe('reclaimed');
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('reclaimed');
  }, 30_000);

  test('R6-06: a fence lost during a FAILING teardown records no failed audit — the new owner re-runs it', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    const { insertVerification } = await import('../src/store/verifications.ts');
    insertVerification(fx.db, { runId: RUN, kind: 'final', ok: true, detail: { contractRevision: 1, integratedCommits: { API: 'i1' } } });
    fx.db.run('UPDATE runs SET final_verified=1 WHERE id=?', [RUN]);

    // the removal FAILS, and the lease is stolen while it runs — the old
    // writer must record neither ok NOR failed: the failure conclusion is
    // audited too, and a dispossessed writer writes none
    const fence = acquireLease(fx.db, RUN)!;
    const failing = Object.create(fx.fake) as FakeHerdrClient;
    failing.removeWorktree = async (input: { workspaceId: string; force?: boolean }) => {
      fx.db.run('UPDATE runner_leases SET heartbeat_at = ? WHERE run_id = ?', [new Date(Date.now() - 60_000).toISOString(), RUN]);
      expect(acquireLease(fx.db, RUN)).not.toBeNull();
      throw new HerdrError('herdr_error', 'simulated removal failure');
    };
    const env = { ...envFor(fx), client: failing as HerdrRuntimeClient };
    const { cleanupTaskResources } = await import('../src/runner/cleanup.ts');
    const { LeaseLostError } = await import('../src/core/errors.ts');
    await expect(cleanupTaskResources(env, getTask(fx.db, RUN, 'API')!, {
      ensureLease: () => {
        if (!heartbeat(fx.db, RUN, fence)) throw new LeaseLostError('runner lease lost mid-clean');
      },
    })).rejects.toThrow(LeaseLostError);

    // nothing was concluded on the step — no ok, and crucially no FAILED row
    expect(latestCleanupSteps(fx.db, RUN, 'API').get('remove_worktree')).toBeUndefined();
    const { listEvents } = await import('../src/store/events.ts');
    expect(listEvents(fx.db, RUN).some((e) =>
      e.eventType === 'CLEANUP_STEP_FAILED' && (e.payload as { step?: string }).step === 'remove_worktree',
    )).toBe(false);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('integrated');

    // the new owner re-runs the sweep and completes it
    const outcome = await cleanupTaskResources(envFor(fx), getTask(fx.db, RUN, 'API')!, {
      ensureLease: () => {},
    });
    expect(outcome).toBe('reclaimed');
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('reclaimed');
  }, 30_000);

  test('R6-05: --discard-work abandons live executions BEFORE destroying their resources, then terminates', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5, pauseAt: 'working' },
    }));
    seedRun(fx);
    // a live worker execution (dispatched, paused mid-work) on a running task
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: getTask(fx.db, RUN, 'API')!, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const workspaceId = getTask(fx.db, RUN, 'API')!.workspaceId!;

    const { cmdClean } = await import('../src/commands/clean.ts');
    // the review-06 failure mode was: resources destroyed, execution still
    // active, run left "resumable", next reconcile rebuilding the discarded
    // work. Now the control state is settled BEFORE the sweep and the run
    // can terminate in the same pass.
    expect(await cmdClean({ runId: RUN, home: fx.home, json: true, client: fx.fake, discardWork: true })).toBe(0);

    expect(getTask(fx.db, RUN, 'API')!.status).toBe('discarded');
    const { listExecutions } = await import('../src/store/executions.ts');
    const execs = listExecutions(fx.db, RUN);
    expect(execs.every((e) => !['starting', 'running', 'blocked', 'result_pending'].includes(e.status))).toBe(true);
    // the abandon was audited BEFORE the workspace removal retired the pane
    const { listEvents } = await import('../src/store/events.ts');
    expect(listEvents(fx.db, RUN).some((e) =>
      e.eventType === 'RECONCILE_DECISION'
      && (e.payload as { reason?: string }).reason === 'execution_abandoned_for_discard',
    )).toBe(true);
    expect(listEvents(fx.db, RUN).some((e) =>
      e.eventType === 'RECONCILE_DECISION'
      && (e.payload as { reason?: string }).reason === 'pane_retired_by_workspace_removal',
    )).toBe(true);
    expect(fx.fake.worktreeOf(workspaceId)).toBeNull();
    expect(getRun(fx.db, RUN)!.status).toBe('abandoned');
  }, 30_000);

  test('R6-05: reconcile refuses to rebuild a lost pane for a discarded task', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    // every task settled (discarded) — the schedule pass has nothing to start
    fx.db.run(
      "UPDATE tasks SET status='discarded', pending_dispatch=NULL, worktree_path=NULL, branch=NULL, workspace_id=NULL WHERE run_id=?",
      [RUN],
    );
    // a stray execution still active on the discarded task, its pane gone
    const { insertExecution } = await import('../src/store/executions.ts');
    insertExecution(fx.db, {
      id: `${RUN}-API-w-ghost`, runId: RUN, taskId: 'API', role: 'worker', attemptNo: 1, cycleNo: 0,
      agentName: wName('API'), agentKind: 'claude', model: null, status: 'running',
      promptSentAt: new Date().toISOString(), promptDigest: 'd0', startFailed: false,
      resultPath: null, resultDigest: null, resultAppliedDigest: null, result: null,
      resultReceivedAt: null, nativeSessionRef: null, paneId: 'w0:p-ghost',
      tabId: null, workspaceId: null, paneState: 'open',
      lastAgentState: null, startedAt: new Date().toISOString(), finishedAt: null,
    });

    const engine = engineFor(fx);
    const decisions = await engine.reconcileOnce({});
    expect(decisions.some((d) =>
      d.kind === 'pane_lost_no_attempt' && d.executionId === `${RUN}-API-w-ghost`
      && d.detail?.includes('recovery refused'),
    )).toBe(true);
    // no attempt was built for the settled task: no new worker execution, no
    // rebuilt worktree, task stays discarded
    expect(listExecutions(fx.db, RUN).filter((e) => e.role === 'worker')).toHaveLength(1);
    expect(getTask(fx.db, RUN, 'API')!.attempts).toBe(0);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('discarded');
  }, 30_000);

  test('R7-03: a failed discard leaves a durable intent — the runner/reconcile finish the sweep', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5, pauseAt: 'working' },
    }));
    seedRun(fx);
    // WEB/DOCS settled so the schedule pass has nothing else to start
    fx.db.run("UPDATE tasks SET status='discarded' WHERE task_id IN ('WEB','DOCS')");
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: getTask(fx.db, RUN, 'API')!, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });
    const workspaceId = getTask(fx.db, RUN, 'API')!.workspaceId!;

    // the review-07 window: the runtime is unreachable, so clean's sweep
    // cannot prove the workspace identity — destruction never happens
    const offline = stubClient({ snapshot: () => Promise.reject(new Error('offline')) });
    const { cmdClean } = await import('../src/commands/clean.ts');
    expect(await cmdClean({ runId: RUN, home: fx.home, json: true, client: offline, discardWork: true })).toBe(1);

    // control state IS settled (no active execution) and the run stays
    // resumable — but now the discard intent is durable on the task row
    const { listActiveExecutions } = await import('../src/store/executions.ts');
    expect(listActiveExecutions(fx.db, RUN)).toHaveLength(0);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('running');
    expect(getTask(fx.db, RUN, 'API')!.pendingDispatch).toBe('discard');

    // a PLAIN runner tick (no --discard-work anywhere) resumes the intent
    await engineFor(fx).tickOnce();
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('discarded');
    expect(getTask(fx.db, RUN, 'API')!.pendingDispatch).toBeNull();
    expect(fx.fake.worktreeOf(workspaceId)).toBeNull();
  }, 30_000);

  test('R7-03: reconcile resumes a persisted discard intent for an unverified integrated task', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    // every task settled as discarded so nothing else is schedulable; one
    // integrated-but-unverified task carries the operator's discard intent
    // (clean --discard-work died before its sweep could run)
    fx.db.run("UPDATE tasks SET status='discarded', worktree_path=NULL, branch=NULL, workspace_id=NULL WHERE task_id IN ('WEB','DOCS')");
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    fx.db.run(
      `UPDATE tasks SET status='integrated', pending_dispatch='discard', branch=?, worktree_path=?, workspace_id=?
       WHERE run_id=? AND task_id='API'`,
      [ws.worktree.branch, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );

    const decisions = await engineFor(fx).reconcileOnce({});
    expect(decisions.some((d) => d.kind === 'cleanup_resumed' && d.taskId === 'API' && d.detail === 'discard intent resumed')).toBe(true);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('discarded');
    expect(getTask(fx.db, RUN, 'API')!.pendingDispatch).toBeNull();
    expect(fx.fake.worktreeOf(ws.workspace.workspaceId)).toBeNull();
  }, 30_000);

  test('R7-04: clean disposes of the integration workspace before terminating', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    // every task reclaimed; the run still holds its integration workspace
    const handle = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/integration` });
    insertResource(fx.db, {
      runId: RUN, kind: 'workspace', herdrId: handle.workspace.workspaceId,
      branch: handle.worktree.branch, path: handle.worktree.path,
    });
    fx.db.run(
      'UPDATE runs SET integration_workspace_id=?, integration_path=?, integration_branch=?, status=? WHERE id=?',
      [handle.workspace.workspaceId, handle.worktree.path, handle.worktree.branch, 'integrating', RUN],
    );
    fx.db.run("UPDATE tasks SET status='reclaimed', pending_dispatch=NULL WHERE run_id=?", [RUN]);

    const { cmdClean } = await import('../src/commands/clean.ts');
    expect(await cmdClean({ runId: RUN, home: fx.home, json: true, client: fx.fake })).toBe(0);
    const run = getRun(fx.db, RUN)!;
    expect(run.status).toBe('abandoned');
    expect(run.integrationWorkspaceId).toBeNull();
    expect(run.integrationPath).toBeNull();
    expect(fx.fake.worktreeOf(handle.workspace.workspaceId)).toBeNull();
    const { getResourceForRun } = await import('../src/store/resources.ts');
    expect(getResourceForRun(fx.db, RUN, 'workspace', handle.workspace.workspaceId)!.state).toBe('reclaimed');
  }, 30_000);

  test('R7-04: clean refuses to terminate a run whose integration workspace cannot be removed', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const handle = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/integration` });
    insertResource(fx.db, {
      runId: RUN, kind: 'workspace', herdrId: handle.workspace.workspaceId,
      branch: handle.worktree.branch, path: handle.worktree.path,
    });
    fx.db.run(
      'UPDATE runs SET integration_workspace_id=?, integration_path=?, integration_branch=?, status=? WHERE id=?',
      [handle.workspace.workspaceId, handle.worktree.path, handle.worktree.branch, 'integrating', RUN],
    );
    fx.db.run("UPDATE tasks SET status='reclaimed', pending_dispatch=NULL WHERE run_id=?", [RUN]);

    // the runtime is unreachable — the identity cannot be proven, so the
    // workspace must NOT be orphaned by terminating the run
    const offline = stubClient({ snapshot: () => Promise.reject(new Error('offline')) });
    const { cmdClean } = await import('../src/commands/clean.ts');
    expect(await cmdClean({ runId: RUN, home: fx.home, json: true, client: offline })).toBe(1);
    const run = getRun(fx.db, RUN)!;
    expect(TERMINALS).not.toContain(run.status);
    expect(run.integrationWorkspaceId).not.toBeNull();
    expect(fx.fake.worktreeOf(handle.workspace.workspaceId)).not.toBeNull();
  }, 30_000);

  test('R5-02: a resource judged lost that the snapshot shows alive again is re-activated', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    const { markResourceState } = await import('../src/store/resources.ts');
    markResourceState(fx.db, RUN, 'workspace', ws.workspace.workspaceId, 'lost');

    const engine = engineFor(fx);
    await engine.reconcileOnce({});

    const { getResourceForRun } = await import('../src/store/resources.ts');
    expect(getResourceForRun(fx.db, RUN, 'workspace', ws.workspace.workspaceId)!.state).toBe('active');
    const { listEvents } = await import('../src/store/events.ts');
    expect(listEvents(fx.db, RUN).some((e) =>
      e.eventType === 'RECONCILE_DECISION' && (e.payload as { reason?: string }).reason === 'resource_reactivated',
    )).toBe(true);
  });

  test('R4-07: clean does not terminate a run with live executions', async () => {
    const fx = track(await makeFixture({
      [wName('API')]: { kind: 'claude', sequence: ['working', 'done'], stepMs: 5, pauseAt: 'working' },
    }));
    seedRun(fx);
    // a live worker execution (dispatched, paused mid-work)
    fx.db.run("UPDATE tasks SET status='running', attempts=1 WHERE run_id=? AND task_id='API'", [RUN]);
    const { startExecution } = await import('../src/runner/executions.ts');
    await startExecution(envFor(fx), { role: 'worker', task: getTask(fx.db, RUN, 'API')!, attemptNo: 1, cycleNo: 0, entry: { kind: 'claude' } });

    const { cmdClean } = await import('../src/commands/clean.ts');
    expect(await cmdClean({ runId: RUN, home: fx.home, json: true, client: fx.fake })).toBe(1);
    // R4-07: agents may still be writing — the run stays resumable, NOT abandoned
    expect(getRun(fx.db, RUN)!.status).toBe('planned');

    // once no execution is active, the in-flight task (status 'running', the
    // R5-05 unsettled case) can only be settled by an explicit audited
    // discard — plain clean still refuses to terminate
    const { listExecutions, updateExecution } = await import('../src/store/executions.ts');
    for (const exec of listExecutions(fx.db, RUN)) {
      updateExecution(fx.db, exec.id, { status: 'abandoned' });
    }
    expect(await cmdClean({ runId: RUN, home: fx.home, json: true, client: fx.fake })).toBe(1);
    expect(TERMINALS).not.toContain(getRun(fx.db, RUN)!.status);
    expect(await cmdClean({ runId: RUN, home: fx.home, json: true, client: fx.fake, discardWork: true })).toBe(0);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('discarded');
    expect(getRun(fx.db, RUN)!.status).toBe('abandoned');
  }, 30_000);

  test('pane-retirement policy: a retained (failed-attempt) pane is retired `gone` with an audit event when its workspace is reclaimed', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    // a failed worker attempt whose pane was kept for attach (R2-11) — the
    // delivery later succeeded via a fresh attempt, the pane is still here
    const { insertExecution } = await import('../src/store/executions.ts');
    insertExecution(fx.db, {
      id: `${RUN}-API-w-dead`, runId: RUN, taskId: 'API', role: 'worker', attemptNo: 1, cycleNo: 0,
      agentName: wName('API'), agentKind: 'claude', model: null, status: 'completed',
      promptSentAt: new Date().toISOString(), promptDigest: null, startFailed: false,
      resultPath: null, resultDigest: 'd0', resultAppliedDigest: 'd0', result: { status: 'failed' },
      resultReceivedAt: null, nativeSessionRef: null, paneId: `${ws.workspace.workspaceId}:p-dead`,
      tabId: null, workspaceId: ws.workspace.workspaceId, paneState: 'retained',
      lastAgentState: null, startedAt: new Date().toISOString(), finishedAt: null,
    });
    const { insertVerification } = await import('../src/store/verifications.ts');
    insertVerification(fx.db, { runId: RUN, kind: 'final', ok: true, detail: { contractRevision: 1, integratedCommits: { API: 'i1' } } });
    fx.db.run('UPDATE runs SET final_verified=1 WHERE id=?', [RUN]);

    const { cleanupTaskResources } = await import('../src/runner/cleanup.ts');
    const outcome = await cleanupTaskResources(envFor(fx), getTask(fx.db, RUN, 'API')!);
    expect(outcome).toBe('reclaimed');

    // the attach surface did not survive the workspace removal — recorded as
    // `gone` (never a success close) with one audit event naming why
    const { listExecutions } = await import('../src/store/executions.ts');
    expect(listExecutions(fx.db, RUN).find((e) => e.id === `${RUN}-API-w-dead`)!.paneState).toBe('gone');
    const { listEvents } = await import('../src/store/events.ts');
    const retired = listEvents(fx.db, RUN).filter((e) =>
      e.eventType === 'RECONCILE_DECISION'
      && (e.payload as { reason?: string }).reason === 'pane_retired_by_workspace_removal');
    expect(retired.some((e) => e.executionId === `${RUN}-API-w-dead`)).toBe(true);
    expect((retired[0]!.payload as { concludedSuccessfully?: boolean }).concludedSuccessfully).toBe(false);
  }, 30_000);

  test('R5-05: clean refuses to terminate a run whose dispatch intent never became an execution', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    // the crash window R5-05 closes: the worker result was consumed, the
    // task advanced to reviewing with a pending review dispatch — and no
    // execution is active. The old "no active executions" check would have
    // terminated the run here, stranding the review and the worktree.
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    insertWorkspaceLedger(fx, ws);
    fx.db.run(
      `UPDATE tasks SET status='reviewing', pending_dispatch='review', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit=NULL WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );

    const { cmdClean } = await import('../src/commands/clean.ts');
    expect(await cmdClean({ runId: RUN, home: fx.home, json: true, client: fx.fake })).toBe(1);
    // resumable: the run stays visible to the startup/reconcile path that
    // replays the dispatch intent
    expect(TERMINALS).not.toContain(getRun(fx.db, RUN)!.status);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('reviewing');
    expect((await fx.fake.snapshot()).workspaces.some((w) => w.workspaceId === ws.workspace.workspaceId)).toBe(true);
    const { branchExists } = await import('../src/core/git.ts');
    expect(await branchExists(fx.repoRoot, `ateam/${RUN}/task/API`)).toBe(true);

    // explicit operator abort: every non-reclaimed task is settled as an
    // audited discard, THEN the run may terminate
    expect(await cmdClean({ runId: RUN, home: fx.home, json: true, client: fx.fake, discardWork: true })).toBe(0);
    expect(getTask(fx.db, RUN, 'API')!.status).toBe('discarded');
    expect(getTask(fx.db, RUN, 'WEB')!.status).toBe('discarded');
    expect(getTask(fx.db, RUN, 'DOCS')!.status).toBe('discarded');
    expect(getRun(fx.db, RUN)!.status).toBe('abandoned');
    expect((await fx.fake.snapshot()).workspaces.filter((w) => w.workspaceId !== 'w0')).toHaveLength(0);
    expect(await branchExists(fx.repoRoot, `ateam/${RUN}/task/API`)).toBe(false);
  }, 30_000);

  test('R5-06: reconcile exit code distinguishes hard failures from deferrals', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    const { cmdReconcile } = await import('../src/commands/reconcile-cli.ts');
    const { RunnerEngine } = await import('../src/runner/engine.ts');
    const proto = RunnerEngine.prototype as unknown as { reconcileOnce: unknown };
    const original = proto.reconcileOnce;
    // a pass that aborts mid-way is a HARD failure: exit 1, never 0
    proto.reconcileOnce = async () => Promise.reject(new Error('pass exploded'));
    try {
      expect(await cmdReconcile({ runId: RUN, home: fx.home, json: true, dryRun: false, client: fx.fake })).toBe(1);
    } finally {
      proto.reconcileOnce = original;
    }
    // a runtime that cannot answer snapshot/subscribe DEFERS the judgments:
    // its own exit state (10), machine-readable in the JSON output
    const unavailable = stubClient({
      snapshot: () => Promise.reject(new Error('socket gone')),
      subscribe: () => Promise.reject(new Error('socket gone')),
    });
    expect(await cmdReconcile({ runId: RUN, home: fx.home, json: true, dryRun: false, client: unavailable as HerdrRuntimeClient })).toBe(10);
    // and a healthy pass with nothing to do is exit 0
    expect(await cmdReconcile({ runId: RUN, home: fx.home, json: true, dryRun: false, client: fx.fake })).toBe(0);
  }, 30_000);
});

  test('R7-06: a crash-left gate worktree is ledgered and reclaimed by the sweep', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    // simulate a crash AFTER createGateWorktree registered the checkout — no
    // finally ran; the ledger row is what makes this recoverable
    const { createGateWorktree } = await import('../src/core/git.ts');
    const orphan = await createGateWorktree(fx.repoRoot, await writeTree(fx.repoRoot));
    insertResource(fx.db, { runId: RUN, taskId: 'API', kind: 'gate-worktree', herdrId: orphan, path: orphan });
    expect(existsSync(orphan)).toBe(true);

    const { cleanupGateWorktrees } = await import('../src/runner/cleanup.ts');
    expect(await cleanupGateWorktrees(envFor(fx))).toBe(1);
    const { getResourceForRun } = await import('../src/store/resources.ts');
    expect(getResourceForRun(fx.db, RUN, 'gate-worktree', orphan)!.state).toBe('reclaimed');
    expect(existsSync(orphan)).toBe(false);
    // no stale registration remains in the repo
    const proc = Bun.spawn(['git', '-C', fx.repoRoot, 'worktree', 'list', '--porcelain'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    expect(await new Response(proc.stdout).text()).not.toContain('.gate-');
    // idempotent: a second sweep finds nothing to do
    expect(await cleanupGateWorktrees(envFor(fx))).toBe(0);

    // and a reconcile pass runs the sweep on its own
    const orphan2 = await createGateWorktree(fx.repoRoot, await writeTree(fx.repoRoot));
    insertResource(fx.db, { runId: RUN, taskId: 'API', kind: 'gate-worktree', herdrId: orphan2, path: orphan2 });
    const decisions = await engineFor(fx).reconcileOnce({});
    expect(decisions.some((d) => d.kind === 'cleanup_resumed' && d.detail === 'gate worktree sweep')).toBe(true);
    expect(getResourceForRun(fx.db, RUN, 'gate-worktree', orphan2)!.state).toBe('reclaimed');
    expect(existsSync(orphan2)).toBe(false);
  }, 30_000);

// Direct gate tests: a standalone repo + task record, no engine — the
// R6-02/R6-03/R6-04 delivery-boundary cases from review 06 and the
// R7-01/R7-02 commit/gate integrity cases from review 07.
describe('verification gate — R6/R7 path/content integrity', () => {
  interface GateRepo {
    root: string;
    base: string;
    stage: (files: Record<string, string>) => Promise<void>;
    write: (files: Record<string, string>) => Promise<void>;
    git: (...args: string[]) => Promise<string>;
  }

  async function makeGateRepo(): Promise<GateRepo> {
    const root = await makeTempDir('ateam-gate-');
    await initRepo(root);
    const git = async (...args: string[]): Promise<string> => {
      const proc = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
      const code = await proc.exited;
      const out = await new Response(proc.stdout).text();
      if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`);
      return out;
    };
    const write = async (files: Record<string, string>): Promise<void> => {
      for (const [name, content] of Object.entries(files)) await writeFileDeep(join(root, name), content);
    };
    const stage = async (files: Record<string, string>): Promise<void> => {
      await write(files);
      await git('add', '-f', ...Object.keys(files));
    };
    return { root, base: await currentHead(root), stage, write, git };
  }

  function gateTask(repo: GateRepo, spec: Partial<ExecutionContract['tasks'][number]> = {}): TaskRecord {
    return {
      runId: RUN,
      taskId: 'API',
      spec: {
        id: 'API',
        title: 'api',
        allowedPaths: ['allowed.txt'],
        verificationCommands: ['git rev-parse HEAD'],
        ...spec,
      },
      status: 'verifying',
      attempts: 1,
      reviewCycles: 0,
      branch: null,
      worktreePath: repo.root,
      workspaceId: null,
      startSha: repo.base,
      commitSha: null,
      integrationCommit: null,
      lastError: null,
      contractBlock: null,
      review: null,
      pendingDispatch: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
    };
  }

  test('R6-02: a staged rename fails the gate on its deleted SOURCE, not just its target', async () => {
    const repo = await makeGateRepo();
    try {
      await repo.stage({ 'protected.txt': 'keep me\n' });
      await repo.git('commit', '-m', 'protected');
      const base = await currentHead(repo.root);
      // the worker moves a committed file from outside its scope into the
      // allowed path
      await repo.git('mv', 'protected.txt', 'allowed.txt');
      const outcome = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo),
        allowlist: ['git *'],
        baseSha: base,
        staged: true,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.violations).toContain('protected.txt'); // the rename source is judged
      expect(outcome.diffFiles).toContain('allowed.txt'); // ...and the target still is
    } finally {
      await cleanupTempDir(repo.root);
    }
  });

  test('R6-03: .ateam content force-staged behind stageAll is refused and cleaned from the index', async () => {
    const repo = await makeGateRepo();
    try {
      const base = repo.base;
      // the worker pre-stages internal content the stageAll pathspec never touches
      await repo.stage({ 'allowed.txt': 'legal\n', '.ateam/injected.txt': 'smuggled\n' });
      const outcome = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo),
        allowlist: ['git *'],
        baseSha: base,
        staged: true,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.violations.some((v) => v.includes('.ateam content staged into the index'))).toBe(true);
      // the index no longer carries it — a commit after the gate cannot either
      expect((await repo.git('ls-files', '--', '.ateam')).trim()).toBe('');
      const tree = await writeTree(repo.root);
      const committed = await commitVerifiedTree(repo.root, tree, 'should be clean');
      expect(committed).not.toBeNull();
      const show = Bun.spawn(['git', '-C', repo.root, 'ls-tree', '-r', '--name-only', committed!], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
      const files = (await new Response(show.stdout).text()).split('\n').map((l) => l.trim());
      expect(files).not.toContain('.ateam/injected.txt');
      expect(files).toContain('allowed.txt');
    } finally {
      await cleanupTempDir(repo.root);
    }
  });

  test('R6-04: the gate commands read the pinned index tree, not the mutable worktree', async () => {
    const repo = await makeGateRepo();
    try {
      const base = repo.base;
      // the review-06 repro: index pins value.txt=bad, the worktree is edited
      // to good, the verification command greps for `good`
      await repo.stage({ 'value.txt': 'bad\n' });
      await repo.write({ 'value.txt': 'good\n' });

      const drifted = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo, { allowedPaths: ['value.txt'], verificationCommands: ['grep -q good value.txt'] }),
        allowlist: ['git *', 'grep *'],
        baseSha: base,
        staged: true,
      });
      expect(drifted.ok).toBe(false); // the pinned tree says `bad` — the gate must NOT pass
      expect(drifted.commands[0]!.ok).toBe(false);

      // the honest case still passes: worktree identical to the pinned index
      await repo.write({ 'value.txt': 'bad\n' });
      const honest = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo, { allowedPaths: ['value.txt'], verificationCommands: ['grep -q bad value.txt'] }),
        allowlist: ['git *', 'grep *'],
        baseSha: base,
        staged: true,
      });
      expect(honest.ok).toBe(true);
      expect(honest.commands[0]!.ok).toBe(true);
      // and the commit carries exactly the verified tree
      const sha = await commitVerifiedTree(repo.root, honest.treeSha, 'verified');
      expect(sha).not.toBeNull();
    } finally {
      await cleanupTempDir(repo.root);
    }
  });

  test('R7-01: the final gate refuses delivery commits that carry .ateam content', async () => {
    const repo = await makeGateRepo();
    try {
      // the review-07 repro: internal content already INSIDE an integration
      // commit — the worktree is clean, the old filters saw no violation
      await repo.stage({ 'allowed.txt': 'legal\n', '.ateam/injected.txt': 'smuggled\n' });
      await repo.git('commit', '-m', 'integration commit');
      const outcome = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo, { allowedPaths: ['**'], verificationCommands: [] }),
        allowlist: [],
        baseSha: repo.base,
        requireClean: true,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.violations.some((v) => v.includes('runner-internal .ateam content'))).toBe(true);
    } finally {
      await cleanupTempDir(repo.root);
    }
  });

  test('R7-01: the final gate refuses committed paths outside every task policy', async () => {
    const repo = await makeGateRepo();
    try {
      await repo.stage({ 'allowed.txt': 'legal\n', 'elsewhere.txt': 'out of scope\n' });
      await repo.git('commit', '-m', 'integration commit');
      const refused = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo, { allowedPaths: ['**'], verificationCommands: [] }),
        allowlist: [],
        baseSha: repo.base,
        requireClean: true,
        scopePolicies: [{ allowedPaths: ['allowed.txt'] }],
      });
      expect(refused.ok).toBe(false);
      expect(refused.violations.some((v) => v.includes('outside every task'))).toBe(true);
      // positive control: the same commit passes when a policy owns the path
      const allowed = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo, { allowedPaths: ['**'], verificationCommands: [] }),
        allowlist: [],
        baseSha: repo.base,
        requireClean: true,
        scopePolicies: [{ allowedPaths: ['allowed.txt', 'elsewhere.txt'] }],
      });
      expect(allowed.ok).toBe(true);
    } finally {
      await cleanupTempDir(repo.root);
    }
  });

  test('R7-01: the integrator commit gate refuses pre-staged .ateam content and out-of-scope resolutions', async () => {
    // the integrator path force-stages a runner-internal file behind
    // stageAll's pathspec — exactly the review-07 repro
    const smuggled = await makeGateRepo();
    try {
      await smuggled.stage({ '.ateam/injected.txt': 'smuggled\n', 'allowed.txt': 'resolved\n' });
      const refused = await commitIntegrationResolution({
        worktreePath: smuggled.root,
        baseSha: smuggled.base,
        message: 'conflict resolution',
        scopes: [{ allowedPaths: ['allowed.txt'] }],
      });
      expect(refused.ok).toBe(false);
      expect(refused.sha).toBeNull();
      expect(refused.violations.some((v) => v.includes('.ateam'))).toBe(true);
      // nothing was committed — the refusal keeps the branch where it was
      expect(await currentHead(smuggled.root)).toBe(smuggled.base);
    } finally {
      await cleanupTempDir(smuggled.root);
    }

    // a conflict resolution that edits outside every task policy is refused
    const outside = await makeGateRepo();
    try {
      await outside.stage({ 'allowed.txt': 'resolved\n', 'elsewhere.txt': 'edited\n' });
      const refused = await commitIntegrationResolution({
        worktreePath: outside.root,
        baseSha: outside.base,
        message: 'conflict resolution',
        scopes: [{ allowedPaths: ['allowed.txt'] }],
      });
      expect(refused.ok).toBe(false);
      expect(refused.sha).toBeNull();
      expect(refused.violations.some((v) => v.includes('outside every task'))).toBe(true);
      expect(await currentHead(outside.root)).toBe(outside.base);
    } finally {
      await cleanupTempDir(outside.root);
    }

    // the honest resolution commits
    const honest = await makeGateRepo();
    try {
      await honest.stage({ 'allowed.txt': 'resolved\n' });
      const okGate = await commitIntegrationResolution({
        worktreePath: honest.root,
        baseSha: honest.base,
        message: 'conflict resolution',
        scopes: [{ allowedPaths: ['allowed.txt'] }],
      });
      expect(okGate.ok).toBe(true);
      expect(okGate.sha).not.toBeNull();
      expect(await currentHead(honest.root)).toBe(okGate.sha!);
    } finally {
      await cleanupTempDir(honest.root);
    }
  });

  test('R7-02: a verification command that rewrites tracked content in the gate tree fails the gate', async () => {
    const repo = await makeGateRepo();
    try {
      // the review-07 repro: index pins value.txt=bad; the command rewrites
      // it to good INSIDE the gate checkout and asserts the rewrite — the
      // old gate passed, though the delivery commit carries `bad`
      await repo.stage({ 'value.txt': 'bad\n' });
      const rewritten = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo, { allowedPaths: ['value.txt'], verificationCommands: ['sh -c "printf good > value.txt; grep -q good value.txt"'] }),
        allowlist: ['git *', 'sh *'],
        baseSha: repo.base,
        staged: true,
      });
      expect(rewritten.ok).toBe(false);
      expect(rewritten.commands[0]!.ok).toBe(true); // the command itself succeeded...
      expect(rewritten.violations.some((v) => v.includes('mutated the isolated verification tree'))).toBe(true);
      // ...and the delivery still carries exactly the pinned (bad) content
      const sha = await commitVerifiedTree(repo.root, rewritten.treeSha, 'delivery');
      expect(sha).not.toBeNull();
      const show = Bun.spawn(['git', '-C', repo.root, 'show', `${sha!}:value.txt`], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
      expect((await new Response(show.stdout).text())).toBe('bad\n');
    } finally {
      await cleanupTempDir(repo.root);
    }
  });

  test('R7-02: a command emitting untracked output files still passes the gate', async () => {
    const repo = await makeGateRepo();
    try {
      await repo.stage({ 'value.txt': 'bad\n' });
      const outcome = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo, { allowedPaths: ['value.txt'], verificationCommands: ['sh -c "printf x > out.txt; grep -q bad value.txt"'] }),
        allowlist: ['git *', 'sh *'],
        baseSha: repo.base,
        staged: true,
      });
      // untracked output is not drift — only TRACKED content is judged
      expect(outcome.ok).toBe(true);
    } finally {
      await cleanupTempDir(repo.root);
    }
  });

  test('R7-05: the final PASS binds to the HEAD the gate verified, not to a later read', async () => {
    const repo = await makeGateRepo();
    try {
      // a committed, clean delivery the gate passes
      await repo.stage({ 'allowed.txt': 'delivered\n' });
      await repo.git('commit', '-m', 'delivery');
      const outcome = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo, { allowedPaths: ['**'], verificationCommands: [] }),
        allowlist: [],
        baseSha: repo.base,
        requireClean: true,
      });
      expect(outcome.ok).toBe(true);

      // another process commits BETWEEN the gate and the conclusion — the
      // review-07 race. The conclusion must void the PASS instead of
      // binding it to the never-verified newer HEAD.
      await repo.write({ 'allowed.txt': 'tampered\n' });
      await repo.git('commit', '-am', 'racing writer');
      const raced = await concludeFinalGate({ worktreePath: repo.root, outcome, integratedCommits: {} });
      expect(raced.ok).toBe(false);
      expect(raced.headSha).toBe(outcome.headAfter); // bound to the VERIFIED sha
      expect(raced.violations.some((v) => v.includes('HEAD moved after the gate ran'))).toBe(true);

      // back at the verified tree, the delivery-chain check applies: the
      // verified HEAD must still CONTAIN every delivered task commit
      await repo.git('reset', '--hard', repo.base);
      const reverted = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo, { allowedPaths: ['**'], verificationCommands: [], allowNoChanges: true }),
        allowlist: [],
        baseSha: repo.base,
        requireClean: true,
      });
      expect(reverted.ok).toBe(true);
      const dropped = await concludeFinalGate({
        worktreePath: repo.root,
        outcome: reverted,
        integratedCommits: { TASK: outcome.headAfter },
      });
      expect(dropped.ok).toBe(false);
      expect(dropped.violations.some((v) => v.includes('does not contain the delivered commit of TASK'))).toBe(true);

      // a HEAD that does contain the delivery concludes PASS
      await repo.git('reset', '--hard', outcome.headAfter);
      const restored = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo, { allowedPaths: ['**'], verificationCommands: [], allowNoChanges: true }),
        allowlist: [],
        baseSha: repo.base,
        requireClean: true,
      });
      expect(restored.ok).toBe(true);
      const kept = await concludeFinalGate({
        worktreePath: repo.root,
        outcome: restored,
        integratedCommits: { TASK: outcome.headAfter },
      });
      expect(kept.ok).toBe(true);
      expect(kept.headSha).toBe(outcome.headAfter);
    } finally {
      await cleanupTempDir(repo.root);
    }
  });

  test('R7-06: the gate checkout is ledgered on create and released on cleanup', async () => {
    const repo = await makeGateRepo();
    try {
      await repo.stage({ 'allowed.txt': 'x\n' });
      const registered: string[] = [];
      const released: Array<[string, boolean]> = [];
      const outcome = await verifyTaskWork({
        worktreePath: repo.root,
        task: gateTask(repo),
        allowlist: ['git *'],
        baseSha: repo.base,
        staged: true,
        gateLedger: {
          register: (p) => registered.push(p),
          release: (p, removed) => released.push([p, removed]),
        },
      });
      expect(outcome.ok).toBe(true);
      expect(registered).toHaveLength(1);
      expect(released).toEqual([[registered[0]!, true]]);
      // the successful release means no registration is left behind
      // (the gate checkout prefix is `.gate-`, distinct from the repo dir)
      expect(await repo.git('worktree', 'list', '--porcelain')).not.toContain('.gate-');
    } finally {
      await cleanupTempDir(repo.root);
    }
  });
});
