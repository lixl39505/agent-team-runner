import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { LeadResult, RunnerConfig } from './types.js';
import { StateDatabase } from './db.js';
import { buildBackends, disposeBackends, resolveAgent, snapshotAgents } from '../agent/registry.js';
import { runAgent } from '../agent/supervise.js';
import { readOnlyPolicy } from './policy.js';
import { agentList } from './agent-config.js';
import { LEAD_SCHEMA, validateLeadResult } from './validation.js';
import { ensureGitRepo, revParse } from './git.js';
import { leadPrompt } from './prompts.js';
import { writeJson, writeTaskMarkdown } from './files.js';
import { assertAllowedCommand } from './shell.js';

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'run';
}

export async function planRun(input: {
  config: RunnerConfig;
  db: StateDatabase;
  goalFile: string;
  runId?: string;
}): Promise<string> {
  const repoRoot = input.config.repoRoot;
  await ensureGitRepo(repoRoot);
  const goalFile = resolve(repoRoot, input.goalFile);
  const goal = readFileSync(goalFile, 'utf8');
  const leadBinding = resolveAgent('lead', input.config);
  const baseSha = await revParse(repoRoot, input.config.baseRef);
  const runId = input.runId ?? `${slug(basename(goalFile).replace(/\.[^.]+$/, ''))}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const runDir = join(input.config.stateDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });

  input.db.createRun({
    id: runId,
    repoRoot,
    goalFile,
    baseRef: input.config.baseRef,
    baseSha,
    adapter: leadBinding.backend
  });

  try {
    const backends = buildBackends(input.config);
    let manifest: LeadResult | null = null;
    let priorError = '';
    try {
      for (let attempt = 1; attempt <= input.config.maxPlanAttempts; attempt += 1) {
        const registry = agentList(input.config);
        const prompt = leadPrompt({
          goal, goalFile, repoRoot, baseRef: input.config.baseRef, baseSha,
          allowedCommandPrefixes: input.config.verification.allowedCommandPrefixes,
          agents: registry.map(({ name, backend, model, description }) => ({ name, backend, model, description }))
        }) + (priorError ? `

# Previous manifest validation failure

${priorError}
Return a corrected full manifest.` : '');
        const result = await runAgent<LeadResult>({
          backend: backends[leadBinding.backend],
          spec: {
            role: 'lead', cwd: repoRoot,
            prompt,
            schema: LEAD_SCHEMA,
            ...(leadBinding.model !== undefined ? { model: leadBinding.model } : {}),
            ...(leadBinding.maxTurns !== undefined ? { maxTurns: leadBinding.maxTurns } : {}),
            policy: readOnlyPolicy(),
            timeoutMs: input.config.taskTimeoutMs, staleAfterMs: input.config.staleAfterMs
          },
          logPath: join(runDir, 'logs', `lead-${attempt}.log`),
          outputPath: join(runDir, `lead-result-${attempt}.json`)
        });
        if (!result.ok || !result.output) {
          priorError = `Lead failed: ${result.error ?? 'no structured output'}`;
          continue;
        }
        try {
          manifest = validateLeadResult(result.output, registry.map((entry) => entry.name));
          for (const task of manifest.tasks) {
            for (const command of task.verificationCommands) {
              assertAllowedCommand(command, input.config.verification.allowedCommandPrefixes);
            }
          }
          break;
        } catch (error) {
          priorError = String(error);
          input.db.addEvent(runId, null, 'PLAN_VALIDATION_FAILED', { attempt, error: priorError });
        }
      }
    } finally {
      disposeBackends(backends);
    }
    if (!manifest) throw new Error(`Lead could not produce a valid manifest: ${priorError}`);
    writeJson(join(runDir, 'manifest.json'), manifest);
    for (const task of manifest.tasks) {
      input.db.insertTask(runId, task);
      writeTaskMarkdown(join(runDir, 'tasks', `${task.id}.md`), task, baseSha);
    }
    input.db.updateRun(runId, {
      status: 'planned',
      manifestJson: JSON.stringify(manifest),
      rolesJson: JSON.stringify(snapshotAgents(input.config))
    });
    input.db.addEvent(runId, null, 'PLAN_COMPLETED', { taskCount: manifest.tasks.length });
    return runId;
  } catch (error) {
    input.db.updateRun(runId, { status: 'failed', error: String(error), finishedAt: new Date().toISOString() });
    input.db.addEvent(runId, null, 'PLAN_FAILED', { error: String(error) });
    throw error;
  }
}
