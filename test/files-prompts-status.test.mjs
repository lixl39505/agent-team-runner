import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureDir,
  loadSkill,
  readJson,
  readText,
  skillPath,
  syncSkills,
  writeJson,
  writeTaskMarkdown
} from '../src/core/files.ts';
import { integrationPrompt, reviewFeedback, reviewerPrompt, workerPrompt } from '../src/core/prompts.ts';
import { formatRunStatus } from '../src/core/status.ts';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'agent-team-files-'));
}

function withTempDir(callback) {
  const directory = tempDir();
  try {
    callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const task = {
  id: 'T001',
  title: 'Add tests',
  description: 'Cover all branches.',
  dependsOn: ['T000'],
  agent: 'focused-worker',
  allowedPaths: ['src/**'],
  blockedPaths: ['package.json'],
  acceptance: ['Tests pass'],
  verificationCommands: ['npm test']
};

test('file helpers create nested paths, serialize JSON, and read text', () => {
  withTempDir((directory) => {
    const nested = join(directory, 'one', 'two');
    ensureDir(nested);
    assert.equal(existsSync(nested), true);

    const jsonPath = join(directory, 'data', 'value.json');
    writeJson(jsonPath, { enabled: true, values: [1, 2] });
    assert.equal(readFileSync(jsonPath, 'utf8'), '{\n  "enabled": true,\n  "values": [\n    1,\n    2\n  ]\n}\n');
    assert.deepEqual(readJson(jsonPath), { enabled: true, values: [1, 2] });
    assert.equal(readText(jsonPath), readFileSync(jsonPath, 'utf8'));
  });
});

test('skill helpers resolve, load, and synchronize every role', () => {
  withTempDir((directory) => {
    for (const role of ['worker', 'reviewer', 'integrator']) {
      const source = skillPath(role);
      assert.equal(existsSync(source), true);
      const loaded = loadSkill(role);
      assert.equal(loaded.startsWith('---'), false);
      assert.equal(loaded.length > 0, true);
    }

    const written = syncSkills(directory);
    assert.equal(written.length, 6);
    for (const path of written) {
      assert.equal(existsSync(path), true);
      assert.equal(readText(path).startsWith('---\n'), true);
    }
  });
});

test('writeTaskMarkdown renders populated and empty task lists', () => {
  withTempDir((directory) => {
    const populated = join(directory, 'tasks', 'populated.md');
    writeTaskMarkdown(populated, task, 'abc123');
    const populatedText = readText(populated);
    assert.match(populatedText, /# T001 Add tests/);
    assert.match(populatedText, /- 任务 ID: T001/);
    assert.match(populatedText, /- Agent: focused-worker/);
    assert.match(populatedText, /- 依赖任务: T000/);
    assert.match(populatedText, /- src\/\*\*/);
    assert.match(populatedText, /- package\.json/);
    assert.match(populatedText, /- Tests pass/);
    assert.match(populatedText, /- npm test/);

    const empty = join(directory, 'tasks', 'empty.md');
    writeTaskMarkdown(empty, { ...task, agent: undefined, dependsOn: [], allowedPaths: [], blockedPaths: [], acceptance: [], verificationCommands: [] }, 'def456');
    const emptyText = readText(empty);
    assert.match(emptyText, /- 依赖任务: 无/);
    assert.match(emptyText, /- Agent: 继承 worker 角色配置/);
    assert.equal((emptyText.match(/- 无/g) ?? []).length, 4);
  });
});

test('workerPrompt renders optional worktree, feedback, and complete retry context', () => {
  const prompt = workerPrompt({
    task,
    startSha: 'start',
    runId: 'run-1',
    worktreePath: '/tmp/worktree',
    priorFeedback: 'Fix the assertion.',
    retry: {
      diff: `${'x'.repeat(24_001)}tail`,
      review: '{"decision":"changes_requested"}',
      previousSummary: 'Previous summary'
    }
  });
  assert.match(prompt, /Your working directory \(the task worktree\): \/tmp\/worktree/);
  assert.match(prompt, /# Previous failure or review feedback/);
  assert.match(prompt, /# Prior attempt context/);
  assert.match(prompt, /Uncommitted diff \(may be truncated\)/);
  assert.match(prompt, /… \(truncated, 5 more characters\)/);
  assert.match(prompt, /Reviewer feedback \(verbatim\)/);
  assert.match(prompt, /Previous worker summary/);

  const withoutOptionals = workerPrompt({ task, startSha: 'start', runId: 'run-2', priorFeedback: '', retry: {} });
  assert.equal(withoutOptionals.includes('Your working directory'), false);
  assert.equal(withoutOptionals.includes('Previous failure or review feedback'), false);
  assert.match(withoutOptionals, /# Prior attempt context/);
  assert.equal(withoutOptionals.includes('Uncommitted diff'), false);
  assert.equal(workerPrompt({ task, startSha: 'start', runId: 'run-3' }).includes('Prior attempt context'), false);
  assert.match(workerPrompt({ task, startSha: 'start', runId: 'run-4', retry: { diff: 'small diff' } }), /small diff/);
  const withSkill = workerPrompt({
    task,
    startSha: 'start',
    runId: 'run-5',
    skills: [
      { name: 'tdd', role: 'worker', source: 'project', path: '/tmp/tdd/SKILL.md', sha256: 'abc', content: 'Write a failing test first.' },
      { name: 'review', role: 'reviewer', source: 'project', path: '/tmp/review/SKILL.md', sha256: 'def', content: 'Do not show this to the worker.' }
    ]
  });
  assert.match(withSkill, /# Required worker skills/);
  assert.match(withSkill, /tdd \(project, sha256:abc\)/);
  assert.match(withSkill, /Write a failing test first/);
  assert.equal(withSkill.includes('Do not show this to the worker.'), false);
  assert.match(withSkill, /# Contract escalation/);
  assert.match(withSkill, /never expand scope yourself/);
});

test('reviewerPrompt and integrationPrompt render their conditional contexts and role-specific skills', () => {
  const skills = [
    { name: 'worker-skill', role: 'worker', source: 'project', path: '/tmp/worker/SKILL.md', sha256: 'worker-sha', content: 'Worker-only instruction.' },
    { name: 'reviewer-skill', role: 'reviewer', source: 'project', path: '/tmp/reviewer/SKILL.md', sha256: 'reviewer-sha', content: 'Reviewer-only instruction.' },
    { name: 'integrator-skill', role: 'integrator', source: 'project', path: '/tmp/integrator/SKILL.md', sha256: 'integrator-sha', content: 'Integrator-only instruction.' }
  ];
  const review = reviewerPrompt({
    task,
    startSha: 'start',
    worktreePath: '/tmp/worktree',
    workerResult: { status: 'completed' },
    candidateFiles: ['src/a.ts'],
    candidateDiff: `${'d'.repeat(24_001)}tail`,
    skills
  });
  assert.match(review, /Your working directory \(the task worktree\): \/tmp\/worktree/);
  assert.match(review, /# Complete changed-file manifest\n\n- src\/a.ts/);
  assert.match(review, /# Staged candidate diff/);
  assert.match(review, /… \(truncated, 5 more characters\)/);
  assert.match(review, /# Required reviewer skills/);
  assert.match(review, /Reviewer-only instruction/);
  assert.equal(review.includes('Worker-only instruction.'), false);
  assert.equal(review.includes('Integrator-only instruction.'), false);
  const bareReview = reviewerPrompt({ task, startSha: 'start', workerResult: null, candidateFiles: [], candidateDiff: '' });
  assert.equal(bareReview.includes('Your working directory'), false);
  assert.equal(bareReview.includes('Complete changed-file manifest'), false);
  assert.equal(bareReview.includes('Staged candidate diff'), false);
  assert.match(reviewerPrompt({ task, startSha: 'start', workerResult: null, candidateDiff: 'small diff' }), /# Staged candidate diff\n\nsmall diff/);

  const conflict = integrationPrompt({ manifest: { version: 1, title: 'Run', summary: 'Summary', tasks: [task] }, worktreePath: '/tmp/integration', conflictFiles: ['src/a.ts'], skills });
  assert.match(conflict, /A cherry-pick conflict is active\. Resolve only these files: src\/a\.ts\./);
  assert.match(conflict, /Your working directory \(the integration worktree\): \/tmp\/integration/);
  assert.match(conflict, /# Required integrator skills/);
  assert.match(conflict, /Integrator-only instruction/);
  assert.equal(conflict.includes('Worker-only instruction.'), false);
  assert.equal(conflict.includes('Reviewer-only instruction.'), false);
  assert.match(integrationPrompt({ manifest: { version: 1, title: 'Run', summary: 'Summary', tasks: [] } }), /Resolve only these files: \./);
});

test('reviewFeedback formats summaries, required changes, and findings', () => {
  assert.equal(reviewFeedback({
    decision: 'changes_requested',
    summary: 'Needs work',
    requiredChanges: ['Add a test'],
    findings: [
      { severity: 'high', file: 'src/a.ts', line: 4, message: 'Broken' },
      { severity: 'low', file: 'src/b.ts', message: 'Nit' }
    ]
  }), 'Needs work\n- Add a test\n- [high] src/a.ts:4: Broken\n- [low] src/b.ts: Nit');
  assert.equal(reviewFeedback({ decision: 'approved', summary: 'Looks good', requiredChanges: [], findings: [] }), 'Looks good');
});

test('formatRunStatus handles empty runs, task details, integration fields, and errors', () => {
  const baseRun = {
    id: 'run-1', repoRoot: '/repo', goalFile: '/repo/goal.md', baseRef: 'main', baseSha: '1234567890abcdef', adapter: 'codex', status: 'running', manifestJson: null, rolesJson: null,
    integrationBranch: null, integrationWorktree: null, integrationCommit: null, error: null, createdAt: '', updatedAt: '', finishedAt: null
  };
  assert.equal(formatRunStatus(baseRun, []), 'RUN run-1\nStatus: running\nBase: main (1234567890ab)\nExecution source: codex\n');

  const status = formatRunStatus({ ...baseRun, integrationBranch: 'team/run-1', integrationWorktree: '/tmp/integration', integrationCommit: 'commit', error: 'integration failed' }, [
    { runId: 'run-1', taskId: 'LONG-1', title: 'First', specJson: '{}', status: 'failed', phase: null, branch: null, worktree: null, startSha: null, commitSha: 'abcdef123456', attempts: 2, reviewCycles: 0, lastError: 'first line\nsecond line', reviewJson: null, createdAt: '', updatedAt: '', finishedAt: null },
    { runId: 'run-1', taskId: 'T2', title: 'Second', specJson: '{}', status: 'approved', phase: null, branch: null, worktree: null, startSha: null, commitSha: null, attempts: 1, reviewCycles: 0, lastError: 'ignored', reviewJson: null, createdAt: '', updatedAt: '', finishedAt: null },
    { runId: 'run-1', taskId: 'T3', title: 'Third', specJson: '{}', status: 'blocked', phase: null, branch: null, worktree: null, startSha: null, commitSha: null, attempts: 3, reviewCycles: 0, lastError: null, reviewJson: null, createdAt: '', updatedAt: '', finishedAt: null }
  ]);
  assert.match(status, /LONG-1  failed             First attempt=2 abcdef1234/);
  assert.match(status, /        first line/);
  assert.match(status, /T2      approved           Second attempt=1/);
  assert.equal(status.includes('ignored'), false);
  assert.match(status, /Integration branch: team\/run-1/);
  assert.match(status, /Integration worktree: \/tmp\/integration/);
  assert.match(status, /Integration commit: commit/);
  assert.match(status, /Run error: integration failed/);
});
