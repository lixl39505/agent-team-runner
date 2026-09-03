#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateDatabase } from './core/db.js';
import { syncSkills } from './core/files.js';
import { formatRunStatus } from './core/status.js';
import { ensureGitRepo } from './core/git.js';
import { isBackendId, isValidAgentName } from './core/agent-config.js';
import { createCredentialStore } from './core/credentials.js';
import { promptMaskedSecret } from './core/terminal-input.js';
import { parseRunCommandArgs, executeRunCommand } from './core/run-execute.js';
import { cleanRunArtifacts } from './core/run-clean.js';
import { DEFAULT_AGENT_LOG_BYTES, DEFAULT_AGENT_LOG_LINES, readAgentLog } from './core/agent-log.js';
import { renderMachineSummary, renderRunSummary } from './core/run-exit.js';
import { resolveAgentTeamHome, type AgentTeamHome } from './core/home.js';

let argv: string[] = [];
let command: string | undefined;

function option(name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  argv.splice(index, 2);
  return value;
}

function repoOption(): string {
  return resolve(option('--repo') ?? process.cwd());
}

function homeOption(): AgentTeamHome | undefined {
  const homePath = option('--home');
  return homePath === undefined
    ? undefined
    : resolveAgentTeamHome({ env: { ...process.env, AGENT_TEAM_HOME: resolve(homePath) } });
}

