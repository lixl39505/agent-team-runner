import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAttachCli } from './attach-cli.js';
import { resolveAgentTeamHome, type AgentTeamHome } from './core/home.js';
import { LocalIpcClient } from './daemon/ipc.js';

type IpcClient = Pick<LocalIpcClient, 'connect' | 'close'>;
type SpawnDaemon = (home: AgentTeamHome) => Pick<ChildProcess, 'unref'>;

export interface StartCliDependencies {
  resolveHome?: typeof resolveAgentTeamHome;
  createClient?: (home: AgentTeamHome) => IpcClient;
  spawnDaemon?: SpawnDaemon;
  runAttach?: typeof runAttachCli;
  sleep?: (milliseconds: number) => Promise<void>;
  startupAttempts?: number;
}

/** Starts a detached daemon only when its local IPC endpoint is unavailable. */
export async function runStartCli(
  args: string[] = process.argv.slice(2),
  deps: StartCliDependencies = {}
): Promise<void> {
  const home = startArguments(args, deps.resolveHome ?? resolveAgentTeamHome);
  const attempts = deps.startupAttempts ?? 50;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('start startupAttempts must be a positive integer');
  const createClient = deps.createClient ?? ((value: AgentTeamHome) => new LocalIpcClient(value.socket));
  const connect = async (): Promise<boolean> => {
    const client = createClient(home);
    try {
      await client.connect();
      return true;
    } catch {
      return false;
    } finally {
      client.close();
    }
  };

  if (!await connect()) {
    (deps.spawnDaemon ?? spawnDaemon)(home).unref();
    const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(100);
      if (await connect()) {
        await (deps.runAttach ?? runAttachCli)(['--home', home.root]);
        return;
      }
    }
    throw new Error(`Daemon did not become available at ${home.socket}`);
  }

  await (deps.runAttach ?? runAttachCli)(['--home', home.root]);
}

export function startArguments(args: string[], resolveHome: typeof resolveAgentTeamHome): AgentTeamHome {
  if (args.length === 0) return resolveHome();
  if (args[0] !== '--home') throw new Error(`Unknown start option: ${args[0]}`);
  const homePath = args[1];
  if (!homePath || homePath.startsWith('--')) throw new Error('--home requires a value');
  if (args.length > 2) throw new Error(`Unknown start option: ${args[2]}`);
  return resolveHome({ env: { ...process.env, AGENT_TEAM_HOME: homePath } });
}

function spawnDaemon(home: AgentTeamHome): ChildProcess {
  /* istanbul ignore next -- tests execute TypeScript; production executes the compiled JavaScript entry. */
  const daemonModule = import.meta.url.endsWith('.ts') ? './daemon-cli.ts' : './daemon-cli.js';
  const daemonEntry = fileURLToPath(new URL(daemonModule, import.meta.url));
  return nodeSpawn(process.execPath, [...process.execArgv, daemonEntry, '--home', home.root], {
    detached: true,
    stdio: 'ignore'
  });
}
