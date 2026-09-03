import { basename, dirname, join } from 'node:path';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import type { AgentTeamHome } from './home.js';
import { StateDatabase } from './db.js';
import { agentList } from './agent-config.js';
import type { ExecutionContract, RunManifest, TaskSpec } from './types.js';
import { validateExecutionContract } from './validation.js';
import { assertExecutionContractFields } from './validation.js';
import { assertAllowedCommand } from './shell.js';
import { taskMarkdownContent } from './files.js';

import { localSkillRoots, snapshotTaskSkills } from './skill-handoff.js';
import { ProjectRegistry } from './project-registry.js';
import { runnerConfigFromProjectPolicy } from './project-runtime.js';

export interface ApplyContractRevisionInput {
  db: StateDatabase;
  projectRegistry: ProjectRegistry;
  home: AgentTeamHome;
  runId: string;
  contract: unknown;
}

export interface ContractRevisionResult {
  runId: string;
  revision: number;
  affectedTaskIds: string[];
}

/**
 * Applies a revised execution contract to a settled run. Approved tasks are immutable;
 * only blocked_on_contract tasks and their transitive downstream may change, and new
 * tasks must depend on an affected task. Callers must ensure the run is not active.
 */
export function applyContractRevision(input: ApplyContractRevisionInput): ContractRevisionResult {
  const { db, projectRegistry, home, runId } = input;
  assertExecutionContractFields(input.contract);
  const run = db.getRun(runId);
  if (!run.executionContractJson || !run.projectId) throw new Error(`Run ${runId} has no external execution contract`);
  const project = projectRegistry.getProject(run.projectId);
  const policy = run.projectPolicyRevisionId
    ? projectRegistry.getProjectPolicyRevision(project.id, run.projectPolicyRevisionId)
    : projectRegistry.getProjectPolicy(project.id);
  const config = runnerConfigFromProjectPolicy(policy, project, home);
  const contract = validateExecutionContract(input.contract, agentList(config).map((agent) => agent.name));
  for (const task of contract.tasks) {
    for (const command of task.verificationCommands) assertAllowedCommand(command, config.verification.allowedCommandPrefixes);
  }
  const currentContract = JSON.parse(run.executionContractJson) as ExecutionContract;
  if (contract.project.id !== currentContract.project.id
    || contract.project.repoRoot !== currentContract.project.repoRoot
    || contract.project.baseRef !== currentContract.project.baseRef) {
    throw new Error('Contract revision cannot change the run project or base ref');
  }
  const currentTasks = db.listTasks(runId);
  const proposedById = new Map(contract.tasks.map((task) => [task.id, task]));
  for (const task of currentTasks) {
    const proposed = proposedById.get(task.taskId);
    if (!proposed) throw new Error(`Contract revision cannot remove task ${task.taskId}`);
    if (task.status === 'approved' && task.specJson !== JSON.stringify(proposed)) {
      throw new Error(`Contract revision cannot change approved task ${task.taskId}`);
    }
  }
  const blocked = currentTasks.filter((task) => task.status === 'blocked_on_contract').map((task) => task.taskId);
  if (blocked.length === 0) throw new Error(`Run ${runId} has no blocked_on_contract task`);
  // 「可修改基线」按旧契约图计算：原 blocked 及其在旧图中的下游。
  // 以新图计算会让既有独立任务借新增对 blocked 的依赖混入可改集合。
  const oldTasks = (JSON.parse(run.executionContractJson) as ExecutionContract).tasks;
  const modifiable = new Set(blocked);
  while (true) {
    const next = oldTasks.filter((task) => task.dependsOn.some((dependency) => modifiable.has(dependency)));
    const additions = next.filter((task) => !modifiable.has(task.id));
    if (additions.length === 0) break;
    for (const task of additions) modifiable.add(task.id);
  }
  const affected = new Set(blocked);
  while (true) {
    const next = contract.tasks.filter((task) => task.dependsOn.some((dependency) => affected.has(dependency)));
    const additions = next.filter((task) => !affected.has(task.id));
    if (additions.length === 0) break;
    for (const task of additions) affected.add(task.id);
  }
  const currentById = new Map(currentTasks.map((task) => [task.taskId, task]));
  // Validate every mutation before writing anything: a rejected revision must
  // leave the run exactly as it was (no partially reset tasks).
  for (const task of contract.tasks) {
    const current = currentById.get(task.id);
    if (!current) {
      if (!task.dependsOn.some((dependency) => affected.has(dependency))) {
        throw new Error(`New task ${task.id} must depend on a contract-blocked task`);
      }
      continue;
    }
    if (!modifiable.has(task.id) && current.specJson !== JSON.stringify(task)) {
      throw new Error(`Contract revision can only change blocked tasks or their downstream tasks: ${task.id}`);
    }
  }
  const skillRoots = localSkillRoots(config.workspace.repoRoot);
  const revisedSkills = new Map(
    contract.tasks
      .filter((task) => affected.has(task.id) && currentById.get(task.id)?.status !== 'approved')
      .map((task) => [task.id, snapshotTaskSkills(task, skillRoots)])
  );
  for (const task of contract.tasks) {
    const current = currentById.get(task.id);
    if (!current) {
      db.insertTask(runId, task, revisedSkills.get(task.id));
      affected.add(task.id);
      continue;
    }
    if (affected.has(task.id) && current.status !== 'approved') {
      db.replaceTaskSpec(runId, task, revisedSkills.get(task.id));
    }
  }
  // 先把全部文件写到临时位置，DB 提交成功后再原子就位：磁盘失败不会留下
  // 「DB 已提交而 contract.json/任务 Markdown 仍是旧版」的半套状态。
  const runDir = join(home.runsDir, runId);
  const staged: Array<{ tmp: string; final: string }> = [];
  const stage = (final: string, content: string): void => {
    mkdirSync(dirname(final), { recursive: true });
    const tmp = join(dirname(final), `.${basename(final)}.tmp-${process.pid}`);
    writeFileSync(tmp, content, 'utf8');
    staged.push({ tmp, final });
  };
  stage(join(runDir, 'contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
  for (const taskId of affected) {
    const task = proposedById.get(taskId)!;
    stage(join(runDir, 'tasks', `${task.id}.md`), taskMarkdownContent(task, run.baseSha));
  }

  const revision = db.appendContractRevision(runId, JSON.stringify(contract));
  const manifest: RunManifest = {
    version: 1,
    title: `External execution run ${runId}`,
    summary: `Execution contract revision ${revision} for run ${runId}.`,
    tasks: contract.tasks
  };
  db.updateRun(runId, {
    status: 'queued',
    error: null, finishedAt: null, manifestJson: JSON.stringify(manifest)
  });
  for (const { tmp, final } of staged) renameSync(tmp, final);
  db.addEvent(runId, null, 'EXECUTION_CONTRACT_UPDATED', { revision, affectedTaskIds: [...affected].sort() });
  return { runId, revision, affectedTaskIds: [...affected].sort() };
}