function withStateDatabase<T>(home: AgentTeamHome, body: (db: StateDatabase) => T): T {
  const db = new StateDatabase(home.stateDb);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'run') {
    const home = homeOption();
    const parsed = parseRunCommandArgs(argv);
    argv = [];
    let outcome;
    try {
      outcome = await executeRunCommand({
      contractPath: parsed.contractPath,
      ...(parsed.runId === undefined ? {} : { runId: parsed.runId }),
      ...(parsed.grantPath === undefined ? {} : { grantPath: parsed.grantPath }),
      ...(parsed.debounceMs === undefined ? {} : { debounceMs: parsed.debounceMs }),
      ...(parsed.maxParallel === undefined ? {} : { maxParallel: parsed.maxParallel }),
        ...(parsed.exitMode === undefined ? {} : { exitMode: parsed.exitMode }),
        ...(home === undefined ? {} : { home })
      });
    } catch (error) {
      // 崩溃也要有机器可读终态：外层控制器依据 JSON 决定重试/上报；
      // runId（若 run 已创建）用于定位残留的 run 与 runs/<id>/ 下的退出产物。
      const runId = (error as { runId?: string }).runId;
      console.error(JSON.stringify({
        kind: 'failed',
        exit: 1,
        error: String(error),
        ...(runId !== undefined ? { runId } : {})
      }));
      process.exitCode = 1;
      return;
    }
    console.log(renderRunSummary({
      runId: outcome.runId,
      kind: outcome.kind,
      code: outcome.exitCode,
      status: outcome.runStatus,
      integrationBranch: outcome.integrationBranch,
      integrationCommit: outcome.integrationCommit,
      contractRevision: outcome.contractRevision,
      tasks: outcome.tasks,
      pending: outcome.pending,
      blockers: outcome.blockers,
      pendingPath: outcome.pendingPath,
      ...(outcome.handoffPath !== null ? { handoffPath: outcome.handoffPath } : {})
    }));
    console.log(renderMachineSummary({
      runId: outcome.runId,
      kind: outcome.kind,
      code: outcome.exitCode,
      status: outcome.runStatus,
      contractRevision: outcome.contractRevision,
      pendingCount: outcome.pending.length,
      blockers: outcome.blockers
    }));
    process.exitCode = outcome.exitCode;
    return;
  }

  if (command === 'status') {
    const home = homeOption() ?? resolveAgentTeamHome();
    const runId = argv.shift();
    if (argv.length > 0) throw new Error(`Unknown status argument: ${argv[0]}`);
    withStateDatabase(home, (db) => {
      const run = runId === undefined ? db.listRuns()[0] : db.getRun(runId);
      if (run === undefined) throw new Error('No runs found; submit a contract with agent-team run first');
      console.log(formatRunStatus(run, db.listTasks(run.id)));
    });
    return;
  }

  if (command === 'log') {
    const home = homeOption() ?? resolveAgentTeamHome();
    const runId = argv.shift();
    const agentId = argv.shift();
    if (!runId || !agentId) throw new Error('Usage: agent-team log RUN_ID AGENT_ID [--lines N]');
    const lines = Number(option('--lines') ?? DEFAULT_AGENT_LOG_LINES);
    if (!Number.isSafeInteger(lines) || lines < 1) throw new Error('--lines must be a positive integer');
    const homeResolved = home;
    const content = await withStateDatabase(homeResolved, async (db) =>
      (await readAgentLog(db, homeResolved.runsDir, runId, agentId, lines, DEFAULT_AGENT_LOG_BYTES)).content);
    console.log(content);
    return;
  }

  if (command === 'clean') {
    const home = homeOption() ?? resolveAgentTeamHome();
    const runId = argv.shift();
    if (!runId) throw new Error('Usage: agent-team clean RUN_ID');
    if (argv.length > 0) throw new Error(`Unknown clean argument: ${argv[0]}`);
    const result = await withStateDatabase(home, (db) => cleanRunArtifacts(db, home, runId));
    console.log(`Removed ${result.removedWorktrees.length} worktree(s) and ${result.removedBranches.length} branch(es) for run ${runId}.`);
    return;
  }

  if (command === 'init') {
    const repoRoot = resolve(argv.shift() ?? process.cwd());
    await ensureGitRepo(repoRoot);
    const skills = syncSkills(repoRoot);
    console.log(`Synced ${skills.length} host skill files.`);
    return;
  }

  if (command === 'skills') {
    const subcommand = argv.shift();
    if (subcommand !== 'sync') throw new Error('Usage: agent-team skills sync [--repo PATH]');
    const repoRoot = repoOption();
    const skills = syncSkills(repoRoot);
    console.log(skills.join('\n'));
    return;
  }

  if (command === 'auth') {
    await runAuthCommand();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function runAuthCommand(): Promise<void> {
  const subcommand = argv.shift();
  if (subcommand === 'login') {
    const { backend } = authOptions(false);
    throw new Error(`OAuth login is not supported; use the ${backend} native CLI to log in.`);
  }
  if (subcommand !== 'set' && subcommand !== 'status' && subcommand !== 'logout') {
    throw new Error('Usage: agent-team auth <set|status|logout> --backend BACKEND --profile NAME');
  }
  if (subcommand === 'set' && argv.some((argument) => argument === '--key' || argument.startsWith('--key='))) {
    throw new Error('agent-team auth set does not accept --key; enter the API key at the masked terminal prompt.');
  }
  const { backend, profile } = authOptions(true);
  const credentials = createCredentialStore();
  if (subcommand === 'set') {
    const apiKey = await promptMaskedSecret('API key: ');
    if (!apiKey) throw new Error('API key must not be empty.');
    await credentials.setApiKey(backend, profile, apiKey);
    console.log('Credential saved.');
    return;
  }
  if (subcommand === 'status') {
    console.log((await credentials.hasApiKey(backend, profile)) ? 'present' : 'missing');
    return;
  }
  await credentials.deleteApiKey(backend, profile);
  console.log('Credential removed.');
}

function authOptions(requireProfile: boolean): { backend: string; profile: string } {
  const backend = option('--backend');
  const profile = option('--profile');
  if (!backend || !isBackendId(backend)) {
    throw new Error('auth --backend must be one of claude, codex, opencode');
  }
  if (requireProfile && (!profile || !isValidAgentName(profile))) {
    throw new Error('auth --profile must use letters, digits, dashes, or underscores (no dots)');
  }
  if (!requireProfile && profile !== undefined) {
    throw new Error('auth login does not accept --profile');
  }
  if (argv.length > 0) throw new Error(`Unknown auth option: ${argv[0]}`);
  return { backend, profile: profile ?? '' };
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  argv = [...args];
  command = argv.shift();
  try {
    await main();
  } finally {
    argv = [];
    command = undefined;
  }
}

function printHelp(): void {
  console.log(`agent-team-runner

Commands:
  run --contract PATH                 Execute an execution contract (create or replay a run)
          [--run-id ID] [--grant PATH] [--debounce-ms N] [--max-parallel N]
          [--exit-mode eager|quiescence] [--home PATH]
  status [RUN_ID] [--home PATH]       Show run and task status (latest run by default)
  log RUN_ID AGENT_ID [--lines N] [--home PATH]
                                      Tail a worker/reviewer/integrator log
  clean RUN_ID [--home PATH]          Remove a run's worktrees and branches (non-replayable afterwards)
  init [repo]                         Sync host skills without modifying repository config
  skills sync [--repo PATH]          Mirror portable skills for Codex/OpenCode/Claude
  auth set --backend ID --profile N  Save an API key in the macOS Keychain
  auth status --backend ID --profile N
                                     Report whether a Keychain credential is present
  auth logout --backend ID --profile N
                                     Delete a Keychain credential
  auth login --backend ID            Use the backend native CLI instead (OAuth unsupported)

Run exit codes: 0 done, 10 needs-approval, 11 contract-blocked, 1 failed, 130 interrupted.
`);
}

export function formatCliError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((error) => {
    console.error(formatCliError(error));
    process.exitCode = 1;
  });
}
