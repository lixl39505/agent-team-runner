// Hand-written result validators: exact key sets, enum statuses and
// conditional requirements. Unknown fields are rejected so a sloppy or
// hostile agent cannot smuggle extra state past the gate.

import type {
  ContractBlock,
  IntegrationResult,
  ReviewFinding,
  ReviewerResult,
  WorkerResult,
} from './types.ts';

type Raw = Record<string, unknown>;

function isRaw(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(raw: Raw, allowed: readonly string[], what: string, issues: string[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) issues.push(`${what}.${key}: unknown field`);
  }
}

function strArray(value: unknown, what: string, issues: string[]): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    issues.push(`${what}: must be an array of strings`);
    return null;
  }
  return value as string[];
}

function requireStr(raw: Raw, key: string, what: string, issues: string[]): string | null {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${what}.${key}: required non-empty string`);
    return null;
  }
  return value;
}

function validateContractBlock(value: unknown, what: string, issues: string[]): ContractBlock | null {
  if (!isRaw(value)) {
    issues.push(`${what}.contractBlock: must be an object`);
    return null;
  }
  rejectUnknown(value, ['code', 'message', 'requestedContractChanges', 'affectedPaths'], what, issues);
  const codes = ['out_of_scope', 'missing_requirement', 'conflicting_requirement', 'dependency_change', 'missing_access', 'other'];
  if (typeof value.code !== 'string' || !codes.includes(value.code)) {
    issues.push(`${what}.contractBlock.code: must be one of ${codes.join('|')}`);
  }
  const message = requireStr(value, 'message', what, issues);
  const requested = strArray(value.requestedContractChanges, `${what}.contractBlock.requestedContractChanges`, issues) ?? [];
  const affected = strArray(value.affectedPaths, `${what}.contractBlock.affectedPaths`, issues) ?? [];
  if (issues.length > 0 || message === null) return null;
  return {
    code: value.code as ContractBlock['code'],
    message,
    requestedContractChanges: requested,
    affectedPaths: affected,
  };
}

export function validateWorkerResult(value: unknown): WorkerResult {
  const issues: string[] = [];
  if (!isRaw(value)) throw new Error('worker result must be a JSON object');
  const raw = value;
  rejectUnknown(raw, ['status', 'summary', 'testsRun', 'knownRisks', 'changedPaths', 'blockedReason', 'contractBlock'], 'worker', issues);

  const statuses = ['completed', 'blocked', 'blocked_on_contract', 'failed'];
  if (typeof raw.status !== 'string' || !statuses.includes(raw.status)) {
    issues.push('worker.status: must be one of ' + statuses.join('|'));
  }
  const summary = requireStr(raw, 'summary', 'worker', issues);
  const testsRun = strArray(raw.testsRun, 'worker.testsRun', issues) ?? [];
  const knownRisks = strArray(raw.knownRisks, 'worker.knownRisks', issues) ?? [];
  const changedPaths = strArray(raw.changedPaths, 'worker.changedPaths', issues) ?? [];

  let blockedReason: string | undefined;
  let contractBlock: ContractBlock | undefined;
  if (raw.blockedReason !== undefined) {
    if (typeof raw.blockedReason !== 'string' || raw.blockedReason.trim() === '') {
      issues.push('worker.blockedReason: must be a non-empty string when present');
    } else {
      blockedReason = raw.blockedReason;
    }
  }
  if (raw.contractBlock !== undefined) {
    contractBlock = validateContractBlock(raw.contractBlock, 'worker', issues) ?? undefined;
  }

  if (raw.status === 'blocked_on_contract') {
    if (!contractBlock) issues.push('worker.contractBlock: required when status is blocked_on_contract');
    if (blockedReason) issues.push('worker.blockedReason: must be omitted when status is blocked_on_contract');
  } else if (raw.status === 'blocked' || raw.status === 'failed') {
    if (!blockedReason) issues.push(`worker.blockedReason: required when status is ${raw.status}`);
  } else {
    if (blockedReason) issues.push('worker.blockedReason: only allowed for blocked/blocked_on_contract/failed');
    if (contractBlock) issues.push('worker.contractBlock: only allowed for blocked_on_contract');
  }

  if (issues.length > 0) throw new Error(`worker result rejected:\n  - ${issues.join('\n  - ')}`);
  return {
    status: raw.status as WorkerResult['status'],
    summary: summary!,
    testsRun,
    knownRisks,
    changedPaths,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
    ...(contractBlock !== undefined ? { contractBlock } : {}),
  };
}

function validateFinding(value: unknown, what: string, issues: string[]): ReviewFinding | null {
  if (!isRaw(value)) {
    issues.push(`${what}: must be an object`);
    return null;
  }
  rejectUnknown(value, ['severity', 'file', 'line', 'message'], what, issues);
  const severities = ['critical', 'high', 'medium', 'low'];
  if (typeof value.severity !== 'string' || !severities.includes(value.severity)) {
    issues.push(`${what}.severity: must be one of ${severities.join('|')}`);
  }
  const file = requireStr(value, 'file', what, issues);
  const message = requireStr(value, 'message', what, issues);
  if (value.line !== undefined && (typeof value.line !== 'number' || !Number.isInteger(value.line) || value.line < 1)) {
    issues.push(`${what}.line: must be a positive integer`);
  }
  if (file === null || message === null) return null;
  return {
    severity: value.severity as ReviewFinding['severity'],
    file,
    ...(value.line !== undefined ? { line: value.line as number } : {}),
    message,
  };
}

export function validateReviewerResult(value: unknown): ReviewerResult {
  const issues: string[] = [];
  if (!isRaw(value)) throw new Error('reviewer result must be a JSON object');
  const raw = value;
  rejectUnknown(raw, ['status', 'summary', 'findings', 'requiredChanges', 'reviewedFiles'], 'reviewer', issues);

  if (typeof raw.status !== 'string' || !['approved', 'changes_requested'].includes(raw.status)) {
    issues.push('reviewer.status: must be approved|changes_requested');
  }
  const summary = requireStr(raw, 'summary', 'reviewer', issues);
  let findings: ReviewFinding[] = [];
  if (raw.findings !== undefined) {
    if (!Array.isArray(raw.findings)) {
      issues.push('reviewer.findings: must be an array');
    } else {
      findings = raw.findings
        .map((f, i) => validateFinding(f, `reviewer.findings[${i}]`, issues))
        .filter((f): f is ReviewFinding => f !== null);
    }
  }
  const requiredChanges = strArray(raw.requiredChanges, 'reviewer.requiredChanges', issues) ?? [];
  const reviewedFiles = strArray(raw.reviewedFiles, 'reviewer.reviewedFiles', issues) ?? [];

  if (raw.status === 'changes_requested' && requiredChanges.length === 0) {
    issues.push('reviewer.requiredChanges: must be non-empty when status is changes_requested');
  }
  if (raw.status === 'approved' && requiredChanges.length > 0) {
    issues.push('reviewer.requiredChanges: must be empty when status is approved');
  }

  if (issues.length > 0) throw new Error(`reviewer result rejected:\n  - ${issues.join('\n  - ')}`);
  return {
    status: raw.status as ReviewerResult['status'],
    summary: summary!,
    findings,
    requiredChanges,
    reviewedFiles,
  };
}

export function validateIntegratorResult(value: unknown): IntegrationResult {
  const issues: string[] = [];
  if (!isRaw(value)) throw new Error('integrator result must be a JSON object');
  const raw = value;
  rejectUnknown(raw, ['status', 'summary', 'testsRun', 'knownRisks', 'resolvedConflicts', 'blockedReason'], 'integrator', issues);

  if (typeof raw.status !== 'string' || !['completed', 'blocked', 'failed'].includes(raw.status)) {
    issues.push('integrator.status: must be completed|blocked|failed');
  }
  const summary = requireStr(raw, 'summary', 'integrator', issues);
  const testsRun = strArray(raw.testsRun, 'integrator.testsRun', issues) ?? [];
  const knownRisks = strArray(raw.knownRisks, 'integrator.knownRisks', issues) ?? [];
  const resolvedConflicts = strArray(raw.resolvedConflicts, 'integrator.resolvedConflicts', issues) ?? [];

  let blockedReason: string | undefined;
  if (raw.blockedReason !== undefined) {
    if (typeof raw.blockedReason !== 'string' || raw.blockedReason.trim() === '') {
      issues.push('integrator.blockedReason: must be a non-empty string when present');
    } else {
      blockedReason = raw.blockedReason;
    }
  }
  if ((raw.status === 'blocked' || raw.status === 'failed') && !blockedReason) {
    issues.push(`integrator.blockedReason: required when status is ${raw.status}`);
  }

  if (issues.length > 0) throw new Error(`integrator result rejected:\n  - ${issues.join('\n  - ')}`);
  return {
    status: raw.status as IntegrationResult['status'],
    summary: summary!,
    testsRun,
    knownRisks,
    resolvedConflicts,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
  };
}

export type RoleName = 'worker' | 'reviewer' | 'integrator';

export function validateRoleResult(role: RoleName, value: unknown): WorkerResult | ReviewerResult | IntegrationResult {
  switch (role) {
    case 'worker':
      return validateWorkerResult(value);
    case 'reviewer':
      return validateReviewerResult(value);
    case 'integrator':
      return validateIntegratorResult(value);
  }
}
