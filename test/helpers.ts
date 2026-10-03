import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const FAKE_HERDR_FIXTURE = join(import.meta.dir, 'fixtures', 'fake-herdr.ts');

/** The fixture reads control-<ppid>.json; the ppid is this test process. */
export async function setHerdrControl(control: Record<string, unknown>): Promise<void> {
  const path = join(dirname(FAKE_HERDR_FIXTURE), `control-${process.pid}.json`);
  await writeFile(path, JSON.stringify(control), 'utf8');
}

export async function clearHerdrControl(): Promise<void> {
  await rm(join(dirname(FAKE_HERDR_FIXTURE), `control-${process.pid}.json`), { force: true });
}

export async function makeTempDir(prefix = 'ateam-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const run = async (...args: string[]): Promise<void> => {
    const proc = Bun.spawn(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
    }
  };
  await run('init', '-b', 'main');
  await run('config', 'user.email', 'ateam@test.local');
  await run('config', 'user.name', 'ateam-test');
  await writeFile(join(dir, 'README.md'), '# test\n');
  await run('add', '-A');
  await run('commit', '-m', 'init');
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(path.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

/** Write a file creating parent directories as needed. */
export async function writeFileDeep(path: string, content: string): Promise<void> {
  await mkdir(path.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  await writeFile(path, content, 'utf8');
}

export function minimalContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    project: { id: 'demo', repoRoot: 'D:/ws/demo', baseRef: 'main' },
    tasks: [
      {
        id: 'API',
        title: 'api task',
        allowedPaths: ['src/api/**'],
        verificationCommands: ['bun test'],
      },
      {
        id: 'WEB',
        title: 'web task',
        allowedPaths: ['src/web/**'],
      },
    ],
    ...overrides,
  };
}
