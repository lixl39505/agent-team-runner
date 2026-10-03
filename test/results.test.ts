import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { atomicWriteJson, readResultFile, resultPathFor, sha256Hex } from '../src/results/files.ts';
import { validateIntegratorResult, validateReviewerResult, validateWorkerResult } from '../src/results/validate.ts';
import { buildRolePrompt, buildBriefMarkdown, resultSchemaExample } from '../src/results/prompts.ts';
import { cleanupTempDir, makeTempDir } from './helpers.ts';

describe('worker result validator', () => {
  const base = { summary: 'did the thing', testsRun: ['bun test'], knownRisks: [], changedPaths: ['src/a.ts'] };

  test('accepts completed', () => {
    expect(() => validateWorkerResult({ status: 'completed', ...base })).not.toThrow();
  });

  test('unknown fields rejected', () => {
    expect(() => validateWorkerResult({ status: 'completed', ...base, sneaky: true })).toThrow(/sneaky/);
  });

  test('blocked requires blockedReason', () => {
    expect(() => validateWorkerResult({ status: 'blocked', ...base })).toThrow(/blockedReason/);
    expect(() => validateWorkerResult({ status: 'blocked', ...base, blockedReason: 'waiting on creds' })).not.toThrow();
  });

  test('blocked_on_contract requires contractBlock and forbids blockedReason', () => {
    expect(() => validateWorkerResult({ status: 'blocked_on_contract', ...base })).toThrow(/contractBlock/);
    const withBlock = {
      status: 'blocked_on_contract',
      ...base,
      blockedReason: 'x',
      contractBlock: { code: 'out_of_scope', message: 'm', requestedContractChanges: ['add path'], affectedPaths: ['p'] },
    };
    expect(() => validateWorkerResult(withBlock)).toThrow(/blockedReason/);
    expect(() => {
      const { blockedReason: _drop, ...ok } = withBlock;
      void _drop;
      return validateWorkerResult(ok);
    }).not.toThrow();
  });

  test('completed must not carry escalation fields', () => {
    expect(() =>
      validateWorkerResult({
        status: 'completed', ...base,
        contractBlock: { code: 'other', message: 'm', requestedContractChanges: [], affectedPaths: [] },
      }),
    ).toThrow(/contractBlock/);
  });

  test('bad contractBlock code rejected', () => {
    expect(() =>
      validateWorkerResult({
        status: 'blocked_on_contract', ...base,
        contractBlock: { code: 'wat', message: 'm', requestedContractChanges: [], affectedPaths: [] },
      }),
    ).toThrow(/contractBlock\.code/);
  });
});

describe('reviewer result validator', () => {
  const base = { summary: 'looks good', findings: [], reviewedFiles: ['src/a.ts'] };

  test('approved with empty requiredChanges', () => {
    expect(() => validateReviewerResult({ status: 'approved', ...base, requiredChanges: [] })).not.toThrow();
  });

  test('changes_requested requires non-empty requiredChanges', () => {
    expect(() => validateReviewerResult({ status: 'changes_requested', ...base, requiredChanges: [] })).toThrow(/requiredChanges/);
    expect(() =>
      validateReviewerResult({ status: 'changes_requested', ...base, requiredChanges: ['fix null check'] }),
    ).not.toThrow();
  });

  test('approved forbids requiredChanges', () => {
    expect(() => validateReviewerResult({ status: 'approved', ...base, requiredChanges: ['x'] })).toThrow(/must be empty/);
  });

  test('finding validation', () => {
    expect(() =>
      validateReviewerResult({
        status: 'approved', summary: 's', requiredChanges: [], reviewedFiles: [],
        findings: [{ severity: 'catastrophic', file: 'a', message: 'm' }],
      }),
    ).toThrow(/severity/);
    expect(() =>
      validateReviewerResult({
        status: 'approved', summary: 's', requiredChanges: [], reviewedFiles: [],
        findings: [{ severity: 'high', file: 'a', line: 0, message: 'm' }],
      }),
    ).toThrow(/line/);
  });
});

describe('integrator result validator', () => {
  const base = { summary: 'merged', testsRun: [], knownRisks: [], resolvedConflicts: [] };

  test('completed ok; failed requires blockedReason', () => {
    expect(() => validateIntegratorResult({ status: 'completed', ...base })).not.toThrow();
    expect(() => validateIntegratorResult({ status: 'failed', ...base })).toThrow(/blockedReason/);
  });
});

describe('result files', () => {
  let home: string;
  beforeAll(async () => {
    home = await makeTempDir('ateam-results-');
  });
  afterAll(async () => {
    await cleanupTempDir(home);
  });

  test('path layout per role', () => {
    expect(resultPathFor(home, 'r1', 'API', 'worker', 1)).toContain(join('API', 'worker-a1c0.json'));
    expect(resultPathFor(home, 'r1', 'API', 'reviewer', 1, 2)).toContain(join('API', 'reviewer-a1c2.json'));
    expect(resultPathFor(home, 'r1', 'API', 'integrator', 3)).toContain(join('API', 'integrator-a3.json'));
  });

  test('atomic write leaves no partial behind and reads back', async () => {
    const path = resultPathFor(home, 'r-x', 'API', 'worker', 1);
    await atomicWriteJson(path, { status: 'completed' });
    const read = await readResultFile(path);
    expect(read?.value).toEqual({ status: 'completed' });
    expect(read?.digest).toBe(sha256Hex(`${JSON.stringify({ status: 'completed' }, null, 2)}\n`));
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(path, '..'))).some((f) => f.endsWith('.partial'))).toBe(false);
  });

  test('missing file returns null (not a commit point)', async () => {
    expect(await readResultFile(join(home, 'nope.json'))).toBeNull();
  });
});

describe('prompts', () => {
  test('prompt carries machine-parsable result path', () => {
    const prompt = buildRolePrompt({
      role: 'worker', runId: 'r1', taskId: 'API', attemptNo: 1, cycleNo: 0,
      worktreePath: '/wt/api', resultPath: '/home/results/API/worker-a1c0.json',
    });
    expect(prompt).toContain('RESULT FILE: /home/results/API/worker-a1c0.json');
    expect(prompt).toContain('.ateam/brief.md');
    expect(prompt.length).toBeLessThan(2000);
  });

  test('brief includes spec, retry context and schema example', () => {
    const brief = buildBriefMarkdown({
      role: 'reviewer', runId: 'r1', runRepoRoot: '/repo', baseRef: 'main', startSha: 'abc123',
      taskId: 'API', specJson: '{"id":"API"}',
      skillSnapshots: [{ name: 'team-reviewer', content: 'be rigorous' }],
      retry: { attemptNo: 2, lastReview: { status: 'changes_requested' } },
      resultSchemaExample: resultSchemaExample('reviewer'),
    });
    expect(brief).toContain('# ATeam Brief — reviewer · task API');
    expect(brief).toContain('{"id":"API"}');
    expect(brief).toContain('be rigorous');
    expect(brief).toContain('changes_requested');
    expect(brief).toContain('abc123');
  });
});
