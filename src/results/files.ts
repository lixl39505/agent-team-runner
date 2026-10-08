// Result file conventions: path layout under the ATeam home, atomic write
// (<final>.partial then rename — the final path existing IS the commit
// point), and tamper-checked reads (digest compared across two reads).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RoleName } from './validate.ts';

export function resultsRoot(home: string, runId: string): string {
  return join(home, 'runs', runId, 'results');
}

export function resultPathFor(
  home: string,
  runId: string,
  taskId: string,
  role: RoleName,
  attemptNo: number,
  cycleNo = 0,
): string {
  const dir = resultsRoot(home, runId);
  switch (role) {
    case 'worker':
      return join(dir, taskId, `worker-a${attemptNo}c0.json`);
    case 'reviewer':
      return join(dir, taskId, `reviewer-a${attemptNo}c${cycleNo}.json`);
    case 'integrator':
      return join(dir, taskId, `integrator-a${attemptNo}.json`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

/** Write bytes to a temp file in the same directory, then rename over the final path. */
export async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, data, 'utf8');
  await rename(partial, path);
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export interface ReadResult<T> {
  value: T;
  digest: string;
}

/**
 * Read + parse a result file. The bytes are read twice and compared by
 * digest so a concurrent rewrite is detected instead of silently accepted.
 * Returns null when the file does not exist or cannot be read (not a commit
 * point yet) — an unreadable path is "no result", never a gate failure; the
 * real e2e hit EISDIR when a result path was occupied by a directory.
 */
export async function readResultFile<T = unknown>(path: string): Promise<ReadResult<T> | null> {
  let first: Buffer;
  try {
    first = await readFile(path);
  } catch {
    // ENOENT / EISDIR / EACCES / … — all mean "no readable result yet"
    return null;
  }
  const second = await readFile(path).catch(() => null);
  if (!second) return null; // vanished mid-read — not a commit point
  const digest = sha256Hex(first);
  if (digest !== sha256Hex(second)) {
    throw new Error(`result file changed between reads (possible concurrent rewrite): ${path}`);
  }
  try {
    return { value: JSON.parse(first.toString('utf8')) as T, digest };
  } catch {
    // unparseable content: the schema gate never sees it; the agent can
    // rewrite a valid result — treated identically to "not written yet"
    return null;
  }
}
