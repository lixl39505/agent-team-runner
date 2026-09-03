import { basename, join, resolve } from 'node:path';
import type { AgentBackend } from '../agent/types.js';
import type { BackendPool } from '../agent/registry.js';
import { ApprovalCollector, partitionGrants, type GrantDecisionMap, type RunExitMode } from './approval-collector.js';
import { applyContractRevision } from './contract-revision.js';
import { StateDatabase } from './db.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { createExecutionRun } from './execution-run.js';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readJson } from './files.js';
import { git } from './git.js';
import { ensureAgentTeamHome, resolveAgentTeamHome, type AgentTeamHome } from './home.js';
import { writeHandoff } from './handoff.js';
import { runOrchestrator } from './orchestrator.js';
import { isAllowlistedCommand } from './shell.js';
import { ProjectRegistry, type JsonValue, type ProjectRecord } from './project-registry.js';
import { runnerConfigFromProjectPolicy } from './project-runtime.js';
import {
  blockersPath,
  classifyRunExit,
  contractBlockers,
  handoffPath,
  pendingItemPath,
  readPendingFileSync,
  writeBlockersFileSync,
  writePendingFileSync,
  type ContractBlocker,
  type PendingItem,
  type RunExitKind
} from './run-exit.js';
import type { BackendId, ExecutionContract, TaskRecord } from './types.js';
import { assertExecutionContractFields } from './validation.js';

export const DEFAULT_EAGER_DEBOUNCE_MS = 10_000;

export interface ParsedRunCommand {
  contractPath: string;
  runId?: string;
  grantPath?: string;
  debounceMs?: number;
  maxParallel?: number;
  exitMode?: RunExitMode;
  homePath?: string;
}

/** Pure argv parsing for `agent-team run`, separated from execution for testability. */
export function parseRunCommandArgs(argv: string[]): ParsedRunCommand {
  const args = [...argv];
  const take = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
    args.splice(index, 2);
    return value;
  };
  let contractPath = take('--contract');
  const first = args[0];
  if (contractPath === undefined && first !== undefined && !first.startsWith('--')) contractPath = args.shift();
  const runId = take('--run-id');
  const grantPath = take('--grant');
  const homePath = take('--home');
  const debounce = take('--debounce-ms');
  const maxParallel = take('--max-parallel');
  const exitMode = take('--exit-mode');
  if (args.length > 0) throw new Error(`Unknown run option: ${args[0]}`);
  if (exitMode !== undefined && exitMode !== 'eager' && exitMode !== 'quiescence') {
    throw new Error('run --exit-mode must be "eager" or "quiescence"');
  }
  if (debounce !== undefined && !/^\d+$/.test(debounce)) throw new Error('run --debounce-ms must be a non-negative integer');
  if (maxParallel !== undefined && (!/^\d+$/.test(maxParallel) || Number(maxParallel) < 1)) {
    throw new Error('run --max-parallel must be a positive integer');
  }
  if (contractPath === undefined) throw new Error('run requires --contract PATH (or a contract file argument)');
  return {
    contractPath,
    ...(runId === undefined ? {} : { runId }),
    ...(grantPath === undefined ? {} : { grantPath }),
    ...(homePath === undefined ? {} : { homePath }),
    ...(debounce === undefined ? {} : { debounceMs: Number(debounce) }),
    ...(maxParallel === undefined ? {} : { maxParallel: Number(maxParallel) }),
    ...(exitMode === undefined ? {} : { exitMode })
  };
}

export interface RunCommandOptions {
  contractPath: string;
  /** Re-enters an existing run: replays, applies grants, or revises the contract. */
  runId?: string;
  grantPath?: string;
  debounceMs?: number;
  maxParallel?: number;
  exitMode?: RunExitMode;
  /** Test seams. */
  home?: AgentTeamHome;
  backends?: Record<BackendId, AgentBackend> | BackendPool;
}

export interface RunCommandOutcome {
  runId: string;
  exitCode: number;
  kind: RunExitKind;
  runStatus: string;
  contractRevision: number;
  integrationBranch: string | null;
  integrationCommit: string | null;
  tasks: TaskRecord[];
  pending: PendingItem[];
  blockers: ContractBlocker[];
  pendingPath: string;
  handoffPath: string | null;
}

/**
 * Headless execution of one contract: create/replay a run, run the orchestrator
 * with deny-and-collect approvals, classify the terminal state, and persist the
 * exit artifacts (pending.json / blockers.json / handoff).
 */
