import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentTeamHome, type AgentTeamHome } from './core/home.js';
import { AgentTeamDaemon } from './daemon/service.js';

type DaemonLifecycle = Pick<AgentTeamDaemon, 'start' | 'stop'>;
type SignalRegister = (signal: NodeJS.Signals, listener: () => Promise<void>) => void;

export interface DaemonCliDependencies {
  resolveHome?: typeof resolveAgentTeamHome;
  createDaemon?: (home: AgentTeamHome) => DaemonLifecycle;
  registerSignal?: SignalRegister;
  printError?: (message: string) => void;
}

export function formatDaemonCliError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export async function runDaemonCli(
  args: string[] = process.argv.slice(2),
  deps: DaemonCliDependencies = {}
): Promise<void> {
  const resolveHome = deps.resolveHome ?? resolveAgentTeamHome;
  const printError = deps.printError ?? console.error;

  try {
    let home: AgentTeamHome;
    if (args.length === 0) {
      home = resolveHome();
    } else {
      if (args[0] !== '--home') throw new Error(`Unknown daemon option: ${args[0]}`);
      const homePath = args[1];
      if (!homePath || homePath.startsWith('--')) throw new Error('--home requires a value');
      if (args.length > 2) throw new Error(`Unknown daemon option: ${args[2]}`);
      home = resolveHome({ env: { ...process.env, AGENT_TEAM_HOME: homePath } });
    }

    const daemon = deps.createDaemon ? deps.createDaemon(home) : new AgentTeamDaemon(home);
    await daemon.start();
    const stop = async (): Promise<void> => {
      try {
        await daemon.stop();
      } catch (error) {
        printError(formatDaemonCliError(error));
        process.exitCode = 1;
      }
    };
    if (deps.registerSignal) {
      deps.registerSignal('SIGINT', stop);
      deps.registerSignal('SIGTERM', stop);
    } else {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  } catch (error) {
    printError(formatDaemonCliError(error));
    process.exitCode = 1;
  }
}

export function isDaemonCliMain(
  argv: readonly string[] = process.argv,
  moduleUrl: string = import.meta.url
): boolean {
  return argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(moduleUrl);
}

if (isDaemonCliMain()) void runDaemonCli();
