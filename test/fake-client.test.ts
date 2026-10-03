import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FakeHerdrClient, parseResultFilePath } from '../src/herdr/fake-client.ts';
import { cleanupTempDir, makeTempDir } from './helpers.ts';

const fsRoot = await makeTempDir('ateam-fake-');

afterAll(async () => {
  await cleanupTempDir(fsRoot);
});

const RESULT_PATH = join(fsRoot, 'results', 'API', 'worker-a1c0.json');

function promptForResult(): string {
  return `You are the worker.\nRESULT FILE: ${RESULT_PATH}\n`;
}

describe('FakeHerdrClient', () => {
  test('worktree workspace creates all four resources with distinct ids', async () => {
    const fake = new FakeHerdrClient({ fsRoot });
    const handle = await fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'ateam/r1/API' });
    expect(handle.workspace.workspaceId).not.toBe('');
    expect(handle.tab.tabId).toContain(handle.workspace.workspaceId);
    expect(handle.rootPane.paneId).not.toBe('');
    expect(handle.worktree.path.startsWith(fsRoot)).toBe(true);
  });

  test('scripted agent walks states and writes result file', async () => {
    const fake = new FakeHerdrClient({
      fsRoot,
      scripts: {
        'at-test-w1': {
          kind: 'claude',
          sequence: ['working', 'working', 'done'],
          stepMs: 5,
          onState: { done: { writeResultFile: { status: 'completed', summary: 'ok' } } },
        },
      },
    });
    const pane = await fake.splitPane({ paneId: (await fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'b' })).rootPane.paneId });
    await fake.startAgent({ name: 'at-test-w1', kind: 'claude', paneId: pane.paneId, args: [] });
    const wait = await fake.promptAgent({
      target: 'at-test-w1', text: promptForResult(), wait: true,
      until: ['done', 'blocked'], timeoutMs: 5000,
    });
    expect(wait.state).toBe('done');
    // onState writes are fire-and-forget; poll for the commit point
    const { readFile } = await import('node:fs/promises');
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

  test('blocked sequence reaches blocked without result', async () => {
    const fake = new FakeHerdrClient({
      fsRoot,
      scripts: { 'at-b': { kind: 'codex', sequence: ['working', 'blocked'], stepMs: 5 } },
    });
    const ws = await fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'b' });
    await fake.startAgent({ name: 'at-b', kind: 'codex', paneId: ws.rootPane.paneId, args: [] });
    await fake.promptAgent({ target: 'at-b', text: 'start work', wait: false, until: [], timeoutMs: 100 });
    const wait = await fake.waitAgent({ target: 'at-b', until: ['blocked'], timeoutMs: 3000 });
    expect(wait.state).toBe('blocked');
  });

  test('fault injection: failAgentStart', async () => {
    const fake = new FakeHerdrClient({ fsRoot, faults: { failAgentStart: ['doomed'] } });
    await expect(fake.startAgent({ name: 'doomed', kind: 'claude', paneId: 'w:p1', args: [] })).rejects.toMatchObject({
      code: 'herdr_error',
    });
  });

  test('server restart wipes resources; call log records prompts', async () => {
    const fake = new FakeHerdrClient({ fsRoot });
    const ws = await fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'b' });
    await fake.startAgent({ name: 'a1', kind: 'claude', paneId: ws.rootPane.paneId, args: [] });
    await fake.promptAgent({ target: 'a1', text: promptForResult(), wait: false, until: [], timeoutMs: 100 });
    expect(fake.promptCount('a1')).toBe(1);
    fake.restartServer();
    expect(fake.agentCount()).toBe(0);
    expect((await fake.snapshot()).panes).toHaveLength(0);
    expect(fake.calls.filter((c) => c.method === 'promptAgent')).toHaveLength(1);
  });

  test('dropPane removes agent too', async () => {
    const fake = new FakeHerdrClient({ fsRoot });
    const ws = await fake.createWorktreeWorkspace({ sourceWorkspaceId: 'w0', branch: 'b' });
    await fake.startAgent({ name: 'a2', kind: 'claude', paneId: ws.rootPane.paneId, args: [] });
    fake.dropPane(ws.rootPane.paneId);
    expect(await fake.getAgent('a2')).toBeNull();
  });

  test('reportAgentState accumulates self-reports', async () => {
    const fake = new FakeHerdrClient({ fsRoot });
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