export async function executeRunCommand(options: RunCommandOptions): Promise<RunCommandOutcome> {
  const home = options.home ?? resolveAgentTeamHome();
  ensureAgentTeamHome(home);
  const rawContract = readJson(options.contractPath) as unknown;
  assertExecutionContractFields(rawContract, 'contract');
  const contract = rawContract as ExecutionContract;

  const db = new StateDatabase(home.stateDb);
  const registry = new ProjectRegistry(home.stateDb);
  let lockedRunId: string | undefined;
  try {
    let project: ProjectRecord;
    try {
      project = registry.getProject(contract.project.id);
    } catch {
      project = await registerContractProject(registry, contract);
    }
    let policy = registry.getProjectPolicy(project.id);
    let config = runnerConfigFromProjectPolicy(policy, project, home);
    if (options.maxParallel !== undefined) config.concurrency = options.maxParallel;

    let runId = options.runId;
    if (runId === undefined) {
      runId = await createExecutionRun({ config, db, contract: rawContract, projectPolicyRevisionId: policy.id });
    } else {
      const existing = db.getRun(runId);
      if (existing.status === 'planning') {
        // 上次进程在「创建 run 之后、写任务之前」崩溃：残留记录不可直接编排，重建后重放。
        db.deleteRun(runId);
        runId = await createExecutionRun({ config, db, contract: rawContract, projectPolicyRevisionId: policy.id, runId });
      }
    }
    const pendingPath = pendingItemPath(home.runsDir, runId);

    // 同一 runId 的进程互斥：锁目录写入存活 pid；崩溃残留（pid 不存活）可接管。
    acquireRunLock(home, runId);
    lockedRunId = runId;

    let run = db.getRun(runId);
    const existingTasks = db.listTasks(runId);
    let pending: PendingItem[] = [];

    if (options.grantPath !== undefined) {
      const decisions = readGrantDecisions(options.grantPath);
      const carried = readPendingFileSync(pendingPath)?.pending ?? [];
      pending = applyGrants({ db, registry, project, policy, runId, pendingPath, pending: carried, decisions });
      project = registry.getProject(project.id);
      policy = registry.getProjectPolicy(project.id);
      config = runnerConfigFromProjectPolicy(policy, project, home);
      if (options.maxParallel !== undefined) config.concurrency = options.maxParallel;
    }

    if (options.runId !== undefined && run.executionContractJson !== null
      && existingTasks.some((task) => task.status === 'blocked_on_contract')
      && canonicalJson(JSON.parse(run.executionContractJson)) !== canonicalJson(rawContract)) {
      applyContractRevision({ db, projectRegistry: registry, home, runId, contract: rawContract });
      run = db.getRun(runId);
    }

    if (run.status === 'queued') db.updateRun(runId, { status: 'planned' });

    const controller = new AbortController();
    const collector = new ApprovalCollector({
      runId,
      pendingPath,
      debounceMs: options.debounceMs ?? DEFAULT_EAGER_DEBOUNCE_MS,
      exitMode: options.exitMode ?? 'eager',
      allowedPrefixes: config.verification.allowedCommandPrefixes,
      onEagerAbort: () => controller.abort()
    });
    pending = collector.pending;
    try {
      await runOrchestrator({
        config,
        db,
        runId,
        requestApproval: collector.requestApproval,
        requestUserInput: collector.requestUserInput,
        signal: controller.signal,
        backends: options.backends
      });
    } finally {
      collector.dispose();
    }
    const finalRun = db.getRun(runId);
    const handoffWritten = finalRun.status === 'done';
    if (handoffWritten) writeHandoff(db, home.runsDir, runId);

    run = finalRun;
    const tasks = db.listTasks(runId);
    // run 完成意味着所有任务已 approved：其余 pending 都是被替代方案化解的陈旧请求。
    if (run.status === 'done') pending = [];
    const blockers = contractBlockers(tasks);
    const { code, kind } = classifyRunExit({
      run,
      tasks,
      pending,
      interrupted: process.exitCode === 130
    });
    writeBlockersFileSync(blockersPath(home.runsDir, runId), blockers);
    writePendingFileSync(pendingPath, { runId, pending });
    return {
      runId,
      exitCode: code,
      kind,
      runStatus: run.status,
      contractRevision: run.contractRevision,
      integrationBranch: run.integrationBranch,
      integrationCommit: run.integrationCommit,
      tasks,
      pending,
      blockers,
      pendingPath,
      handoffPath: handoffWritten ? handoffPath(home.runsDir, runId) : null
    };
  } finally {
    if (lockedRunId !== undefined) releaseRunLock(home, lockedRunId);
    db.close();
    registry.close();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 同一 runId 的进程互斥锁：runs/<id>/lock/pid 记录持有者，崩溃残留可被接管。 */
function acquireRunLock(home: AgentTeamHome, runId: string): void {
  const lockDir = join(home.runsDir, runId, 'lock');
  try {
    mkdirSync(lockDir);
  } catch {
    const pidFile = join(lockDir, 'pid');
    let holder: number | undefined;
    try {
      holder = Number(readFileSync(pidFile, 'utf8'));
    } catch {
      holder = undefined;
    }
    if (holder !== undefined && Number.isSafeInteger(holder) && isProcessAlive(holder)) {
      console.error('LOCKDEBUG holder alive:', holder);
      throw new Error(`Run ${runId} is already executing in another process (pid ${holder})`);
    }
    console.error('LOCKDEBUG taking over, holder:', holder);
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
  }
  writeFileSync(join(lockDir, 'pid'), String(process.pid), 'utf8');
}

function releaseRunLock(home: AgentTeamHome, runId: string): void {
  rmSync(join(home.runsDir, runId, 'lock'), { recursive: true, force: true });
}

export function readGrantDecisions(grantPath: string): GrantDecisionMap {
  const raw = readJson(grantPath) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Grant decisions must be a JSON object of pendingId -> approve|deny');
  }
  const decisions: GrantDecisionMap = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== 'approve' && value !== 'deny') {
      throw new Error(`Grant decision for ${id} must be "approve" or "deny"`);
    }
    decisions[id] = value;
  }
  return decisions;
}

