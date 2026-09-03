import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AgentTeamHome } from './home.js';
import { StateDatabase } from './db.js';
import { agentList } from './agent-config.js';
import type { ExecutionContract, RunManifest } from './types.js';
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
  // 验证通过后再扩大写入集合：spec 实际变化的既有任务与新增任务也必须重写。
  // 修订可能移除旧图下游对 blocked 的依赖：该任务不在上面的新图闭包内，但其内容
  // 已按新契约变化（上一步已保证变化只落在旧图下游），若不更新就会留下
  // 「contract.json 已是新版、tasks.spec_json 与任务 Markdown 仍是旧版」的偏差。
  for (const task of contract.tasks) {
    const current = currentById.get(task.id);
    if (current === undefined || current.specJson !== JSON.stringify(task)) affected.add(task.id);
  }
  const skillRoots = localSkillRoots(config.workspace.repoRoot);
  const revisedSkills = new Map(
    contract.tasks
      .filter((task) => affected.has(task.id) && currentById.get(task.id)?.status !== 'approved')
      .map((task) => [task.id, snapshotTaskSkills(task, skillRoots)])
  );
  // 阶段一：全部产物先写入临时文件并备份旧内容——磁盘错误在任何 DB 变更之前暴露。
  const runDir = join(home.runsDir, runId);
  const staged: Array<{ tmp: string; final: string; previous: string | null }> = [];
  const stage = (final: string, content: string): void => {
    mkdirSync(dirname(final), { recursive: true });
    const tmp = join(dirname(final), `.${basename(final)}.tmp-${process.pid}`);
    writeFileSync(tmp, content, 'utf8');
    staged.push({ tmp, final, previous: existsSync(final) ? readFileSync(final, 'utf8') : null });
  };
  stage(join(runDir, 'contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
  for (const taskId of [...affected].sort()) {
    const task = proposedById.get(taskId)!;
    stage(join(runDir, 'tasks', `${task.id}.md`), taskMarkdownContent(task, run.baseSha));
  }

  // 阶段二：DB 变更、文件就位与事件在同一临界区提交——DB 用事务回滚，文件用备份恢复，
  // 任一步失败都不会留下 DB、contract.json、任务 Markdown 互相矛盾的半套状态。
  let revision = 0;
  try {
    db.transaction(() => {
      for (const task of contract.tasks) {
        const current = currentById.get(task.id);
        if (current === undefined) {
          db.insertTask(runId, task, revisedSkills.get(task.id));
          continue;
        }
        if (affected.has(task.id) && current.status !== 'approved') {
          db.replaceTaskSpec(runId, task, revisedSkills.get(task.id));
        }
      }
      revision = db.appendContractRevision(runId, JSON.stringify(contract));
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
    });
  } catch (error) {
    // 文件回滚尽力而为：恢复旧内容或删除新增文件，并清理残留的临时文件。
    for (const { tmp, final, previous } of staged) {
      try {
        if (previous === null) rmSync(final, { force: true });
        else if (existsSync(final)) writeFileSync(final, previous, 'utf8');
      } catch {
        // 原始错误更有诊断价值。
      }
      rmSync(tmp, { force: true });
    }
    throw error;
  }
  return { runId, revision, affectedTaskIds: [...affected].sort() };
}

