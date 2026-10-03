// CLI transport: spawns the `herdr` binary with --json and parses responses.
// CLI wrappers are the portable layer across Unix sockets and Windows named
// pipes (ADR 0001 mandates them as the default).

import { HerdrError } from './types.ts';

export interface HerdrSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface HerdrCallOptions {
  timeoutMs?: number;
  input?: string;
}

export type HerdrSpawner = (
  argv: string[],
  opts: HerdrCallOptions,
) => Promise<HerdrSpawnResult>;

/** Default spawner using Bun.spawn. Overridable in tests. */
export const bunSpawner: HerdrSpawner = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.input === undefined ? 'ignore' : 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, opts.timeoutMs ?? 30_000);
  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    proc.stdin.end();
  }
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
  return { exitCode, stdout, stderr, timedOut };
};

export class HerdrCliTransport {
  constructor(
    readonly herdrPath: string = process.env.ATEAM_HERDR_PATH ?? 'herdr',
    private readonly spawn: HerdrSpawner = bunSpawner,
    /** Prepended to every invocation; lets tests run a fixture via `bun fixture.ts`. */
    private readonly argvPrefix: readonly string[] = [],
  ) {}

  private argv(args: string[]): string[] {
    return [...this.argvPrefix, this.herdrPath, ...args];
  }

  private async spawnSafe(argv: string[], opts: HerdrCallOptions): Promise<HerdrSpawnResult> {
    try {
      return await this.spawn(argv, opts);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT' || /not found|no such file/i.test(String(err))) {
        throw new HerdrError('herdr_not_found', `herdr binary not found at "${this.herdrPath}"`);
      }
      throw err;
    }
  }

  /**
   * Run a herdr subcommand expecting a JSON response on stdout.
   * CLI error convention: exit 1 + JSON error on stderr, exit 2 = usage.
   */
  async callJson<T>(args: string[], opts: HerdrCallOptions = {}): Promise<T> {
    const res = await this.spawnSafe(this.argv(args), opts);
    if (res.timedOut) {
      throw new HerdrError('timeout', `herdr ${args[0]} ${args[1] ?? ''} timed out`.trim());
    }
    if (res.exitCode === 0) {
      return parseJsonResponse<T>(res.stdout, args);
    }
    const err = parseErrorResponse(res.stderr) ?? parseErrorResponse(res.stdout);
    if (err) throw err;
    if (res.exitCode === 2) {
      throw new HerdrError('herdr_error', `herdr usage error: ${firstLine(res.stderr)}`, { args });
    }
    throw new HerdrError('herdr_error', `herdr ${args.join(' ')} failed (${res.exitCode}): ${firstLine(res.stderr || res.stdout)}`);
  }

  /** Plain-text call (e.g. `herdr --version`). */
  async callText(args: string[], opts: HerdrCallOptions = {}): Promise<string> {
    const res = await this.spawnSafe(this.argv(args), opts);
    if (res.timedOut) throw new HerdrError('timeout', `herdr ${args.join(' ')} timed out`);
    if (res.exitCode !== 0) {
      const err = parseErrorResponse(res.stderr);
      if (err) throw err;
      throw new HerdrError('herdr_error', `herdr ${args.join(' ')} failed (${res.exitCode}): ${firstLine(res.stderr)}`);
    }
    return res.stdout.trim();
  }

  /** Cheap liveness check that distinguishes not-installed from not-running. */
  async ping(): Promise<void> {
    const res = await this.spawnSafe(this.argv(['status']), { timeoutMs: 10_000 });
    if (res.exitCode === 127 || /ENOENT|not found|No such file/i.test(res.stderr)) {
      throw new HerdrError('herdr_not_found', `herdr binary not found at "${this.herdrPath}"`);
    }
    if (/not running|no server|connection refused|connect/i.test(res.stdout + res.stderr)) {
      throw new HerdrError('herdr_not_running', 'herdr server is not running; start Herdr first');
    }
  }
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}

export function parseJsonResponse<T>(stdout: string, args: string[]): T {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    throw new HerdrError('invalid_response', `herdr ${args.join(' ')} produced empty output`);
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new HerdrError('invalid_response', `herdr ${args.join(' ')} produced non-JSON output: ${firstLine(trimmed)}`);
  }
}

export function parseErrorResponse(stderr: string): HerdrError | null {
  const trimmed = stderr.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const doc = JSON.parse(trimmed) as { error?: { code?: string; message?: string } };
    if (doc.error?.code) {
      const code = normalizeErrorCode(doc.error.code);
      return new HerdrError(code, doc.error.message ?? doc.error.code, doc);
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeErrorCode(code: string): HerdrError['code'] {
  switch (code) {
    case 'not_found':
    case 'agent_not_found':
      return 'not_found';
    case 'timeout':
      return 'timeout';
    default:
      return 'herdr_error';
  }
}
