import type { ContractBlockReason, ExecutionContract, IntegrationResult, ReviewResult, SkillRequirement, TaskSpec, WorkerResult } from './types.js';

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

export function validateTaskSpec(value: unknown, index: number, validAgentNames?: string[]): TaskSpec {
  assertObject(value, `Task ${index}`);
  const id = String(value.id ?? '');
  if (!/^[A-Z][A-Z0-9_-]{1,31}$/.test(id)) {
    throw new Error(`Invalid task id: ${id}`);
  }
  const title = String(value.title ?? '');
  const description = String(value.description ?? '');
  if (!title || !description) throw new Error(`Task ${id} requires title and description`);
  if (value.adapter !== undefined) {
    throw new Error(`Task ${id} uses the removed "adapter" field; use an agents registry name via "agent" instead`);
  }
  const agent = value.agent;
  if (agent !== undefined) {
    if (typeof agent !== 'string' || agent.length === 0) {
      throw new Error(`Task ${id} has invalid agent: ${String(agent)}`);
    }
    if (validAgentNames && !validAgentNames.includes(agent)) {
      throw new Error(`Task ${id} references unknown agent "${agent}"; choose from: ${validAgentNames.join(', ')}`);
    }
  }
  const allowedPaths = stringArray(value.allowedPaths, `${id}.allowedPaths`);
  const blockedPaths = stringArray(value.blockedPaths ?? [], `${id}.blockedPaths`);
  for (const pattern of [...allowedPaths, ...blockedPaths]) validateRelativeGlob(pattern, id);
  // .git 前缀只约束 allowedPaths（拥有 .git 危险）；blockedPaths 里出现 .git/** 是纯增强限制，允许
  for (const pattern of allowedPaths) {
    const normalized = pattern.replace(/\\/g, '/');
    if (normalized === '.git' || normalized.startsWith('.git/')) {
      throw new Error(`${id} may not own .git paths: ${pattern}`);
    }
  }
  const result: TaskSpec = {
    id,
    title,
    description,
    dependsOn: stringArray(value.dependsOn ?? [], `${id}.dependsOn`),
    allowedPaths,
    blockedPaths,
    acceptance: stringArray(value.acceptance, `${id}.acceptance`),
    verificationCommands: stringArray(value.verificationCommands ?? [], `${id}.verificationCommands`)
  };
  if (value.externalId !== undefined) {
    if (typeof value.externalId !== 'string' || value.externalId.length === 0) {
      throw new Error(`Task ${id} has invalid externalId`);
    }
    result.externalId = value.externalId;
  }
  if (value.implementationGuidance !== undefined) {
    result.implementationGuidance = stringArray(value.implementationGuidance, `${id}.implementationGuidance`);
  }
  if (value.implementationSkills !== undefined) {
    if (!Array.isArray(value.implementationSkills)) throw new Error(`Task ${id}.implementationSkills must be an array`);
    result.implementationSkills = value.implementationSkills.map((skill, skillIndex) => validateSkillRequirement(skill, id, skillIndex));
  }
  if (typeof value.role === 'string') result.role = value.role;
  if (typeof agent === 'string' && agent) result.agent = agent;
  if (typeof value.allowNoChanges === 'boolean') result.allowNoChanges = value.allowNoChanges;
  return result;
}

function validateSkillRequirement(value: unknown, taskId: string, index: number): SkillRequirement {
  assertObject(value, `Task ${taskId}.implementationSkills[${index}]`);
  const name = String(value.name ?? '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) {
    throw new Error(`Task ${taskId} has invalid implementation skill name: ${name}`);
  }
  const role = String(value.role ?? 'worker');
  if (!['worker', 'reviewer', 'integrator'].includes(role)) {
    throw new Error(`Task ${taskId} has invalid implementation skill role: ${role}`);
  }
  if (typeof value.required !== 'boolean') {
    throw new Error(`Task ${taskId} implementation skill ${name} requires boolean required`);
  }
  const source = String(value.source ?? 'project');
  if (!['project', 'user'].includes(source)) {
    throw new Error(`Task ${taskId} has invalid implementation skill source: ${source}`);
  }
  return { name, role: role as SkillRequirement['role'], required: value.required, source: source as SkillRequirement['source'] };
}

/** 验证外层 SDD 提交的执行契约，不解释来源系统。 */
export function validateExecutionContract(value: unknown, validAgentNames?: string[]): ExecutionContract {
  assertObject(value, 'Execution contract');
  if (Number(value.version) !== 1) throw new Error('Execution contract version must be 1');
  assertObject(value.project, 'Execution contract project');
  const projectId = String(value.project.id ?? '');
  const repoRoot = String(value.project.repoRoot ?? '');
  const baseRef = String(value.project.baseRef ?? '');
  if (!projectId || !repoRoot || !baseRef) throw new Error('Execution contract project requires id, repoRoot, and baseRef');
  assertObject(value.target, 'Execution contract target');
  const integrationBranch = value.target.integrationBranch;
  if (integrationBranch !== undefined && (typeof integrationBranch !== 'string' || integrationBranch.length === 0)) {
    throw new Error('Execution contract target.integrationBranch must be a non-empty string');
  }
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new Error('Execution contract must contain at least one task');
  }
  const tasks = value.tasks.map((task, index) => validateTaskSpec(task, index, validAgentNames));
  validateTaskGraph(tasks);
  validateParallelPathOwnership(tasks);
  const provenance = validateProvenance(value.provenance);
  return {
    version: 1,
    project: { id: projectId, repoRoot, baseRef },
    target: integrationBranch === undefined ? {} : { integrationBranch },
    ...(provenance ? { provenance } : {}),
    tasks
  };
}

