// Structural validation of ExecutionContract v1 + DAG checks + exclusive
// path ownership. Unknown fields are rejected (hand-written validator, the
// JSON Schema files are documentation for the outer planner).

import type { ExecutionContract, SkillRef, TaskSpec } from './types.ts';
import { CONTRACT_VERSION } from './types.ts';
import { ContractInvalidError } from './errors.ts';
import { ownershipConflict } from './path-policy.ts';

export const TASK_ID_PATTERN = /^[A-Z][A-Z0-9_-]{1,31}$/;

type Raw = Record<string, unknown>;

function asRaw(value: unknown, what: string, issues: string[]): Raw {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(`${what} must be an object`);
    return {};
  }
  return value as Raw;
}

function str(value: unknown, what: string, issues: string[], opts: { optional?: boolean } = {}): string | undefined {
  if (value === undefined) {
    if (!opts.optional) issues.push(`${what} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${what} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function strArray(value: unknown, what: string, issues: string[], opts: { optional?: boolean } = {}): string[] | undefined {
  if (value === undefined) {
    if (!opts.optional) issues.push(`${what} is required`);
    return undefined;
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    issues.push(`${what} must be an array of non-empty strings`);
    return undefined;
  }
  return value as string[];
}

function bool(value: unknown, what: string, issues: string[], opts: { optional?: boolean } = {}): boolean | undefined {
  if (value === undefined) {
    if (!opts.optional) issues.push(`${what} is required`);
    return undefined;
  }
  if (typeof value !== 'boolean') {
    issues.push(`${what} must be a boolean`);
    return undefined;
  }
  return value;
}

export function isAbsoluteRepoPath(p: string): boolean {
  return /^([A-Za-z]:[\\/]|\/|\\\\)/.test(p);
}

function validateSkillRef(value: unknown, what: string, issues: string[]): SkillRef | undefined {
  const raw = asRaw(value, what, issues);
  const name = str(raw.name, `${what}.name`, issues);
  if (name === undefined) return undefined;
  const ref: SkillRef = { name };
  if (raw.role !== undefined) {
    if (raw.role !== 'worker' && raw.role !== 'reviewer' && raw.role !== 'integrator') {
      issues.push(`${what}.role must be worker|reviewer|integrator`);
    } else {
      ref.role = raw.role;
    }
  }
  const required = bool(raw.required, `${what}.required`, issues, { optional: true });
  if (required !== undefined) ref.required = required;
  const source = str(raw.source, `${what}.source`, issues, { optional: true });
  if (source !== undefined) ref.source = source;
  const sha = str(raw.sha256, `${what}.sha256`, issues, { optional: true });
  if (sha !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(sha)) issues.push(`${what}.sha256 must be lowercase hex sha256`);
    else ref.sha256 = sha;
  }
  const known = ['name', 'role', 'required', 'source', 'sha256'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) issues.push(`${what}.${key}: unknown field`);
  }
  return ref;
}

function validateTask(value: unknown, issues: string[]): TaskSpec | undefined {
  const raw = asRaw(value, 'task', issues);
  const known = [
    'id', 'externalId', 'title', 'description', 'agent', 'dependsOn',
    'allowedPaths', 'blockedPaths', 'acceptance', 'verificationCommands',
    'implementationSkills', 'implementationGuidance', 'allowNoChanges',
  ];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) issues.push(`task.${key}: unknown field`);
  }

  const id = str(raw.id, 'task.id', issues);
  if (id !== undefined && !TASK_ID_PATTERN.test(id)) {
    issues.push(`task.id "${id}" must match ${TASK_ID_PATTERN.source}`);
  }
  const title = str(raw.title, 'task.title', issues);
  const allowedPaths = strArray(raw.allowedPaths, 'task.allowedPaths', issues);
  if (allowedPaths !== undefined && allowedPaths.length === 0) {
    issues.push('task.allowedPaths must not be empty');
  }

  const spec: TaskSpec = { id: id ?? '', title: title ?? '', allowedPaths: allowedPaths ?? [] };

  const externalId = str(raw.externalId, 'task.externalId', issues, { optional: true });
  if (externalId !== undefined) spec.externalId = externalId;
  const description = str(raw.description, 'task.description', issues, { optional: true });
  if (description !== undefined) spec.description = description;
  const agent = str(raw.agent, 'task.agent', issues, { optional: true });
  if (agent !== undefined) spec.agent = agent;
  const dependsOn = strArray(raw.dependsOn, 'task.dependsOn', issues, { optional: true });
  if (dependsOn !== undefined) spec.dependsOn = [...new Set(dependsOn)];
  const blockedPaths = strArray(raw.blockedPaths, 'task.blockedPaths', issues, { optional: true });
  if (blockedPaths !== undefined) spec.blockedPaths = blockedPaths;
  const acceptance = strArray(raw.acceptance, 'task.acceptance', issues, { optional: true });
  if (acceptance !== undefined) spec.acceptance = acceptance;
  const verificationCommands = strArray(raw.verificationCommands, 'task.verificationCommands', issues, { optional: true });
  if (verificationCommands !== undefined) spec.verificationCommands = verificationCommands;
  const guidance = str(raw.implementationGuidance, 'task.implementationGuidance', issues, { optional: true });
  if (guidance !== undefined) spec.implementationGuidance = guidance;
  const allowNoChanges = bool(raw.allowNoChanges, 'task.allowNoChanges', issues, { optional: true });
  if (allowNoChanges !== undefined) spec.allowNoChanges = allowNoChanges;
  if (raw.implementationSkills !== undefined) {
    if (!Array.isArray(raw.implementationSkills)) {
      issues.push('task.implementationSkills must be an array');
    } else {
      const refs: SkillRef[] = [];
      raw.implementationSkills.forEach((entry, i) => {
        const ref = validateSkillRef(entry, `task.implementationSkills[${i}]`, issues);
        if (ref) refs.push(ref);
      });
      spec.implementationSkills = refs;
    }
  }
  return spec;
}

/** Validate an unknown document into an ExecutionContract, or throw. */
export function validateContract(document: unknown): ExecutionContract {
  const issues: string[] = [];
  const raw = asRaw(document, 'contract', issues);

  const known = ['version', 'project', 'provenance', 'tasks'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) issues.push(`contract.${key}: unknown field`);
  }

  if (raw.version !== CONTRACT_VERSION) {
    issues.push(`contract.version must be ${CONTRACT_VERSION}`);
  }

  const project = asRaw(raw.project, 'contract.project', issues);
  for (const key of Object.keys(project)) {
    if (!['id', 'repoRoot', 'baseRef'].includes(key)) issues.push(`contract.project.${key}: unknown field`);
  }
  const projectId = str(project.id, 'contract.project.id', issues);
  const repoRoot = str(project.repoRoot, 'contract.project.repoRoot', issues);
  if (repoRoot !== undefined && !isAbsoluteRepoPath(repoRoot)) {
    issues.push('contract.project.repoRoot must be an absolute path');
  }
  const baseRef = str(project.baseRef, 'contract.project.baseRef', issues);

  let tasks: TaskSpec[] = [];
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    issues.push('contract.tasks must be a non-empty array');
  } else {
    tasks = raw.tasks
      .map((entry) => validateTask(entry, issues))
      .filter((t): t is TaskSpec => t !== undefined);
  }

  if (issues.length > 0) {
    throw new ContractInvalidError('execution contract rejected', dedupe(issues));
  }

  const contract: ExecutionContract = {
    version: CONTRACT_VERSION,
    project: { id: projectId!, repoRoot: repoRoot!, baseRef: baseRef! },
    tasks,
  };

  if (raw.provenance !== undefined) {
    const prov = asRaw(raw.provenance, 'contract.provenance', issues);
    const documents: { kind: string; reference: string }[] = [];
    if (Array.isArray(prov.documents)) {
      prov.documents.forEach((doc, i) => {
        const d = asRaw(doc, `contract.provenance.documents[${i}]`, issues);
        const kind = str(d.kind, `contract.provenance.documents[${i}].kind`, issues);
        const reference = str(d.reference, `contract.provenance.documents[${i}].reference`, issues);
        for (const key of Object.keys(d)) {
          if (!['kind', 'reference'].includes(key)) {
            issues.push(`contract.provenance.documents[${i}].${key}: unknown field`);
          }
        }
        if (kind && reference) documents.push({ kind, reference });
      });
    }
    contract.provenance = { documents };
  }

  validateGraph(contract);
  return contract;
}

function dedupe(issues: string[]): string[] {
  return [...new Set(issues)];
}

/** Cross-task checks: unique ids, existing deps, cycles, path ownership. */
export function validateGraph(contract: ExecutionContract): void {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const task of contract.tasks) {
    if (!TASK_ID_PATTERN.test(task.id)) continue;
    if (ids.has(task.id)) issues.push(`duplicate task id "${task.id}"`);
    ids.add(task.id);
  }
  for (const task of contract.tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) issues.push(`task ${task.id} depends on unknown task "${dep}"`);
    }
  }
  detectCycles(contract.tasks, issues);
  validateOwnership(contract.tasks, issues);
  if (issues.length > 0) throw new ContractInvalidError('execution contract graph rejected', dedupe(issues));
}

function detectCycles(tasks: TaskSpec[], issues: string[]): void {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    const mark = state.get(id);
    if (mark === 2) return;
    if (mark === 1) {
      const start = stack.indexOf(id);
      issues.push(`dependency cycle: ${[...stack.slice(start), id].join(' -> ')}`);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const task of tasks) visit(task.id);
}

function validateOwnership(tasks: TaskSpec[], issues: string[]): void {
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      if (ownershipConflict(a.allowedPaths, b.allowedPaths)) {
        issues.push(`allowedPaths of ${a.id} and ${b.id} overlap (path ownership must be exclusive)`);
      }
    }
  }
}

/** Kahn topological order (dependencies first). Throws on cycle. */
export function topologicalTasks(contract: ExecutionContract): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of contract.tasks) {
    indegree.set(task.id, task.dependsOn?.length ?? 0);
    for (const dep of task.dependsOn ?? []) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
    }
  }
  const order: string[] = [];
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== contract.tasks.length) {
    throw new ContractInvalidError('dependency cycle detected in contract');
  }
  return order;
}

/** All transitive dependencies of a task (including itself). */
export function closureOf(contract: ExecutionContract, taskId: string): Set<string> {
  const byId = new Map(contract.tasks.map((t) => [t.id, t]));
  const out = new Set<string>();
  const visit = (id: string): void => {
    if (out.has(id)) return;
    out.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
  };
  visit(taskId);
  return out;
}
