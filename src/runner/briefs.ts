// Task brief generation. The brief is the authoritative task document an
// agent reads inside its worktree (.ateam/brief.md); the CLI prompt just
// points at it (Windows argv limits the inline prompt).

import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { sha256Hex } from '../results/files.ts';
import { buildBriefMarkdown, resultSchemaExample } from '../results/prompts.ts';
import { SKILL_NAME_PATTERN } from '../core/contract.ts';
import type { ExecutionContract, SkillRef, TaskSpec } from '../core/types.ts';
import type { ExecutionRole } from '../core/types.ts';

export interface ResolvedSkill {
  ref: SkillRef;
  name: string;
  content: string;
  sha256: string;
}

const SKILL_DIRS = ['.agents/skills', 'skills', '.claude/skills'];

/**
 * Candidate path for a skill inside one skill root, or null when the name
 * is not a single safe segment or would resolve outside that root. Names
 * are already constrained by contract validation; this is defense in depth
 * against specs restored from storage or other lower-trust sources.
 *
 * Review 02 R2-09: the lexical prefix check alone does not stop symlink
 * escape — `readFile` follows a symlink placed INSIDE the skill root. Both
 * the root and the candidate are therefore `realpath`ed and containment is
 * enforced on the REAL paths; an in-root symlink pointing outside resolves
 * to "skill not found" instead of an out-of-repo read.
 */
export async function skillCandidatePath(skillRoot: string, name: string): Promise<string | null> {
  if (!SKILL_NAME_PATTERN.test(name)) return null;
  const root = resolve(skillRoot);
  const candidate = resolve(root, name, 'SKILL.md');
  if (!candidate.startsWith(root + sep)) return null;
  let realRoot: string;
  let realCandidate: string;
  try {
    [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  } catch {
    return null; // root or candidate does not exist (or is a dangling link)
  }
  return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep) ? candidate : null;
}

/** Resolve skill content from the repo; throws for required skills that are missing. */
export async function resolveSkills(repoRoot: string, refs: SkillRef[] | undefined): Promise<ResolvedSkill[]> {
  if (!refs || refs.length === 0) return [];
  const out: ResolvedSkill[] = [];
  for (const ref of refs) {
    if (!SKILL_NAME_PATTERN.test(ref.name)) {
      throw new Error(`skill name "${ref.name}" is not a single safe path segment; refusing to resolve`);
    }
    let content: string | null = null;
    for (const dir of SKILL_DIRS) {
      const candidate = await skillCandidatePath(join(repoRoot, dir), ref.name);
      if (!candidate) continue;
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

/** Write .ateam/brief.md into the worktree; returns its sha256. Refuses to
 * write through a symlinked `.ateam`/brief.md — a hostile worktree could
 * otherwise redirect the runner's own bookkeeping outside the worktree
 * (review 02 R2-09). */
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
  const dir = join(input.worktreePath, '.ateam');
  const dirStat = await lstat(dir).catch(() => null);
  if (dirStat) {
    if (!dirStat.isDirectory()) {
      throw new Error(`refusing to write brief: ${dir} exists and is not a real directory (symlink?)`);
    }
  } else {
    await mkdir(dir, { recursive: true });
  }
  const path = join(dir, 'brief.md');
  const fileStat = await lstat(path).catch(() => null);
  if (fileStat && !fileStat.isFile()) {
    throw new Error(`refusing to write brief: ${path} exists and is not a regular file (symlink?)`);
  }
  await writeFile(path, markdown, 'utf8');
  return sha256Hex(markdown);
}