function validateProvenance(value: unknown): ExecutionContract['provenance'] | undefined {
  if (value === undefined) return undefined;
  assertObject(value, 'Execution contract provenance');
  if (!Array.isArray(value.documents)) throw new Error('Execution contract provenance.documents must be an array');
  return {
    documents: value.documents.map((document, index) => {
      assertObject(document, `Execution contract provenance.documents[${index}]`);
      const kind = String(document.kind ?? '');
      const locator = String(document.locator ?? '');
      const revision = String(document.revision ?? '');
      if (!kind || !locator || !revision) throw new Error(`Execution contract provenance.documents[${index}] requires kind, locator, and revision`);
      return { kind, locator, revision };
    })
  };
}

export function validateTaskGraph(tasks: TaskSpec[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (task.allowedPaths.length === 0) throw new Error(`${task.id} has no allowed paths`);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`${task.id} depends on unknown task ${dep}`);
      if (dep === task.id) throw new Error(`${task.id} cannot depend on itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Task graph contains a cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export function topologicalTasks(tasks: TaskSpec[]): TaskSpec[] {
  const result: TaskSpec[] = [];
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (task: TaskSpec): void => {
    if (visited.has(task.id)) return;
    for (const dep of task.dependsOn) visit(byId.get(dep)!);
    visited.add(task.id);
    result.push(task);
  };
  for (const task of tasks) visit(task);
  return result;
}

function validateRelativeGlob(pattern: string, taskId: string): void {
  if (!pattern || pattern.startsWith('/') || pattern.startsWith('\\') || /^[A-Za-z]:/.test(pattern)) {
    throw new Error(`${taskId} contains an absolute or empty path pattern: ${pattern}`);
  }
  const normalized = pattern.replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) throw new Error(`${taskId} path pattern escapes the repository: ${pattern}`);
}

function validateParallelPathOwnership(tasks: TaskSpec[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    for (const dep of byId.get(from)!.dependsOn) {
      if (dep === target || reaches(dep, target, seen)) return true;
    }
    return false;
  };
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const left = tasks[leftIndex]!;
      const right = tasks[rightIndex]!;
      if (reaches(left.id, right.id) || reaches(right.id, left.id)) continue;
      for (const leftPattern of left.allowedPaths) {
        for (const rightPattern of right.allowedPaths) {
          if (patternsMayOverlap(leftPattern, rightPattern)) {
            throw new Error(`Parallel tasks ${left.id} and ${right.id} may overlap writable paths: ${leftPattern} vs ${rightPattern}. Add a dependency or narrow ownership.`);
          }
        }
      }
    }
  }
}

function patternsMayOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const prefix = (pattern: string): string => {
    const normalized = pattern.replace(/\\/g, '/');
    const wildcard = normalized.search(/[?*[]/);
    const raw = wildcard < 0 ? normalized : normalized.slice(0, wildcard);
    return raw.endsWith('/') ? raw : raw.slice(0, raw.lastIndexOf('/') + 1);
  };
  const leftPrefix = prefix(left);
  const rightPrefix = prefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

export function validateWorkerResult(value: unknown): WorkerResult {
  assertObject(value, 'Worker result');
  const status = String(value.status);
  if (!['completed', 'blocked', 'blocked_on_contract', 'failed'].includes(status)) throw new Error('Invalid worker status');
  const allowedKeys = new Set(['status', 'summary', 'testsRun', 'knownRisks', 'architectureImpact', 'progressImpact', 'blockedReason', 'contractBlock']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error('Worker result contains unknown fields');
  const fields = {
    summary: String(value.summary ?? ''),
    testsRun: stringArray(value.testsRun ?? [], 'testsRun'),
    knownRisks: stringArray(value.knownRisks ?? [], 'knownRisks'),
    architectureImpact: String(value.architectureImpact ?? ''),
    progressImpact: String(value.progressImpact ?? ''),
    ...(typeof value.blockedReason === 'string' ? { blockedReason: value.blockedReason } : {})
  };
  if (status === 'blocked_on_contract') {
    if (value.contractBlock === undefined) throw new Error('blocked_on_contract worker result requires contractBlock');
    return { ...fields, status: 'blocked_on_contract', contractBlock: validateContractBlockReason(value.contractBlock) };
  }
  if (value.contractBlock !== undefined) {
    throw new Error('contractBlock is only valid when worker status is blocked_on_contract');
  }
  return { ...fields, status: status as 'completed' | 'blocked' | 'failed' };
}

function validateContractBlockReason(value: unknown): ContractBlockReason {
  assertObject(value, 'contractBlock');
  const allowedKeys = new Set(['code', 'message', 'requestedContractChanges', 'affectedPaths']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error('contractBlock contains unknown fields');
  const code = value.code;
  if (typeof code !== 'string' || !['out_of_scope', 'missing_requirement', 'conflicting_requirement', 'dependency_change', 'missing_access', 'other'].includes(code)) {
    throw new Error('Invalid contractBlock code');
  }
  if (typeof value.message !== 'string') throw new Error('contractBlock.message must be a string');
  if (!Object.hasOwn(value, 'requestedContractChanges')) throw new Error('contractBlock.requestedContractChanges is required');
  const requestedContractChanges = stringArray(value.requestedContractChanges, 'contractBlock.requestedContractChanges');
  const affectedPaths = value.affectedPaths === undefined ? undefined : stringArray(value.affectedPaths, 'contractBlock.affectedPaths');
  return { code: code as ContractBlockReason['code'], message: value.message, requestedContractChanges, ...(affectedPaths === undefined ? {} : { affectedPaths }) };
}

export function validateReviewResult(value: unknown): ReviewResult {
  assertObject(value, 'Review result');
  const decision = String(value.decision);
  if (!['approved', 'changes_requested'].includes(decision)) throw new Error('Invalid review decision');
  const findingsRaw = Array.isArray(value.findings) ? value.findings : [];
  const findings = findingsRaw.map((finding, index) => {
    assertObject(finding, `finding ${index}`);
    const severity = String(finding.severity);
    if (!['critical', 'high', 'medium', 'low'].includes(severity)) throw new Error('Invalid finding severity');
    return {
      severity: severity as ReviewResult['findings'][number]['severity'],
      file: String(finding.file ?? ''),
      ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
      message: String(finding.message ?? '')
    };
  });
  return {
    decision: decision as ReviewResult['decision'],
    summary: String(value.summary ?? ''),
    findings,
    requiredChanges: stringArray(value.requiredChanges ?? [], 'requiredChanges')
  };
}

export function validateIntegrationResult(value: unknown): IntegrationResult {
  assertObject(value, 'Integration result');
  const status = String(value.status);
  if (!['completed', 'blocked', 'failed'].includes(status)) throw new Error('Invalid integration status');
  return {
    status: status as IntegrationResult['status'],
    summary: String(value.summary ?? ''),
    testsRun: stringArray(value.testsRun ?? [], 'testsRun'),
    documentationUpdated: stringArray(value.documentationUpdated ?? [], 'documentationUpdated'),
    knownRisks: stringArray(value.knownRisks ?? [], 'knownRisks'),
    ...(typeof value.blockedReason === 'string' ? { blockedReason: value.blockedReason } : {})
  };
}

export const WORKER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'testsRun', 'knownRisks', 'architectureImpact', 'progressImpact'],
  properties: {
    status: { enum: ['completed', 'blocked', 'blocked_on_contract', 'failed'] }, summary: { type: 'string' },
    testsRun: { type: 'array', items: { type: 'string' } }, knownRisks: { type: 'array', items: { type: 'string' } },
    architectureImpact: { type: 'string' }, progressImpact: { type: 'string' }, blockedReason: { type: 'string' },
    contractBlock: {
      type: 'object', additionalProperties: false,
      required: ['code', 'message', 'requestedContractChanges'],
      properties: {
        code: { enum: ['out_of_scope', 'missing_requirement', 'conflicting_requirement', 'dependency_change', 'missing_access', 'other'] },
        message: { type: 'string' },
        requestedContractChanges: { type: 'array', items: { type: 'string' } },
        affectedPaths: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  allOf: [{
    if: { properties: { status: { const: 'blocked_on_contract' } }, required: ['status'] },
    then: { required: ['contractBlock'] }
  }]
} as const;

export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['decision', 'summary', 'findings', 'requiredChanges'],
  properties: {
    decision: { enum: ['approved', 'changes_requested'] }, summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'file', 'message'], properties: {
      severity: { enum: ['critical', 'high', 'medium', 'low'] }, file: { type: 'string' }, line: { type: 'number' }, message: { type: 'string' }
    }}}, requiredChanges: { type: 'array', items: { type: 'string' } }
  }
} as const;

export const INTEGRATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'testsRun', 'documentationUpdated', 'knownRisks'],
  properties: {
    status: { enum: ['completed', 'blocked', 'failed'] }, summary: { type: 'string' },
    testsRun: { type: 'array', items: { type: 'string' } }, documentationUpdated: { type: 'array', items: { type: 'string' } },
    knownRisks: { type: 'array', items: { type: 'string' } }, blockedReason: { type: 'string' }
  }
} as const;
