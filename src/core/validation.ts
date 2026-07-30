import type { AdapterName, IntegrationResult, LeadResult, ReviewResult, TaskSpec, WorkerResult } from './types.js';

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

export function validateLeadResult(value: unknown): LeadResult {
  assertObject(value, 'Lead result');
  if (value.version !== 1) throw new Error('Lead result version must be 1');
  if (typeof value.title !== 'string' || typeof value.summary !== 'string') {
    throw new Error('Lead result title and summary are required');
  }
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new Error('Lead result must contain at least one task');
  }
  const tasks = value.tasks.map((task, index) => validateTaskSpec(task, index));
  validateTaskGraph(tasks);
  validateParallelPathOwnership(tasks);
  return { version: 1, title: value.title, summary: value.summary, tasks };
}

function validateTaskSpec(value: unknown, index: number): TaskSpec {
  assertObject(value, `Task ${index}`);
  const id = String(value.id ?? '');
  if (!/^[A-Z][A-Z0-9_-]{1,31}$/.test(id)) {
    throw new Error(`Invalid task id: ${id}`);
  }
  const title = String(value.title ?? '');
  const description = String(value.description ?? '');
  if (!title || !description) throw new Error(`Task ${id} requires title and description`);
  const adapter = value.adapter;
  if (adapter !== undefined && !['claude', 'codex', 'opencode'].includes(String(adapter))) {
    throw new Error(`Task ${id} has unsupported adapter: ${String(adapter)}`);
  }
  const allowedPaths = stringArray(value.allowedPaths, `${id}.allowedPaths`);
  const blockedPaths = stringArray(value.blockedPaths ?? [], `${id}.blockedPaths`);
  for (const pattern of [...allowedPaths, ...blockedPaths]) validateRelativeGlob(pattern, id);
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
  if (typeof value.role === 'string') result.role = value.role;
  if (adapter) result.adapter = adapter as AdapterName;
  if (typeof value.allowNoChanges === 'boolean') result.allowNoChanges = value.allowNoChanges;
  return result;
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
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
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
  if (normalized === '.git' || normalized.startsWith('.git/')) throw new Error(`${taskId} may not own .git paths`);
}

function validateParallelPathOwnership(tasks: TaskSpec[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    for (const dep of byId.get(from)?.dependsOn ?? []) {
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
  if (!['completed', 'blocked', 'failed'].includes(status)) throw new Error('Invalid worker status');
  return {
    status: status as WorkerResult['status'],
    summary: String(value.summary ?? ''),
    testsRun: stringArray(value.testsRun ?? [], 'testsRun'),
    knownRisks: stringArray(value.knownRisks ?? [], 'knownRisks'),
    architectureImpact: String(value.architectureImpact ?? ''),
    progressImpact: String(value.progressImpact ?? ''),
    ...(typeof value.blockedReason === 'string' ? { blockedReason: value.blockedReason } : {})
  };
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

export const LEAD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['version', 'title', 'summary', 'tasks'],
  properties: {
    version: { const: 1 }, title: { type: 'string' }, summary: { type: 'string' },
    tasks: { type: 'array', minItems: 1, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'title', 'description', 'dependsOn', 'allowedPaths', 'blockedPaths', 'acceptance', 'verificationCommands'],
      properties: {
        id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, role: { type: 'string' },
        adapter: { enum: ['claude', 'codex', 'opencode'] }, dependsOn: { type: 'array', items: { type: 'string' } },
        allowedPaths: { type: 'array', minItems: 1, items: { type: 'string' } }, blockedPaths: { type: 'array', items: { type: 'string' } },
        acceptance: { type: 'array', minItems: 1, items: { type: 'string' } }, verificationCommands: { type: 'array', items: { type: 'string' } },
        allowNoChanges: { type: 'boolean' }
      }
    }}
  }
} as const;

export const WORKER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'testsRun', 'knownRisks', 'architectureImpact', 'progressImpact'],
  properties: {
    status: { enum: ['completed', 'blocked', 'failed'] }, summary: { type: 'string' },
    testsRun: { type: 'array', items: { type: 'string' } }, knownRisks: { type: 'array', items: { type: 'string' } },
    architectureImpact: { type: 'string' }, progressImpact: { type: 'string' }, blockedReason: { type: 'string' }
  }
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
