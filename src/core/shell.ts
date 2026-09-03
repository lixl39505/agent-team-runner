import spawn from 'cross-spawn';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verificationEnv } from './process-env.js';

export function splitCommand(input: string, platform: NodeJS.Platform = process.platform): string[] {
  if (/[\n\r;&|<>`^]/.test(input) || input.includes('$(')) {
    throw new Error(`Unsafe shell syntax is not allowed: ${input}`);
  }
  const result: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  const command = input.trim();
  let escape = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escape) { current += char; escape = false; continue; }
    if (char === '\\') {
      if (platform !== 'win32' && quote !== 'single') { escape = true; continue; }
      if (platform === 'win32' && quote === 'double') {
        let slashes = 1;
        while (command[index + slashes] === '\\') slashes += 1;
        if (command[index + slashes] === '"') {
          current += '\\'.repeat(Math.floor(slashes / 2));
          if (slashes % 2 === 1) current += '"';
          else quote = null;
          index += slashes;
          continue;
        }
      }
      current += char;
      continue;
    }
    if (char === "'" && quote !== 'double') { quote = quote === 'single' ? null : 'single'; continue; }
    if (char === '"' && quote !== 'single') { quote = quote === 'double' ? null : 'double'; continue; }
    if (/\s/.test(char) && quote === null) {
      if (current) { result.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (quote || escape) throw new Error(`Unclosed quote or escape in command: ${input}`);
  if (current) result.push(current);
  if (result.length === 0) throw new Error('Command is empty');
  return result;
}

export function assertAllowedCommand(command: string, prefixes: string[], platform: NodeJS.Platform = process.platform): void {
  const tokens = splitCommand(command, platform);
  assertNoCapabilityBearingArguments(tokens);
  if (!isAllowlistedCommand(command, prefixes, platform)) {
    throw new Error(`Verification command is not allowlisted: ${command}`);
  }
}

/** 布尔形态的安全前缀校验：危险参数或未命中前缀都视为不允许（审批收集器用，不抛错）。 */
export function isSafeAllowlistedCommand(command: string, prefixes: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  try {
    assertAllowedCommand(command, [...prefixes], platform);
    return true;
  } catch {
    return false;
  }
}

/** 前缀令牌匹配：命令与任一 allowlist 前缀逐令牌一致即视为放行。 */
export function isAllowlistedCommand(command: string, prefixes: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  const tokens = splitCommand(command, platform);
  return prefixes.some((prefix) => {
    const prefixTokens = splitCommand(prefix, platform);
    return prefixTokens.every((token, index) => tokens[index] === token);
  });
}

/** Reject options that turn nominally read/test commands into write, exec, or policy-escalation primitives. */
function assertNoCapabilityBearingArguments(tokens: string[]): void {
  const [program, subcommand] = tokens;
  const args = tokens.slice(1);
  const reject = (reason: string): never => {
    throw new Error(`Unsafe command arguments are not allowed (${reason}): ${tokens.join(' ')}`);
  };
  const hasOption = (values: string[]): boolean => args.some((arg) =>
    values.some((value) => arg === value
      || arg.startsWith(`${value}=`)
      || (value.length === 2 && value.startsWith('-') && !value.startsWith('--') && arg.startsWith(value)))
  );

  if (program === 'git' && ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files'].includes(subcommand ?? '')) {
    if (hasOption(['--output', '--ext-diff', '--textconv', '--show-signature', '--exec-path', '--html-path', '--man-path', '--info-path']) || args.includes('--help') || args.includes('-h')) {
      reject('git helper execution or output redirection');
    }
  }
  if (program === 'rg' && hasOption(['--pre', '--pre-glob'])) reject('ripgrep preprocessor execution');
  if (program === 'find' && args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0', '-fprintf'].includes(arg))) {
    reject('find action with side effects');
  }
  if (program === 'sort' && hasOption(['-o', '--output'])) reject('sort output file');
  if (program === 'npm' && hasOption(['--prefix', '--userconfig', '--globalconfig', '--script-shell'])) reject('npm path, config, or shell override');
  if (program === 'pnpm' && hasOption(['--dir', '-C', '--global-dir', '--config'])) reject('pnpm directory or config override');
  if (program === 'yarn' && hasOption(['--cwd', '--use-yarnrc', '--install-state-path'])) reject('yarn directory or config override');
  if (program === 'go' && subcommand === 'test' && hasOption(['-C', '-exec', '-toolexec', '-o', '-modfile', '-overlay'])) reject('go test helper, path, or output override');
  if (program === 'bun' && subcommand === 'test' && hasOption(['--cwd', '--config', '--preload'])) reject('bun test path, config, or preload');
  if (program === 'cargo' && subcommand === 'test' && hasOption(['--manifest-path', '--target-dir', '--config'])) reject('cargo test path or config override');
  if (program === 'make' && hasOption(['-f', '--file', '--makefile', '-C', '--directory', '--eval'])) reject('makefile, directory, or eval override');
}

export async function runCommand(command: string, cwd: string, log?: (line: string) => void): Promise<number> {
  const [program, ...args] = splitCommand(command);
  return await new Promise<number>((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'agent-team-verification-home-'));
    const child = spawn(program!, args, { cwd, env: verificationEnv(home), stdio: ['ignore', 'pipe', 'pipe'] });
    const cleanup = (): void => { rmSync(home, { recursive: true, force: true }); };
    child.stdout!.on('data', (chunk) => log?.(chunk.toString()));
    child.stderr!.on('data', (chunk) => log?.(chunk.toString()));
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', (code) => { cleanup(); resolve(code ?? 1); });
  });
}
