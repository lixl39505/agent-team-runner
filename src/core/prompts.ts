import type { ReviewResult, RunManifest, TaskSpec } from './types.js';
import { loadSkill } from './files.js';

export function leadPrompt(input: {
  goal: string;
  goalFile: string;
  repoRoot: string;
  baseRef: string;
  baseSha: string;
  allowedCommandPrefixes: string[];
}): string {
  return `${loadSkill('lead')}

# Runtime context

Repository: ${input.repoRoot}
Base ref: ${input.baseRef}
Base SHA: ${input.baseSha}
Goal file: ${input.goalFile}

# Initial goal

${input.goal}

# Verification command policy

Every verification command must begin with one of these allowlisted prefixes:
${input.allowedCommandPrefixes.map((value) => `- ${value}`).join('\n')}

Inspect the repository before decomposing the work. Return only the structured task manifest. Do not modify repository files.`;
}

export function workerPrompt(input: {
  task: TaskSpec;
  startSha: string;
  runId: string;
  priorFeedback?: string | null;
}): string {
  return `${loadSkill('worker')}

# Runtime contract

Run ID: ${input.runId}
Task start SHA: ${input.startSha}

Task specification:
${JSON.stringify(input.task, null, 2)}

${input.priorFeedback ? `# Previous failure or review feedback\n\n${input.priorFeedback}\n` : ''}

The Runner owns staging and commits. Do not run git add, git commit, git merge, git rebase, git push, deployment, or production mutations. Work only inside the current worktree. At the end, return the structured Worker result.`;
}

export function reviewerPrompt(input: {
  task: TaskSpec;
  startSha: string;
  workerResult: unknown;
}): string {
  return `${loadSkill('reviewer')}

# Runtime contract

Task specification:
${JSON.stringify(input.task, null, 2)}

Task start SHA: ${input.startSha}
Worker report:
${JSON.stringify(input.workerResult, null, 2)}

The candidate changes are staged. Inspect them with git diff --cached and read the affected files. Do not modify, stage, or commit anything. Return the structured review decision.`;
}

export function integrationPrompt(input: {
  manifest: RunManifest;
  integrationAllowedPaths: string[];
  mode: 'resolve_conflict' | 'finalize';
  conflictFiles?: string[];
}): string {
  const modeText = input.mode === 'resolve_conflict'
    ? `A cherry-pick conflict is active. Resolve only these files: ${(input.conflictFiles ?? []).join(', ')}. Do not run cherry-pick --continue and do not commit.`
    : `Inspect the integrated result. Update architecture/progress documentation only when warranted. You may modify only: ${input.integrationAllowedPaths.join(', ')}. Do not stage or commit.`;
  return `${loadSkill('integrator')}

# Runtime contract

Mode: ${input.mode}
${modeText}

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
