#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncSkills } from './core/files.js';
import { ensureGitRepo } from './core/git.js';
import { isBackendId, isValidAgentName } from './core/agent-config.js';
import { createCredentialStore } from './core/credentials.js';
import { promptMaskedSecret } from './core/terminal-input.js';
import { runMcpCli } from './mcp-cli.js';
import { runAttachCli } from './attach-cli.js';
import { runStartCli } from './start-cli.js';
import { migrateLegacyProjectState } from './core/migration.js';
import { resolveAgentTeamHome } from './core/home.js';

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

async function main(): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
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

  if (command === 'migrate') {
    await runMigrateCommand();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function runMigrateCommand(): Promise<void> {
  const repoFromOption = option('--repo');
  const homePath = option('--home');
  const dryRunIndex = argv.indexOf('--dry-run');
  const dryRun = dryRunIndex >= 0;
  if (dryRun) argv.splice(dryRunIndex, 1);
  const repoFromArgument = argv.shift();
  if (repoFromOption && repoFromArgument) throw new Error('migrate accepts either [repo] or --repo PATH, not both');
  if (argv.length > 0) throw new Error(`Unknown migrate option: ${argv[0]}`);
  const home = homePath === undefined
    ? resolveAgentTeamHome()
    : resolveAgentTeamHome({ env: { ...process.env, AGENT_TEAM_HOME: homePath } });
  const plan = await migrateLegacyProjectState(repoFromOption ?? repoFromArgument ?? process.cwd(), home, dryRun);
  const summary = `${plan.stateRuns} state run(s), ${plan.runArtifacts} run artifact(s)`;
  if (dryRun) {
    console.log(`Migration preflight passed (dry run): ${summary}.`);
  } else {
    console.log(`Migrated ${summary} to ${home.root}.`);
  }
  console.log(`Worktrees were not migrated (${plan.preservedWorktrees} direct legacy entries preserved); only terminal runs are supported.`);
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
    if (command === 'start' || command === 'mcp' || command === 'attach') {
      const controlPlaneCommand = command;
      const controlPlaneArgs = argv;
      argv = [];
      command = undefined;
      if (controlPlaneCommand === 'start') await runStartCli(controlPlaneArgs);
      else if (controlPlaneCommand === 'mcp') await runMcpCli(controlPlaneArgs);
      else await runAttachCli(controlPlaneArgs);
      return;
    }
    await main();
  } finally {
    argv = [];
    command = undefined;
  }
}

function printHelp(): void {
  console.log(`agent-team-runner

Commands:
  init [repo]                         Sync host skills without modifying repository config
  start [--home PATH]                 Start or connect to the daemon, then open the Inbox
  mcp [--home PATH]                   Run the MCP server
  attach [run-id] [--home PATH]       Select or attach an interactive daemon run dashboard
  migrate [repo] [--repo PATH]        Safely migrate terminal legacy state to AGENT_TEAM_HOME
          [--home PATH] [--dry-run]   Never merges or overwrites state.sqlite or run artifacts
  skills sync [--repo PATH]          Mirror portable skills for Codex/OpenCode/Claude
  auth set --backend ID --profile N  Save an API key in the macOS Keychain
  auth status --backend ID --profile N
                                     Report whether a Keychain credential is present
  auth logout --backend ID --profile N
                                     Delete a Keychain credential
  auth login --backend ID            Use the backend native CLI instead (OAuth unsupported)
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