/** Approvals: approved commands sediment into the project allowlist and their tasks rerun; denied ones fail. */
function applyGrants(input: {
  db: StateDatabase;
  registry: ProjectRegistry;
  project: ProjectRecord;
  policy: ReturnType<ProjectRegistry['getProjectPolicy']>;
  runId: string;
  pendingPath: string;
  pending: PendingItem[];
  decisions: GrantDecisionMap;
}): PendingItem[] {
  for (const item of input.pending) {
    if (item.kind === 'question' && input.decisions[item.id] !== undefined) {
      throw new Error(
        `Pending item ${item.id} is a question; answer it by revising the contract ` +
        '(implementationGuidance), not through --grant approvals'
      );
    }
  }
  const { approved, denied, unresolved } = partitionGrants(input.pending, input.decisions);
  const prefixes = new Set(input.policy.verificationAllowedCommandPrefixes);
  let allowlistChanged = false;
  for (const item of approved) {
    for (const command of item.commands ?? []) {
      if (!prefixes.has(command)) {
        prefixes.add(command);
        allowlistChanged = true;
      }
    }
    if (item.taskId !== null) input.db.updateTask(input.runId, item.taskId, { status: 'pending' });
  }
  for (const item of denied) {
    if (item.taskId !== null) {
      input.db.updateTask(input.runId, item.taskId, {
        status: 'failed',
        lastError: `Denied by outer decision: ${item.subject}`,
        finishedAt: new Date().toISOString()
      });
    }
  }
  if (allowlistChanged) {
    const updated = input.registry.registerProject({
      gitCommonDir: input.project.gitCommonDir,
      repoRoot: input.project.repoRoot,
      displayName: input.project.displayName,
      gitIdentity: input.project.gitIdentity,
      policy: {
        baseRef: input.policy.baseRef,
        verificationAllowedCommandPrefixes: [...prefixes],
        baselinePathPolicy: input.policy.baselinePathPolicy,
        agentProfileMapping: input.policy.agentProfileMapping,
        backendPolicy: input.policy.backendPolicy
      }
    });
    input.db.updateRun(input.runId, { projectPolicyRevisionId: updated.currentPolicyRevisionId });
  }
  writePendingFileSync(input.pendingPath, { runId: input.runId, pending: unresolved });
  return unresolved;
}

async function registerContractProject(registry: ProjectRegistry, contract: ExecutionContract): Promise<ProjectRecord> {
  const repoRoot = contract.project.repoRoot;
  const commonDir = await git(repoRoot, ['rev-parse', '--git-common-dir'], true);
  const gitCommonDir = commonDir.stdout.trim() === '' ? repoRoot : resolve(repoRoot, commonDir.stdout.trim());
  const remote = await git(repoRoot, ['remote', 'get-url', 'origin'], true);
  const gitIdentity: JsonValue = remote.stdout.trim() === '' ? { root: repoRoot } : { remote: remote.stdout.trim() };
  const registered = registry.registerProject({
    gitCommonDir,
    repoRoot,
    displayName: basename(repoRoot),
    gitIdentity,
    id: contract.project.id,
    policy: {
      baseRef: contract.project.baseRef,
      verificationAllowedCommandPrefixes: [...DEFAULT_CONFIG.verification.allowedCommandPrefixes],
      baselinePathPolicy: {},
      agentProfileMapping: {
        defaultAgent: DEFAULT_CONFIG.defaultAgent,
        agents: { 'default-claude': { backend: 'claude' } },
        roles: {}
      },
      backendPolicy: {}
    }
  });
  if (registered.id !== contract.project.id) {
    throw new Error(
      `Repository is already registered as project "${registered.id}"; ` +
      `the contract must use that id instead of "${contract.project.id}"`
    );
  }
  return registered;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  /* istanbul ignore next -- undefined never survives JSON round-trips. */
  return JSON.stringify(value) ?? 'null';
}
