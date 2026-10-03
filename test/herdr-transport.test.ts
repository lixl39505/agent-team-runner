import { afterAll, describe, expect, test } from 'bun:test';
import { HerdrCliTransport, bunSpawner } from '../src/herdr/cli-transport.ts';
import { HerdrCliRuntimeClient } from '../src/herdr/runtime-client.ts';
import { HerdrError } from '../src/herdr/types.ts';
import { FAKE_HERDR_FIXTURE, clearHerdrControl, setHerdrControl } from './helpers.ts';

const PREFIX = [process.execPath] as const;

afterAll(async () => {
  await clearHerdrControl();
});

function transport(control: Record<string, unknown> = {}): HerdrCliTransport {
  void setHerdrControl(control);
  return new HerdrCliTransport(FAKE_HERDR_FIXTURE, bunSpawner, PREFIX);
}

function client(control: Record<string, unknown> = {}): HerdrCliRuntimeClient {
  void setHerdrControl(control);
  return new HerdrCliRuntimeClient({ herdrPath: FAKE_HERDR_FIXTURE, argvPrefix: PREFIX });
}

describe('HerdrCliTransport', () => {
  test('callText returns trimmed stdout', async () => {
    expect(await transport().callText(['--version'])).toMatch(/0\.8\.0/);
  });

  test('callJson unwraps and parses', async () => {
    const doc = await transport().callJson<Record<string, unknown>>(['api', 'schema', '--json']);
    expect(doc).toBeDefined();
  });

  test('missing binary → herdr_not_found', async () => {
    await clearHerdrControl();
    const t = new HerdrCliTransport(process.platform === 'win32' ? 'Z:/no/such/herdr.exe' : '/no/such/herdr', bunSpawner);
    await expect(t.ping()).rejects.toMatchObject({ code: expect.any(String) });
  });

  test('structured stderr error → HerdrError with code', async () => {
    const err = await transport({ mode: 'error' }).callJson(['pane', 'close', 'w1:p1', '--json']).catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe('not_found');
  });

  test('usage exit code 2 → herdr_error', async () => {
    const err = await transport({ mode: 'usage' }).callJson(['bogus']).catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe('herdr_error');
  });

  test('garbage stdout → invalid_response', async () => {
    const err = await transport({ mode: 'garbage' }).callJson(['--version']).catch((e) => e);
    expect((err as HerdrError).code).toBe('invalid_response');
  });

  test('hang → timeout error', async () => {
    const err = await transport({ mode: 'hang' })
      .callText(['--version'], { timeoutMs: 250 })
      .catch((e) => e);
    expect((err as HerdrError).code).toBe('timeout');
  }, 10_000);
});

describe('HerdrCliRuntimeClient mapping', () => {
  test('probe reports version + capabilities', async () => {
    const probe = await client().probe();
    expect(probe.version).toMatch(/0\.8\.0/);
    expect(probe.capabilities.worktree).toBe(true);
    expect(probe.capabilities.agent).toBe(true);
    expect(probe.capabilities.sessionSnapshot).toBe(true);
  });

  test('createWorktreeWorkspace captures ids from response', async () => {
    const handle = await client().createWorktreeWorkspace({ sourceWorkspaceId: 'w1', branch: 'ateam/r1/API' });
    expect(handle.workspace.workspaceId).toBe('w9');
    expect(handle.rootPane.paneId).toBe('w9:p');
    expect(handle.worktree.branch).toBe('ateam/r1/API');
    expect(handle.worktree.path).toContain('ateam-r1-API');
  });

  test('splitPane returns pane id from result', async () => {
    const pane = await client().splitPane({ paneId: 'w1:p' });
    expect(pane.paneId).toBe('w1:p7');
  });

  test('getAgent maps state + native session ref', async () => {
    const agent = await client({ agentState: 'blocked' }).getAgent('reviewer');
    expect(agent?.state).toBe('blocked');
    expect(agent?.nativeSessionRef).toBe('sess-42');
  });

  test('readPane returns plain text', async () => {
    const text = await client().readPane({ paneId: 'w1:p' });
    expect(text).toContain('line two');
  });

  test('snapshot normalizes records', async () => {
    const snap = await client().snapshot();
    expect(snap.workspaces[0]?.workspaceId).toBe('w1');
    expect(snap.workspaces[0]?.worktree?.branch).toBe('ateam/r1/API');
    expect(snap.panes[0]?.paneId).toBe('w1:p');
    expect(snap.agents[0]?.state).toBe('blocked');
  });

  test('subscribe throws unsupported_transport on CLI-only client', async () => {
    const err = await client().subscribe().catch((e) => e);
    expect((err as HerdrError).code).toBe('unsupported_transport');
  });
});
