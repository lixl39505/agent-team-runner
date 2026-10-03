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
 * Returns null when the file does not exist (not a commit point yet).
 */
export async function readResultFile<T = unknown>(path: string): Promise<ReadResult<T> | null> {
  let first: Buffer;
  try {
    first = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const second = await readFile(path);
  const digest = sha256Hex(first);
  if (digest !== sha256Hex(second)) {
    throw new Error(`result file changed between reads (possible concurrent rewrite): ${path}`);
  }
  return { value: JSON.parse(first.toString('utf8')) as T, digest };
}
