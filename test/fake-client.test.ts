import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { FakeHerdrClient, parseResultFilePath } from '../src/herdr/fake-client.ts';
import { cleanupTempDir, initRepo, makeTempDir } from './helpers.ts';

const fsRoot = await makeTempDir('ateam-fake-');
const repoRoot = join(fsRoot, 'repo');
await initRepo(repoRoot);

afterAll(async () => {
  await cleanupTempDir(fsRoot);
});

const RESULT_PATH = join(fsRoot, 'results', 'API', 'worker-a1c0.json');

function promptForResult(): string {
  return `You are the worker.\nRESULT FILE: ${RESULT_PATH}\n`;
}

describe('FakeHerdrClient', () => {
  test('worktree workspace creates a real git worktree', async () => {
    const fake = new FakeHerdrClient({ fsRoot, repoRoot });
    const handle = await fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'ateam/t1/API' });
    expect(handle.worktree.path.startsWith(fsRoot)).toBe(true);
    const head = await readFile(join(handle.worktree.path, 'README.md'), 'utf8');
    expect(head.replace(/\r\n/g, '\n')).toBe('# test\n');
  });

  test('scripted agent walks states, edits files and writes result', async () => {
    const fake = new FakeHerdrClient({
      fsRoot,
      repoRoot,
      scripts: {
        'at-t1-api-w1': {
          kind: 'claude',
          sequence: ['working', 'done'],
          stepMs: 5,
          onState: {
            done: {
              editFiles: [['src/api/x.ts', 'export const a = 1;\n']],
              writeResultFile: { status: 'completed', summary: 'ok' },
            },
          },
        },
      },
    });
    const ws = await fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'ateam/t2/API' });
    const pane = await fake.splitPane({ paneId: ws.rootPane.paneId });
    await fake.startAgent({ name: 'at-t1-api-w1', kind: 'claude', paneId: pane.paneId, args: [] });
    const wait = await fake.promptAgent({
      target: 'at-t1-api-w1', text: promptForResult(), wait: true,
      until: ['done', 'blocked'], timeoutMs: 5000,
    });
    expect(wait.state).toBe('done');
    const edited = await readFile(join(ws.worktree.path, 'src', 'api', 'x.ts'), 'utf8');
    expect(edited).toContain('export const a');
    let text: string | null = null;
    for (let i = 0; i < 200 && text === null; i++) {
      try {
        text = await readFile(RESULT_PATH, 'utf8');
      } catch {
        await Bun.sleep(10);
      }
    }
    expect(text).not.toBeNull();
    expect(JSON.parse(text!)).toEqual({ status: 'completed', summary: 'ok' });
  });

  test('pauseAt holds the walk until resumeAgent', async () => {
    const fake = new FakeHerdrClient({
      fsRoot,
      repoRoot,
      scripts: {
        'at-b': { kind: 'codex', sequence: ['working', 'blocked', 'working', 'done'], stepMs: 5, pauseAt: 'blocked' },
      },
    });
    const ws = await fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'ateam/t3/B' });
    await fake.startAgent({ name: 'at-b', kind: 'codex', paneId: ws.rootPane.paneId, args: [] });
    await fake.promptAgent({ target: 'at-b', text: 'start', wait: false, until: [], timeoutMs: 100 });
    await fake.waitAgent({ target: 'at-b', until: ['blocked'], timeoutMs: 3000 });
    expect(fake.agentState('at-b')).toBe('blocked');
    fake.resumeAgent('at-b');
    const done = await fake.waitAgent({ target: 'at-b', until: ['done'], timeoutMs: 3000 });
    expect(done.state).toBe('done');
  });

  test('fault injection: failAgentStart', async () => {
    const fake = new FakeHerdrClient({ fsRoot, repoRoot, faults: { failAgentStart: ['doomed'] } });
    const ws = await fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'ateam/t4/X' });
    await expect(fake.startAgent({ name: 'doomed', kind: 'claude', paneId: ws.rootPane.paneId, args: [] })).rejects.toMatchObject({
      code: 'herdr_error',
    });
  });

  test('server restart wipes resources; call log records prompts', async () => {
    const fake = new FakeHerdrClient({ fsRoot, repoRoot });
    const ws = await fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'ateam/t5/Y' });
    await fake.startAgent({ name: 'a1', kind: 'claude', paneId: ws.rootPane.paneId, args: [] });
    await fake.promptAgent({ target: 'a1', text: promptForResult(), wait: false, until: [], timeoutMs: 100 });
    expect(fake.promptCount('a1')).toBe(1);
    fake.restartServer();
    expect(fake.agentCount()).toBe(0);
    expect((await fake.snapshot()).panes).toHaveLength(0);
    expect(fake.calls.filter((c) => c.method === 'promptAgent')).toHaveLength(1);
  });

  test('dropPane removes agent too', async () => {
    const fake = new FakeHerdrClient({ fsRoot, repoRoot });
    const ws = await fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'ateam/t6/Z' });
    await fake.startAgent({ name: 'a2', kind: 'claude', paneId: ws.rootPane.paneId, args: [] });
    fake.dropPane(ws.rootPane.paneId);
    expect(await fake.getAgent('a2')).toBeNull();
  });

  test('reportAgentState accumulates self-reports', async () => {
    const fake = new FakeHerdrClient({ fsRoot, repoRoot });
    await fake.reportAgentState({ paneId: 'me:p', agent: 'me', state: 'working' });
    await fake.reportAgentState({ paneId: 'me:p', agent: 'me', state: 'blocked', message: 'waiting' });
    expect(fake.getSelfReports().map((r) => r.state)).toEqual(['working', 'blocked']);
  });
});

describe('parseResultFilePath', () => {
  test('finds the marker line', () => {
    expect(parseResultFilePath('intro\nRESULT FILE: /x/y.json\nend')).toBe('/x/y.json');
    expect(parseResultFilePath('no marker')).toBeNull();
  });
});
