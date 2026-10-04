// Skill resolution path safety + brief writing (review 01 #8).

import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSkills, skillCandidatePath, writeBrief } from '../src/runner/briefs.ts';

const repo = (root: string, dir: string): string => join(root, dir);

async function makeRepoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ateam-briefs-'));
  await mkdir(repo(root, 'skills/alpha'), { recursive: true });
  await writeFile(repo(root, 'skills/alpha/SKILL.md'), '# alpha skill\n', 'utf8');
  // a secret OUTSIDE every skill root — traversal attempts must never reach it
  await writeFile(repo(root, 'secret.txt'), 'TOP SECRET\n', 'utf8');
  return root;
}

describe('skillCandidatePath', () => {
  test('unsafe names never resolve to a path', () => {
    for (const name of ['../escape', 'a/b', '.hidden', '..', '/etc', 'C:\\x']) {
      expect(skillCandidatePath('/repo/skills', name)).toBeNull();
    }
  });

  test('safe names stay inside the skill root', () => {
    const p = skillCandidatePath('/repo/skills', 'alpha');
    expect(p).toContain('alpha');
    expect(p!.startsWith('/repo/skills')).toBe(true);
  });
});

describe('resolveSkills', () => {
  test('resolves from the skills dir and pins sha256', async () => {
    const root = await makeRepoFixture();
    try {
      const skills = await resolveSkills(root, [{ name: 'alpha', required: true }]);
      expect(skills).toHaveLength(1);
      expect(skills[0]!.content).toBe('# alpha skill\n');
      expect(skills[0]!.sha256).toHaveLength(64);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('traversal names are refused before any file read', async () => {
    const root = await makeRepoFixture();
    try {
      // would resolve to <root>/secret.txt if the name joined naively
      await expect(resolveSkills(root, [{ name: '..' } as never])).rejects.toThrow(/safe path segment/);
      await expect(resolveSkills(root, [{ name: '../secret.txt' } as never])).rejects.toThrow(/safe path segment/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('optional missing skills are skipped, required ones throw', async () => {
    const root = await makeRepoFixture();
    try {
      expect(await resolveSkills(root, [{ name: 'nope' }])).toEqual([]);
      expect(resolveSkills(root, [{ name: 'nope', required: true }])).rejects.toThrow(/required skill/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('writeBrief', () => {
  test('writes .ateam/brief.md and returns its digest', async () => {
    const root = await makeRepoFixture();
    try {
      const worktree = await mkdtemp(join(tmpdir(), 'ateam-wt-'));
      const sha = await writeBrief({
        role: 'worker',
        runId: 'r-test',
        contract: {
          version: 1,
          project: { id: 'demo', repoRoot: root, baseRef: 'main' },
          tasks: [],
        },
        task: { id: 'A1', title: 't', allowedPaths: ['a/**'] },
        startSha: 'abc',
        worktreePath: worktree,
        resultPath: join(worktree, 'result.json'),
        skills: [],
      });
      expect(sha).toHaveLength(64);
      const brief = await Bun.file(join(worktree, '.ateam', 'brief.md')).text();
      expect(brief).toContain('A1');
      await rm(worktree, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
