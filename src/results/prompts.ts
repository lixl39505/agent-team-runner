// Prompt templates. The CLI prompt is intentionally short (Windows argv
// limits); the full task brief is written to <worktree>/.ateam/brief.md and
// the prompt just points at it.

import type { ExecutionRole } from '../core/types.ts';

export interface RolePromptInput {
  role: ExecutionRole;
  runId: string;
  taskId: string;
  attemptNo: number;
  cycleNo: number;
  worktreePath: string;
  resultPath: string;
}

/**
 * Short prompt injected via `herdr agent prompt`. The line
 * `RESULT FILE: <abs path>` is a machine-parsable contract (test doubles
 * and diagnostics rely on it — keep the exact prefix).
 */
export function buildRolePrompt(input: RolePromptInput): string {
  return [
    `You are the ${input.role} for ATeam run ${input.runId}, task ${input.taskId} (attempt ${input.attemptNo}, cycle ${input.cycleNo}).`,
    `Working directory: ${input.worktreePath}`,
    `First read .ateam/brief.md in this directory and follow it exactly.`,
    `When finished, write your complete role result as ONE JSON document, atomically (write to <path>.partial then rename it) to:`,
    `RESULT FILE: ${input.resultPath}`,
    `Terminal output and your idle/done state are NOT completion. The result file is.`,
    `Do not git add, commit, push, or edit files outside your allowed paths.`,
  ].join('\n');
}

export interface BriefContext {
  role: ExecutionRole;
  runId: string;
  runRepoRoot: string;
  baseRef: string;
  startSha: string;
  taskId: string;
  specJson: string;
  skillSnapshots: Array<{ name: string; content: string }>;
  retry?: {
    attemptNo?: number;
    lastWorkerSummary?: string;
    lastReview?: unknown;
  };
  notes?: string;
  resultSchemaExample: string;
  verificationCommands?: string[];
  acceptance?: string[];
}

export function buildBriefMarkdown(ctx: BriefContext): string {
  const sections: string[] = [];
  sections.push(`# ATeam Brief — ${ctx.role} · task ${ctx.taskId}`);
  sections.push(
    [
      `- run: ${ctx.runId}`,
      `- repo root: ${ctx.runRepoRoot}`,
      `- base ref: ${ctx.baseRef}`,
      `- start SHA (your worktree HEAD): ${ctx.startSha}`,
    ].join('\n'),
  );

  sections.push('## Task specification (authoritative)\n```json\n' + ctx.specJson + '\n```');

  if (ctx.acceptance?.length) {
    sections.push('## Acceptance\n' + ctx.acceptance.map((a) => `- ${a}`).join('\n'));
  }
  if (ctx.verificationCommands?.length) {
    sections.push(
      '## Mechanical verification commands (the runner will execute these)\n' +
        ctx.verificationCommands.map((c) => '```sh\n' + c + '\n```').join('\n'),
    );
  }
  if (ctx.skillSnapshots.length > 0) {
    sections.push(
      '## Role skills (frozen snapshots)\n' +
        ctx.skillSnapshots.map((s) => `### ${s.name}\n\n${s.content}`).join('\n\n'),
    );
  }
  if (ctx.retry) {
    const parts = [`This is attempt ${ctx.retry.attemptNo}. Previous outcome:`];
    if (ctx.retry.lastWorkerSummary) parts.push(`\nWorker summary:\n${ctx.retry.lastWorkerSummary}`);
    if (ctx.retry.lastReview !== undefined) {
      parts.push('\nReviewer verdict (address every required change):\n```json\n' + JSON.stringify(ctx.retry.lastReview, null, 2) + '\n```');
    }
    sections.push(parts.join('\n'));
  }
  if (ctx.notes) {
    sections.push(`## Runner notes\n${ctx.notes}`);
  }

  sections.push(
    [
      '## Result protocol',
      '',
      'Your entire deliverable is ONE JSON document written atomically to the path',
      'given in your prompt (`RESULT FILE:` line). Write `<path>.partial` first, then',
      'rename it to the final path. Terminal output is not a completion signal.',
      '',
      'Schema your document must satisfy:',
      '```json',
      ctx.resultSchemaExample,
      '```',
      '',
      '## Scope escalation',
      'If the task cannot be done within its allowed paths, acceptance, or dependencies,',
      'do NOT improvise. Set status to `blocked_on_contract` and describe exactly what',
      'must change in `contractBlock`. Only the outer planner can widen scope via a',
      'contract revision.',
    ].join('\n'),
  );

  return sections.join('\n\n') + '\n';
}

export const WORKER_RESULT_EXAMPLE = `{
  "status": "completed",
  "summary": "what you did and how",
  "testsRun": ["bun test"],
  "knownRisks": [],
  "changedPaths": ["src/foo.ts"]
}`;

export const REVIEWER_RESULT_EXAMPLE = `{
  "status": "approved",
  "summary": "review verdict",
  "findings": [{"severity": "low", "file": "src/foo.ts", "line": 12, "message": "nit"}],
  "requiredChanges": [],
  "reviewedFiles": ["src/foo.ts"]
}`;

export const INTEGRATOR_RESULT_EXAMPLE = `{
  "status": "completed",
  "summary": "integration outcome",
  "testsRun": ["bun test"],
  "knownRisks": [],
  "resolvedConflicts": []
}`;

export function resultSchemaExample(role: ExecutionRole): string {
  switch (role) {
    case 'worker':
      return WORKER_RESULT_EXAMPLE;
    case 'reviewer':
      return REVIEWER_RESULT_EXAMPLE;
    case 'integrator':
      return INTEGRATOR_RESULT_EXAMPLE;
  }
}
