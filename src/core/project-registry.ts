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
  /** Stable caller-supplied id (e.g. the execution contract's project.id). */
  id?: string;
  createdBy?: string;
  note?: string;
}

export interface ProjectRecord {
  id: string;
  gitCommonDir: string;
  repoRoot: string;
  displayName: string;
  gitIdentity: JsonValue;
  currentPolicyRevisionId: string;
  archivedAt: string | null;
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
  createdBy: string;
  note: string;
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
    archivedAt: row.archived_at === null ? null : String(row.archived_at),
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
    createdBy: String(row.created_by),
    note: String(row.note),
    createdAt: String(row.created_at)
  };
}

function gitIdentityFingerprint(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(gitIdentityFingerprint).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${gitIdentityFingerprint(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasGitIdentity(value: JsonValue): boolean {
  if (value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== 'object' || Object.keys(value).length > 0;
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
        archived_at TEXT,
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
        created_by TEXT NOT NULL DEFAULT 'system',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE (project_id, revision),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) STRICT;
    `);
    this.ensureColumn('projects', 'archived_at', 'TEXT');
    this.ensureColumn('project_policy_revisions', 'created_by', "TEXT NOT NULL DEFAULT 'system'");
    this.ensureColumn('project_policy_revisions', 'note', "TEXT NOT NULL DEFAULT ''");
  }

  registerProject(input: RegisterProjectInput): ProjectRecord {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.findProject(input.gitCommonDir) ?? this.findUniqueProjectByGitIdentity(input.gitIdentity);
      if (existing) {
        const currentRevision = this.getProjectPolicy(existing.id);
        let currentPolicyRevisionId = existing.currentPolicyRevisionId;
        if (policyFingerprint(input.policy) !== policyFingerprint(policyFromRevision(currentRevision))) {
          const revision = Number((this.db.prepare(
            'SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM project_policy_revisions WHERE project_id = ?'
          ).get(existing.id) as { revision: number }).revision);
          currentPolicyRevisionId = `${existing.id}:r${revision}`;
          this.insertPolicyRevision(currentPolicyRevisionId, existing.id, revision, input.policy, timestamp, input.createdBy, input.note);
        }
        this.db.prepare(`
          UPDATE projects
          SET git_common_dir = ?, repo_root = ?, display_name = ?, git_identity_json = ?, current_policy_revision_id = ?, updated_at = ?
          WHERE id = ?
        `).run(
          input.gitCommonDir,
          input.repoRoot,
          input.displayName,
          serialize(input.gitIdentity),
          currentPolicyRevisionId,
          timestamp,
          existing.id
        );
      } else {
        const projectId = input.id ?? `project-${randomUUID()}`;
        const policyRevisionId = `${projectId}:r1`;
        this.db.prepare(`
          INSERT INTO projects (
            id, git_common_dir, repo_root, display_name, git_identity_json, current_policy_revision_id, archived_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          projectId,
          input.gitCommonDir,
          input.repoRoot,
          input.displayName,
          serialize(input.gitIdentity),
          policyRevisionId,
          null,
          timestamp,
          timestamp
        );
        this.insertPolicyRevision(policyRevisionId, projectId, 1, input.policy, timestamp, input.createdBy, input.note);
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

  listProjects({ includeArchived = false }: { includeArchived?: boolean } = {}): ProjectRecord[] {
    const sql = includeArchived
      ? 'SELECT * FROM projects ORDER BY display_name, id'
      : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY display_name, id';
    return (this.db.prepare(sql).all() as Record<string, unknown>[]).map(mapProject);
  }

  archiveProject(identifier: string): ProjectRecord {
    const project = this.getProject(identifier);
    if (project.archivedAt !== null) return project;
    const archivedAt = now();
    this.db.prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?').run(archivedAt, archivedAt, project.id);
    return this.getProject(project.id);
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

  private findUniqueProjectByGitIdentity(gitIdentity: JsonValue): ProjectRecord | undefined {
    if (!hasGitIdentity(gitIdentity)) return undefined;
    const fingerprint = gitIdentityFingerprint(gitIdentity);
    const matches = (this.db.prepare('SELECT * FROM projects').all() as Record<string, unknown>[])
      .filter((row) => gitIdentityFingerprint(JSON.parse(String(row.git_identity_json)) as JsonValue) === fingerprint);
    return matches.length === 1 ? mapProject(matches[0]!) : undefined;
  }

  private ensureColumn(table: 'projects' | 'project_policy_revisions', column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private insertPolicyRevision(
    id: string,
    projectId: string,
    revision: number,
    policy: ProjectPolicyInput,
    createdAt: string,
    createdBy = 'system',
    note = ''
  ): void {
    this.db.prepare(`
      INSERT INTO project_policy_revisions (
        id, project_id, revision, base_ref, verification_allowed_command_prefixes_json,
        baseline_path_policy_json, agent_profile_mapping_json, backend_policy_json, created_by, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      revision,
      policy.baseRef,
      serialize(policy.verificationAllowedCommandPrefixes),
      serialize(policy.baselinePathPolicy),
      serialize(policy.agentProfileMapping),
      serialize(policy.backendPolicy),
      createdBy,
      note,
      createdAt
    );
  }
}

function requiredStringField(params: Record<string, unknown>, field: string, label: string): string {
  const value = params[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredStringArrayField(params: Record<string, unknown>, field: string, label: string): string[] {
  const value = params[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function requiredJsonValueField(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new Error(`${label} must be a JSON value`);
  }
  if (Array.isArray(value)) return value.map((entry, index) => requiredJsonValueField(entry, `${label}[${index}]`));
  if (value && typeof value === 'object') {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) result[key] = requiredJsonValueField(entry, `${label}.${key}`);
    return result;
  }
  throw new Error(`${label} must be a JSON value`);
}

/** Parses the strict project policy payload shape used by external submission surfaces. */
export function parseProjectPolicyInput(params: Record<string, unknown>): ProjectPolicyInput {
  const policyValue = params.policy;
  if (!policyValue || typeof policyValue !== 'object' || Array.isArray(policyValue)) {
    throw new Error('project.register params.policy must be an object');
  }
  const policy = policyValue as Record<string, unknown>;
  for (const field of Object.keys(policy)) {
    if (!['baseRef', 'verificationAllowedCommandPrefixes', 'baselinePathPolicy', 'agentProfileMapping', 'backendPolicy'].includes(field)) {
      throw new Error(`project.register params.policy contains unknown field: ${field}`);
    }
  }
  return {
    baseRef: requiredStringField(policy, 'baseRef', 'project.register params.policy.baseRef'),
    verificationAllowedCommandPrefixes: requiredStringArrayField(policy, 'verificationAllowedCommandPrefixes', 'project.register params.policy.verificationAllowedCommandPrefixes'),
    baselinePathPolicy: requiredJsonValueField(policy.baselinePathPolicy, 'project.register params.policy.baselinePathPolicy'),
    agentProfileMapping: requiredJsonValueField(policy.agentProfileMapping, 'project.register params.policy.agentProfileMapping'),
    backendPolicy: requiredJsonValueField(policy.backendPolicy, 'project.register params.policy.backendPolicy')
  };
}
