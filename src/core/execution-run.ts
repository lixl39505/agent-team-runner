import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { snapshotAgents } from '../agent/registry.js';
import { agentList } from './agent-config.js';
import { StateDatabase } from './db.js';
import { writeJson, writeTaskMarkdown } from './files.js';
import { ensureGitRepo, revParse } from './git.js';
import { assertAllowedCommand } from './shell.js';
import type { ExecutionContract, RunManifest, RunnerConfig } from './types.js';
import { validateExecutionContract } from './validation.js';

function createRunId(now: Date): string {
  const timestamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  return `execution-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
}

/**
 * Materialize a validated external execution contract without invoking a Lead.
 * The resulting run is directly consumable by the existing orchestrator.
 */
export async function createExecutionRun(input: {
  config: RunnerConfig;
  db: StateDatabase;
  contract: unknown;
  projectPolicyRevisionId?: string;
  runId?: string;
  /** Test seam for deterministic generated run ids. */
  now?: () => Date;
}): Promise<string> {
  const validAgentNames = agentList(input.config).map((agent) => agent.name);
  const contract: ExecutionContract = validateExecutionContract(input.contract, validAgentNames);
  for (const task of contract.tasks) {
    for (const command of task.verificationCommands) {
      assertAllowedCommand(command, input.config.verification.allowedCommandPrefixes);
    }
  }
  const repoRoot = resolve(input.config.workspace.repoRoot);
  const contractRepoRoot = resolve(contract.project.repoRoot);
  if (contractRepoRoot !== repoRoot) {
    throw new Error(`Execution contract repository does not match configured workspace: ${contractRepoRoot} !== ${repoRoot}`);
  }

  const runId = input.runId ?? createRunId((input.now ?? (() => new Date()))());
  assertSafeRunId(runId);
  await ensureGitRepo(repoRoot);
  const baseSha = await revParse(repoRoot, contract.project.baseRef);

  input.db.createRun({
    id: runId,
    repoRoot,
    goalFile: '<execution-contract>',
    baseRef: contract.project.baseRef,
    baseSha,
    projectId: contract.project.id,
    projectPolicyRevisionId: input.projectPolicyRevisionId ?? null,
    executionContractJson: JSON.stringify(contract),
    adapter: 'external'
  });

  try {
    const runDir = join(input.config.workspace.stateDir, 'runs', runId);
    const manifest: RunManifest = {
      version: 1,
      title: `External execution run ${runId}`,
      summary: `Execution contract for run ${runId}.`,
      tasks: contract.tasks
    };
    writeJson(join(runDir, 'contract.json'), contract);
    for (const task of contract.tasks) {
      input.db.insertTask(runId, task);
      writeTaskMarkdown(join(runDir, 'tasks', `${task.id}.md`), task, baseSha);
    }
    input.db.updateRun(runId, {
      status: 'planned',
      manifestJson: JSON.stringify(manifest),
      rolesJson: JSON.stringify(snapshotAgents(input.config))
    });
    input.db.addEvent(runId, null, 'EXECUTION_CONTRACT_CREATED', {
      projectId: contract.project.id,
      taskCount: contract.tasks.length,
      baseSha
    });
    return runId;
  } catch (error) {
    input.db.updateRun(runId, { status: 'failed', error: String(error), finishedAt: new Date().toISOString() });
    input.db.addEvent(runId, null, 'EXECUTION_CONTRACT_FAILED', { error: String(error) });
    throw error;
  }
}
