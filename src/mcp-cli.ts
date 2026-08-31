import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentTeamHome } from './core/home.js';
import { runMcpServer } from './mcp/server.js';

export interface McpCliDependencies {
  resolveHome?: typeof resolveAgentTeamHome;
  runServer?: typeof runMcpServer;
  printError?: (message: string) => void;
}

export function formatMcpCliError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export async function runMcpCli(
  args: string[] = process.argv.slice(2),
  deps: McpCliDependencies = {}
): Promise<void> {
  const resolveHome = deps.resolveHome ?? resolveAgentTeamHome;
  const runServer = deps.runServer ?? runMcpServer;
  const printError = deps.printError ?? console.error;

  try {
    if (args.length === 0) {
      await runServer(resolveHome());
      return;
    }

    if (args[0] !== '--home') throw new Error(`Unknown MCP option: ${args[0]}`);
    const homePath = args[1];
    if (!homePath || homePath.startsWith('--')) throw new Error('--home requires a value');
    if (args.length > 2) throw new Error(`Unknown MCP option: ${args[2]}`);

    await runServer(resolveHome({ env: { ...process.env, AGENT_TEAM_HOME: homePath } }));
  } catch (error) {
    printError(formatMcpCliError(error));
    process.exitCode = 1;
  }
}

export function isMcpCliMain(
  argv: readonly string[] = process.argv,
  moduleUrl: string = import.meta.url
): boolean {
  return argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(moduleUrl);
}

if (isMcpCliMain()) void runMcpCli();
