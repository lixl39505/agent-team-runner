import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AgentTeamHome } from '../core/home.js';

export interface DaemonMetadata {
  pid: number;
  startedAt: string;
  protocolVersion: number;
}

export type DaemonMetadataInput = Partial<DaemonMetadata>;
export type PidAliveCheck = (pid: number) => boolean;

export interface DaemonInstanceLockOptions {
  isPidAlive?: PidAliveCheck;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly metadata: DaemonMetadata) {
    super(`Daemon is already running (PID ${metadata.pid})`);
    this.name = 'DaemonAlreadyRunningError';
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A permission error still proves that the process exists, notably on Windows.
    return new Set(['EPERM', 'EACCES']).has(String(code));
  }
}

function parseMetadata(value: string): DaemonMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const metadata = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(metadata.pid) || (metadata.pid as number) <= 0) return undefined;
    if (typeof metadata.startedAt !== 'string' || !metadata.startedAt) return undefined;
    if (!Number.isSafeInteger(metadata.protocolVersion) || (metadata.protocolVersion as number) < 0) return undefined;
    return {
      pid: metadata.pid as number,
      startedAt: metadata.startedAt as string,
      protocolVersion: metadata.protocolVersion as number
    };
  } catch {
    return undefined;
  }
}

function sameMetadata(left: DaemonMetadata, right: DaemonMetadata): boolean {
  return left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.protocolVersion === right.protocolVersion;
}

function removeIfOwned(path: string, metadata: DaemonMetadata): void {
  try {
    const existing = parseMetadata(readFileSync(path, 'utf8'));
    if (existing && sameMetadata(existing, metadata)) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Owns the daemon lock for one process and removes only files matching its metadata. */
export class DaemonInstanceLock {
  private home: AgentTeamHome | undefined;
  private metadata: DaemonMetadata | undefined;
  private readonly checkPid: PidAliveCheck;

  constructor(options: DaemonInstanceLockOptions | PidAliveCheck = {}) {
    this.checkPid = typeof options === 'function' ? options : options.isPidAlive ?? isPidAlive;
  }

  static acquire(
    home: AgentTeamHome,
    metadata?: DaemonMetadataInput,
    options?: DaemonInstanceLockOptions | PidAliveCheck
  ): DaemonInstanceLock {
    return new DaemonInstanceLock(options).acquire(home, metadata);
  }

  acquire(home: AgentTeamHome, input: DaemonMetadataInput = {}): this {
    if (this.metadata) throw new DaemonAlreadyRunningError(this.metadata);

    const metadata: DaemonMetadata = {
      pid: input.pid ?? process.pid,
      startedAt: input.startedAt ?? new Date().toISOString(),
      protocolVersion: input.protocolVersion ?? 1
    };
    if (!Number.isSafeInteger(metadata.pid) || metadata.pid <= 0) throw new TypeError('Daemon PID must be a positive integer');
    if (!metadata.startedAt) throw new TypeError('Daemon startedAt is required');
    if (!Number.isSafeInteger(metadata.protocolVersion) || metadata.protocolVersion < 0) {
      throw new TypeError('Daemon protocolVersion must be a non-negative integer');
    }

    mkdirSync(home.root, { recursive: true });
    const contents = `${JSON.stringify(metadata)}\n`;
    while (true) {
      try {
        writeFileSync(home.daemonLock, contents, { encoding: 'utf8', flag: 'wx' });
        try {
          writeFileSync(home.daemonInfo, contents, 'utf8');
        } catch (error) {
          removeIfOwned(home.daemonLock, metadata);
          throw error;
        }
        this.home = home;
        this.metadata = metadata;
        return this;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

        let existing: DaemonMetadata | undefined;
        try {
          existing = parseMetadata(readFileSync(home.daemonLock, 'utf8'));
        } catch (readError) {
          /* istanbul ignore next -- another process can remove the stale file here */
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw readError;
        }
        if (existing && this.pidIsAlive(existing.pid)) throw new DaemonAlreadyRunningError(existing);
        try {
          unlinkSync(home.daemonLock);
        } catch (unlinkError) {
          /* istanbul ignore next -- another process can remove the stale file here */
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
        }
      }
    }
  }

  release(): void {
    if (!this.home || !this.metadata) return;
    const { home, metadata } = this;
    this.home = undefined;
    this.metadata = undefined;
    removeIfOwned(home.daemonLock, metadata);
    removeIfOwned(home.daemonInfo, metadata);
  }

  private pidIsAlive(pid: number): boolean {
    try {
      return this.checkPid(pid);
    } catch (error) {
      return new Set(['EPERM', 'EACCES']).has(String((error as NodeJS.ErrnoException).code));
    }
  }
}
