import { spawn } from 'node:child_process';

export function splitCommand(input: string): string[] {
  if (/[\n\r;&|<>`]/.test(input) || input.includes('$(')) {
    throw new Error(`Unsafe shell syntax is not allowed: ${input}`);
  }
  const result: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escape = false;
  for (const char of input.trim()) {
    if (escape) { current += char; escape = false; continue; }
    if (char === '\\' && quote !== 'single') { escape = true; continue; }
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

export function assertAllowedCommand(command: string, prefixes: string[]): void {
  const tokens = splitCommand(command);
  const normalized = tokens.join(' ');
  const allowed = prefixes.some((prefix) => {
    const prefixTokens = splitCommand(prefix);
    return prefixTokens.every((token, index) => tokens[index] === token);
  });
  if (!allowed) throw new Error(`Verification command is not allowlisted: ${normalized}`);
}

export async function runCommand(command: string, cwd: string, log?: (line: string) => void): Promise<number> {
  const [program, ...args] = splitCommand(command);
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(program!, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => log?.(chunk.toString()));
    child.stderr.on('data', (chunk) => log?.(chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
