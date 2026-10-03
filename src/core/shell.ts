// Shell command tokenizing, allowlist enforcement and execution.
// Verification commands run as raw argv (no shell) after allowlist checks.

import { AteamError } from './errors.ts';

/** POSIX-ish tokenizer honoring double/single quotes; safe on Windows too
 * because we never touch cmd.exe. Backslash is a plain character except
 * inside double quotes where it escapes " and \. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === '"') {
      if (ch === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        cur += command[++i]!;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== '' || started) {
        out.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quote !== null) throw new AteamError(`unterminated quote in command: ${command}`);
  if (cur !== '' || started) out.push(cur);
  return out;
}

/**
 * Allowlist: each entry is either a bare executable name ("npm"), a
 * "name sub..." prefix ("git status"), or "name *". The command's first
 * tokens must match one entry's prefix.
 */
export function assertCommandAllowed(command: string, allowlist: readonly string[]): void {
  const tokens = splitCommand(command);
  if (tokens.length === 0) throw new AteamError('empty verification command');
  for (const entry of allowlist) {
    const prefix = splitCommand(entry);
    if (prefix.length === 0) continue;
    const wildcard = prefix[prefix.length - 1] === '*';
    const core = wildcard ? prefix.slice(0, -1) : prefix;
    if (core.length === 0) continue;
    const ok =
      core.every((tok, i) => tokens[i] === tok) && (wildcard || tokens.length >= core.length);
    if (ok) return;
  }
  throw new AteamError(
    `verification command not allowed: "${command}" (allowlist: ${allowlist.join(', ')})`,
  );
}

export interface CommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_CAPTURE = 2 * 1024 * 1024;

function cap(s: string): string {
  return s.length > MAX_CAPTURE ? s.slice(0, MAX_CAPTURE) : s;
}

/** Run an argv command without a shell. */
export async function runArgv(
  argv: readonly string[],
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  const proc = Bun.spawn(argv as string[], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  if (exitCode === 0 && timedOut) exitCode = 124;
  return {
    ok: exitCode === 0,
    exitCode,
    stdout: cap(stdout),
    stderr: cap(stderr),
    timedOut,
  };
}

/** Tokenize, allowlist-check, then execute. Async so allowlist rejections are promise rejections. */
export async function runCommand(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; allowlist?: readonly string[]; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  if (opts.allowlist) assertCommandAllowed(command, opts.allowlist);
  return runArgv(splitCommand(command), opts);
}
