// Task brief generation. The brief is the authoritative task document an
// agent reads inside its worktree (.ateam/brief.md); the CLI prompt just
// points at it (Windows argv limits the inline prompt).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256Hex } from '../results/files.ts';
import { buildBriefMarkdown, resultSchemaExample } from '../results/prompts.ts';
import type { ExecutionContract, SkillRef, TaskSpec } from '../core/types.ts';
import type { ExecutionRole } from '../core/types.ts';

export interface ResolvedSkill {
  ref: SkillRef;
  name: string;
  content: string;
  sha256: string;
}

const SKILL_DIRS = ['.agents/skills', 'skills', '.claude/skills'];

/** Resolve skill content from the repo; throws for required skills that are missing. */
export async function resolveSkills(repoRoot: string, refs: SkillRef[] | undefined): Promise<ResolvedSkill[]> {
  if (!refs || refs.length === 0) return [];
  const out: ResolvedSkill[] = [];
  for (const ref of refs) {
    let content: string | null = null;
    for (const dir of SKILL_DIRS) {
      const candidate = join(repoRoot, dir, ref.name, 'SKILL.md');
      try {
        content = await readFile(candidate, 'utf8');
        break;
      } catch {
        /* try next */
      }
    }
    if (content === null) {
      if (ref.required) throw new Error(`required skill "${ref.name}" not found in ${repoRoot}`);
      continue;
    }
    const sha256 = sha256Hex(content);
    if (ref.sha256 && ref.sha256 !== sha256) {
      throw new Error(`skill "${ref.name}" sha256 mismatch (contract pinned ${ref.sha256}, got ${sha256})`);
    }
    out.push({ ref, name: ref.name, content, sha256 });
  }
  return out;
}

export interface BriefInput {
  role: ExecutionRole;
  runId: string;
  contract: ExecutionContract;
  task: TaskSpec;
  startSha: string;
  worktreePath: string;
  resultPath: string;
  retry?: {
    attemptNo?: number;
    lastWorkerSummary?: string;
    lastReview?: unknown;
  };
  /** Extra runner-authored instructions (e.g. integration conflict files). */
  notes?: string;
  skills: ResolvedSkill[];
}

/** Write .ateam/brief.md into the worktree; returns its sha256. */
export async function writeBrief(input: BriefInput): Promise<string> {
  const markdown = buildBriefMarkdown({
    role: input.role,
    runId: input.runId,
    runRepoRoot: input.contract.project.repoRoot,
    baseRef: input.contract.project.baseRef,
    startSha: input.startSha,
    taskId: input.task.id,
    specJson: JSON.stringify(input.task, null, 2),
    skillSnapshots: input.skills.map((s) => ({ name: s.name, content: s.content })),
    retry: input.retry,
    resultSchemaExample: resultSchemaExample(input.role),
    verificationCommands: input.task.verificationCommands,
    acceptance: input.task.acceptance,
    notes: input.notes,
  });
  const path = join(input.worktreePath, '.ateam', 'brief.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, 'utf8');
  return sha256Hex(markdown);
}
