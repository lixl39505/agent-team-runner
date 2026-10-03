// Role result documents. A completed result file validated against these
// types is the ONLY completion credential; terminal text and agent states
// never are (ADR 0001).

export type WorkerStatus = 'completed' | 'blocked' | 'blocked_on_contract' | 'failed';

export type ContractBlockCode =
  | 'out_of_scope'
  | 'missing_requirement'
  | 'conflicting_requirement'
  | 'dependency_change'
  | 'missing_access'
  | 'other';

export interface ContractBlock {
  code: ContractBlockCode;
  message: string;
  requestedContractChanges: string[];
  affectedPaths: string[];
}

export interface WorkerResult {
  status: WorkerStatus;
  summary: string;
  testsRun: string[];
  knownRisks: string[];
  /** Self-reported; the runner always recomputes mechanically. */
  changedPaths: string[];
  blockedReason?: string;
  contractBlock?: ContractBlock;
}

export type ReviewerStatus = 'approved' | 'changes_requested';

export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  message: string;
}

export interface ReviewerResult {
  status: ReviewerStatus;
  summary: string;
  findings: ReviewFinding[];
  requiredChanges: string[];
  reviewedFiles: string[];
}

export type IntegratorStatus = 'completed' | 'blocked' | 'failed';

export interface IntegrationResult {
  status: IntegratorStatus;
  summary: string;
  testsRun: string[];
  knownRisks: string[];
  resolvedConflicts: string[];
  blockedReason?: string;
}

export type RoleResult = WorkerResult | ReviewerResult | IntegrationResult;
