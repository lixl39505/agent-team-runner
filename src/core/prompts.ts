import type { ResolvedSkill, ReviewResult, RunManifest, TaskSpec } from './types.js';
import { loadSkill } from './files.js';

const DIFF_LIMIT = 24_000;

export interface WorkerRetryContext {
  /** 当前 worktree 相对 startSha 的未提交改动（截断保护） */
  diff?: string | undefined;
  /** 上一轮 reviewer 的完整 JSON 结论 */
  review?: string | undefined;
  /** 上一轮 worker 的 summary */
  previousSummary?: string | undefined;
}

export function workerPrompt(input: {
  task: TaskSpec;
  startSha: string;
  runId: string;
  /** 任务 worktree 的绝对路径——模型必须在这里工作，越界变更会被机械验证拒绝 */
  worktreePath?: string;
  priorFeedback?: string | null;
  retry?: WorkerRetryContext | undefined;
  /** 已在提交执行契约时固化的本地 Skill 内容。 */
  skills?: readonly ResolvedSkill[];
}): string {
  const retry = input.retry
    ? `# Prior attempt context

The worktree still carries the previous attempt's uncommitted changes. Inspect them before editing.
${input.retry.diff ? `\n## Uncommitted diff (may be truncated)\n\n${truncate(input.retry.diff, DIFF_LIMIT)}\n` : ''}${input.retry.review ? `\n## Reviewer feedback (verbatim)\n\n${input.retry.review}\n` : ''}${input.retry.previousSummary ? `\n## Previous worker summary\n\n${input.retry.previousSummary}\n` : ''}`
    : '';
  const skills = input.skills?.filter((skill) => skill.role === 'worker') ?? [];
  const skillHandoff = skills.length === 0
    ? ''
    : `# Required implementation skills

Follow each skill below when it does not conflict with the Runner contract. These are immutable snapshots selected by the external workflow; do not fetch replacements or invoke an outer implementation workflow.

${skills.map((skill) => `## ${skill.name} (${skill.source}, sha256:${skill.sha256})

${skill.content}`).join('\n\n')}
`;
  return `${loadSkill('worker')}

# Runtime contract

Run ID: ${input.runId}
Task start SHA: ${input.startSha}
${input.worktreePath ? `Your working directory (the task worktree): ${input.worktreePath}\nAll file edits MUST use paths inside this directory (relative paths are preferred). The Runner mechanically rejects out-of-scope changes after the turn.\n` : ''}

Task specification:
${JSON.stringify(input.task, null, 2)}

${skillHandoff}${input.priorFeedback ? `# Previous failure or review feedback\n\n${input.priorFeedback}\n` : ''}${retry}
The Runner owns staging and commits. You may run the task verification commands while implementing; the Runner repeats them after your turn. Do not run git add, git commit, git merge, git rebase, git push, deployment, or production mutations. Work only inside the current worktree.

# Contract escalation

Use status \`blocked_on_contract\` only when continuing requires a change to the task contract: scope or path ownership, acceptance criteria, dependencies, required access or permission, or a missing/conflicting requirement. Do not use it for ordinary implementation failures or uncertainty, and never expand scope yourself. When using it, provide \`contractBlock\` with a code, a clear message, requestedContractChanges, and affectedPaths when known. Use ordinary \`blocked\` for non-contract blockers. At the end, return the structured Worker result.`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (truncated, ${text.length - limit} more characters)`;
}

export function reviewerPrompt(input: {
  task: TaskSpec;
  startSha: string;
  worktreePath?: string;
  workerResult: unknown;
  candidateDiff?: string | undefined;
  candidateFiles?: string[] | undefined;
}): string {
  return `${loadSkill('reviewer')}

# Runtime contract

Task specification:
${JSON.stringify(input.task, null, 2)}

Task start SHA: ${input.startSha}
${input.worktreePath ? `Your working directory (the task worktree): ${input.worktreePath}\nThe Runner has included the staged candidate diff below; use direct file-reading tools for additional context.\n` : ''}Worker report:
${JSON.stringify(input.workerResult, null, 2)}

${input.candidateFiles?.length ? `# Complete changed-file manifest\n\n${input.candidateFiles.map((file) => `- ${file}`).join('\n')}\n\n` : ''}${input.candidateDiff ? `# Staged candidate diff\n\n${truncate(input.candidateDiff, DIFF_LIMIT)}\n\n` : ''}The candidate changes are staged by the Runner (git add -A already ran). Read every affected file needed to cover the complete manifest; the inline diff may be truncated. Workers never commit — do not request commits; the Runner commits after your approval. Do not modify, stage, or commit anything. Return the structured review decision.`;
}

export function integrationPrompt(input: {
  manifest: RunManifest;
  worktreePath?: string;
  conflictFiles?: string[];
}): string {
  return `${loadSkill('integrator')}

# Runtime contract

A cherry-pick conflict is active. Resolve only these files: ${(input.conflictFiles ?? []).join(', ')}. Do not run cherry-pick --continue and do not commit.
${input.worktreePath ? `\nYour working directory (the integration worktree): ${input.worktreePath}\nRun all commands in this directory — do NOT cd anywhere else.\n` : ''}
Run manifest:
${JSON.stringify(input.manifest, null, 2)}

Return the structured integration result.`;
}

export function reviewFeedback(review: ReviewResult): string {
  return [
    review.summary,
    ...review.requiredChanges.map((value) => `- ${value}`),
    ...review.findings.map((finding) => `- [${finding.severity}] ${finding.file}${finding.line ? `:${finding.line}` : ''}: ${finding.message}`)
  ].join('\n');
}
