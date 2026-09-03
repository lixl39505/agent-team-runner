import { resolve } from 'node:path';
import { open, realpath } from 'node:fs/promises';
import { StateDatabase } from './db.js';
import { isWithinDirectory } from './files.js';

export const DEFAULT_AGENT_LOG_LINES = 100;
export const MAX_AGENT_LOG_LINES = 200;
export const DEFAULT_AGENT_LOG_BYTES = 16 * 1024;
export const MAX_AGENT_LOG_BYTES = 64 * 1024;

export interface AgentLogTail {
  runId: string;
  agentId: string;
  content: string;
  lineCount: number;
  byteCount: number;
  truncated: boolean;
}

export async function readAgentLog(
  db: StateDatabase,
  runsDir: string,
  runId: string,
  agentId: string,
  maxLines: number,
  maxBytes: number
): Promise<AgentLogTail> {
  let logPath: string;
  try {
    logPath = db.getAgentExecution(runId, agentId).logPath;
  } catch {
    throw new Error(`Agent log is not recorded: ${runId}/${agentId}`);
  }

  const runDirectory = resolve(runsDir, runId);
  const requestedPath = resolve(logPath);
  // Only runner-recorded logs within this run's managed directory may be read.
  if (!isWithinDirectory(requestedPath, runDirectory)) {
    throw new Error(`Agent log is outside the managed run directory: ${runId}/${agentId}`);
  }

  let resolvedRunDirectory: string;
  let resolvedLogPath: string;
  try {
    [resolvedRunDirectory, resolvedLogPath] = await Promise.all([realpath(runDirectory), realpath(requestedPath)]);
  } catch (error) {
    throw agentLogReadError(runId, agentId, error);
  }
  // Resolve symlinks as well so a managed-looking path cannot escape the run directory.
  if (!isWithinDirectory(resolvedLogPath, resolvedRunDirectory)) {
    throw new Error(`Agent log is outside the managed run directory: ${runId}/${agentId}`);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(resolvedLogPath, 'r');
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('NOT_REGULAR_FILE');
    const byteCount = Math.min(metadata.size, maxBytes);
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, Math.max(0, metadata.size - byteCount));
    const captured = buffer.subarray(0, bytesRead).toString('utf8');
    const capturedLines = captured.length === 0 ? [] : captured.endsWith('\n') ? captured.slice(0, -1).split('\n') : captured.split('\n');
    const lines = capturedLines.slice(-maxLines).map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
    return {
      runId,
      agentId,
      content: lines.join('\n'),
      lineCount: lines.length,
      byteCount: bytesRead,
      truncated: metadata.size > bytesRead || capturedLines.length > lines.length
    };
  } catch (error) {
    /* istanbul ignore if -- non-regular in-run targets already fail the stat check above. */
    if (error instanceof Error && error.message === 'NOT_REGULAR_FILE') {
      throw new Error(`Agent log is not readable: ${runId}/${agentId} is not a regular file`);
    }
    throw agentLogReadError(runId, agentId, error);
  } finally {
    await handle?.close();
  }
}

export function agentLogReadError(runId: string, agentId: string, error: unknown): Error {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
  if (code === 'ENOENT') return new Error(`Agent log does not exist: ${runId}/${agentId}`);
  if (code === 'EACCES' || code === 'EPERM') return new Error(`Agent log is not readable: ${runId}/${agentId}`);
  return new Error(`Agent log is unavailable: ${runId}/${agentId}${code ? ` (${code})` : ''}`);
}
