// Runner engine integration tests against the fake Herdr client with real
// git worktrees. These pin the ADR invariants: prompt exactly once, panes
// closed only after persisted results, blocked never creates attempts,
// revise consumption, and the verification/attempt gates.

import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDatabase, type SqliteDb } from '../src/store/db.ts';
import { insertRun, getRun, appendContractRevision } from '../src/store/runs.ts';
import { insertTask, listTasks, getTask } from '../src/store/tasks.ts';
import { listExecutions } from '../src/store/executions.ts';
import { validateContract } from '../src/core/contract.ts';
import { RunnerEngine } from '../src/runner/engine.ts';
import { FakeHerdrClient } from '../src/herdr/fake-client.ts';
import type { FakeAgentScript } from '../src/herdr/fake-client.ts';
import type { HerdrRuntimeClient } from '../src/herdr/client.ts';
import { agentName } from '../src/store/ids.ts';
import { DEFAULT_CONFIG, type AteamConfig } from '../src/config.ts';
import type { ExecutionContract } from '../src/core/types.ts';
import { acquireLease } from '../src/store/lease.ts';
import { cleanupTempDir, initRepo, makeTempDir, minimalContract } from './helpers.ts';

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

  test('clean reclaims integrated-but-unfinished resources and abandons the run', async () => {
    const fx = track(await makeFixture({}));
    seedRun(fx);
    // simulate: API reached "integrated" then the runner died before cleanup
    const ws = await fx.fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: `ateam/${RUN}/task/API` });
    fx.db.run(
      `UPDATE tasks SET status='integrated', branch=?, worktree_path=?, workspace_id=?,
       start_sha='s0', commit_sha='c1', integration_commit='i1' WHERE run_id=? AND task_id='API'`,
      [`ateam/${RUN}/task/API`, ws.worktree.path, ws.workspace.workspaceId, RUN],
    );
    const { insertResource } = await import('../src/store/resources.ts');
    insertResource(fx.db, { runId: RUN, taskId: 'API', kind: 'workspace', herdrId: ws.workspace.workspaceId, branch: ws.worktree.branch, path: ws.worktree.path });
    fx.db.run("UPDATE runs SET status='needs_attention' WHERE id = ?", [RUN]);

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

    const { cleanupTaskResources } = await import('../src/runner/cleanup.ts');
    const ok = await cleanupTaskResources(envFor(fx), getTask(fx.db, RUN, 'API')!);
    expect(ok).toBe(true);
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

    // snapshot unavailable ⇒ judgment stops: no phantom pane-loss attempts
    const { HerdrError } = await import('../src/herdr/types.ts');
    const broken = stubClient({
      subscribe: () => Promise.reject(new Error('no subscription')),
      snapshot: () => Promise.reject(new HerdrError('timeout', 'snapshot down')),
    });
    const brokenEngine = new RunnerEngine({ ...envFor(fx), client: broken }, {});
    const decisions = await brokenEngine.reconcileOnce({});
    expect(decisions.some((d) => d.kind === 'snapshot_unavailable')).toBe(true);
    expect(decisions.some((d) => d.kind === 'pane_lost_new_attempt' || d.kind === 'pane_lost_no_attempt')).toBe(false);
    // the execution is untouched — the next pass with a healthy snapshot decides
    expect(listExecutions(fx.db, RUN).filter((e) => e.status === 'abandoned')).toHaveLength(0);
    expect(listExecutions(fx.db, RUN).find((e) => e.id === exec.id)!.status).toBe('running');

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

  test('runUntilTerminal refuses without a free lease', async () => {    const fx = track(await makeFixture({}));
    seedRun(fx);
    expect(acquireLease(fx.db, RUN)).toBe(true);
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
});
