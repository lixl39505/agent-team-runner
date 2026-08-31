import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ProjectPolicyInput {
  baseRef: string;
  verificationAllowedCommandPrefixes: string[];
  baselinePathPolicy: JsonValue;
  agentProfileMapping: JsonValue;
  backendPolicy: JsonValue;
}

export interface RegisterProjectInput {
  gitCommonDir: string;
  repoRoot: string;
  displayName: string;
  gitIdentity: JsonValue;
  policy: ProjectPolicyInput;
}

export interface ProjectRecord {
  id: string;
  gitCommonDir: string;
  repoRoot: string;
  displayName: string;
  gitIdentity: JsonValue;
  currentPolicyRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPolicyRevision {
  id: string;
  projectId: string;
  revision: number;
  baseRef: string;
  verificationAllowedCommandPrefixes: string[];
  baselinePathPolicy: JsonValue;
  agentProfileMapping: JsonValue;
  backendPolicy: JsonValue;
  createdAt: string;
}

function now(): string {
  return new Date().toISOString();
}

function serialize(value: JsonValue): string {
  return JSON.stringify(value) as string;
}

function mapProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    gitCommonDir: String(row.git_common_dir),
    repoRoot: String(row.repo_root),
    displayName: String(row.display_name),
    gitIdentity: JSON.parse(String(row.git_identity_json)) as JsonValue,
    currentPolicyRevisionId: String(row.current_policy_revision_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapPolicyRevision(row: Record<string, unknown>): ProjectPolicyRevision {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    revision: Number(row.revision),
    baseRef: String(row.base_ref),
    verificationAllowedCommandPrefixes: JSON.parse(String(row.verification_allowed_command_prefixes_json)) as string[],
    baselinePathPolicy: JSON.parse(String(row.baseline_path_policy_json)) as JsonValue,
    agentProfileMapping: JSON.parse(String(row.agent_profile_mapping_json)) as JsonValue,
    backendPolicy: JSON.parse(String(row.backend_policy_json)) as JsonValue,
    createdAt: String(row.created_at)
  };
}

function policyFingerprint(policy: ProjectPolicyInput): string {
  return serialize({
    baseRef: policy.baseRef,
    verificationAllowedCommandPrefixes: policy.verificationAllowedCommandPrefixes,
    baselinePathPolicy: policy.baselinePathPolicy,
    agentProfileMapping: policy.agentProfileMapping,
    backendPolicy: policy.backendPolicy
  });
}

function policyFromRevision(revision: ProjectPolicyRevision): ProjectPolicyInput {
  return {
    baseRef: revision.baseRef,
    verificationAllowedCommandPrefixes: revision.verificationAllowedCommandPrefixes,
    baselinePathPolicy: revision.baselinePathPolicy,
    agentProfileMapping: revision.agentProfileMapping,
    backendPolicy: revision.backendPolicy
  };
}

export class ProjectRegistry {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        git_common_dir TEXT NOT NULL UNIQUE,
        repo_root TEXT NOT NULL,
        display_name TEXT NOT NULL,
        git_identity_json TEXT NOT NULL,
        current_policy_revision_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_policy_revisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        base_ref TEXT NOT NULL,
        verification_allowed_command_prefixes_json TEXT NOT NULL,
        baseline_path_policy_json TEXT NOT NULL,
        agent_profile_mapping_json TEXT NOT NULL,
        backend_policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, revision),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) STRICT;
    `);
  }

  registerProject(input: RegisterProjectInput): ProjectRecord {
    const existing = this.findProject(input.gitCommonDir);
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (existing) {
        const currentRevision = this.getProjectPolicy(existing.id);
        let currentPolicyRevisionId = existing.currentPolicyRevisionId;
        if (policyFingerprint(input.policy) !== policyFingerprint(policyFromRevision(currentRevision))) {
          const revision = Number((this.db.prepare(
            'SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM project_policy_revisions WHERE project_id = ?'
          ).get(existing.id) as { revision: number }).revision);
          currentPolicyRevisionId = `${existing.id}:r${revision}`;
          this.insertPolicyRevision(currentPolicyRevisionId, existing.id, revision, input.policy, timestamp);
        }
        this.db.prepare(`
          UPDATE projects
          SET repo_root = ?, display_name = ?, git_identity_json = ?, current_policy_revision_id = ?, updated_at = ?
          WHERE id = ?
        `).run(
          input.repoRoot,
          input.displayName,
          serialize(input.gitIdentity),
          currentPolicyRevisionId,
          timestamp,
          existing.id
        );
      } else {
        const projectId = `project-${randomUUID()}`;
        const policyRevisionId = `${projectId}:r1`;
        this.db.prepare(`
          INSERT INTO projects (
            id, git_common_dir, repo_root, display_name, git_identity_json, current_policy_revision_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          projectId,
          input.gitCommonDir,
          input.repoRoot,
          input.displayName,
          serialize(input.gitIdentity),
          policyRevisionId,
          timestamp,
          timestamp
        );
        this.insertPolicyRevision(policyRevisionId, projectId, 1, input.policy, timestamp);
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return this.getProject(input.gitCommonDir);
  }

  getProject(identifier: string): ProjectRecord {
    const project = this.findProject(identifier);
    if (!project) throw new Error(`Project not found: ${identifier}`);
    return project;
  }

  getProjectPolicy(projectIdentifier: string): ProjectPolicyRevision {
    const project = this.getProject(projectIdentifier);
    return mapPolicyRevision(this.db.prepare(`
      SELECT * FROM project_policy_revisions WHERE id = ?
    `).get(project.currentPolicyRevisionId) as Record<string, unknown>);
  }

  getProjectPolicyRevision(projectId: string, revisionId: string): ProjectPolicyRevision {
    const project = this.getProject(projectId);
    const revision = this.db.prepare(`
      SELECT * FROM project_policy_revisions WHERE id = ?
    `).get(revisionId) as Record<string, unknown> | undefined;
    if (!revision) throw new Error(`Project policy revision not found: ${revisionId}`);
    if (String(revision.project_id) !== project.id) {
      throw new Error(`Project policy revision ${revisionId} does not belong to project: ${project.id}`);
    }
    return mapPolicyRevision(revision);
  }

  listProjects(): ProjectRecord[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY display_name, id').all() as Record<string, unknown>[]).map(mapProject);
  }

  close(): void {
    this.db.close();
  }

  private findProject(identifier: string): ProjectRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM projects WHERE id = ? OR git_common_dir = ?
    `).get(identifier, identifier) as Record<string, unknown> | undefined;
    return row ? mapProject(row) : undefined;
  }

  private insertPolicyRevision(
    id: string,
    projectId: string,
    revision: number,
    policy: ProjectPolicyInput,
    createdAt: string
  ): void {
    this.db.prepare(`
      INSERT INTO project_policy_revisions (
        id, project_id, revision, base_ref, verification_allowed_command_prefixes_json,
        baseline_path_policy_json, agent_profile_mapping_json, backend_policy_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      revision,
      policy.baseRef,
      serialize(policy.verificationAllowedCommandPrefixes),
      serialize(policy.baselinePathPolicy),
      serialize(policy.agentProfileMapping),
      serialize(policy.backendPolicy),
      createdAt
    );
  }
}
