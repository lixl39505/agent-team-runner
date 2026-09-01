import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProjectSkill, ResolvedSkill, SkillRequirement, TaskSpec } from './types.js';

export interface SkillRoot {
  source: SkillRequirement['source'];
  path: string;
}

/** Derive the only local roots accepted for external execution contracts. */
export function localSkillRoots(repoRoot: string, userHome = homedir()): readonly SkillRoot[] {
  const candidates: readonly SkillRoot[] = [
    { source: 'project', path: resolve(repoRoot, '.agents', 'skills') },
    { source: 'user', path: resolve(userHome, '.agents', 'skills') }
  ];
  return Object.freeze(candidates.filter((root) => isSafeLocalRoot(root.path, root.source === 'project' ? repoRoot : userHome)));
}

/** List safe project-local Skill metadata without exposing a daemon or MCP surface. */
export function listProjectSkills(repoRoot: string): readonly ProjectSkill[] {
  const root = localSkillRoots(repoRoot).find((entry) => entry.source === 'project');
  if (!root) return Object.freeze([]);
  const skills: ProjectSkill[] = [];
  for (const entry of readdirSync(root.path, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SKILL_NAME.test(entry.name)) continue;
    const [skill] = resolveTaskSkills([
      { name: entry.name, role: 'worker', required: true, source: 'project' }
    ], [root]);
    if (skill) skills.push(Object.freeze({ name: skill.name, source: 'project', path: skill.path, sha256: skill.sha256 }));
  }
  return Object.freeze(skills);
}

interface ResolvedRoot extends SkillRoot {
  realPath: string;
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const SKILL_ROLES: readonly SkillRequirement['role'][] = ['worker', 'reviewer', 'integrator'];
const SKILL_SOURCES: readonly SkillRequirement['source'][] = ['project', 'user'];

/**
 * Resolve the local skill documents selected for a task into content-addressed snapshots.
 * This function only reads local files and never creates, modifies, or downloads anything.
 */
export function resolveTaskSkills(
  requirements: readonly SkillRequirement[] | undefined,
  roots: readonly SkillRoot[]
): readonly ResolvedSkill[] {
  if (requirements === undefined || requirements.length === 0) return Object.freeze([]);
  if (!Array.isArray(requirements)) throw new Error('Skill requirements must be an array');

  const rootsBySource = resolveRoots(roots);
  const uniqueRequirements = new Map<string, SkillRequirement>();
  for (const requirement of requirements) {
    validateRequirement(requirement);
    const key = `${requirement.name}\u0000${requirement.role}\u0000${requirement.source}`;
    const existing = uniqueRequirements.get(key);
    if (existing) {
      if (requirement.required && !existing.required) {
        uniqueRequirements.set(key, { ...existing, required: true });
      }
      continue;
    }
    uniqueRequirements.set(key, { ...requirement });
  }

  const skills: ResolvedSkill[] = [];
  for (const requirement of uniqueRequirements.values()) {
    const root = rootsBySource.get(requirement.source);
    if (!root) {
      if (requirement.required) {
        throw new Error(`Required ${requirement.source} skill is missing: ${requirement.name} (No ${requirement.source} skill root configured)`);
      }
      continue;
    }

    const skillPath = resolve(root.path, requirement.name, 'SKILL.md');

    let realSkillPath: string;
    try {
      lstatSync(skillPath);
      realSkillPath = realpathSync(skillPath);
    } catch (error) {
      if (isMissingPath(error)) {
        if (requirement.required) throw new Error(`Required ${requirement.source} skill is missing: ${requirement.name}`);
        continue;
      }
      throw error;
    }
    if (!isInsideRoot(root.realPath, realSkillPath)) {
      throw new Error(`Skill ${requirement.name} resolves outside the ${requirement.source} root`);
    }

    const content = readFileSync(realSkillPath, 'utf8');
    skills.push(Object.freeze({
      name: requirement.name,
      role: requirement.role,
      source: requirement.source,
      path: skillPath,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      content
    }));
  }
  return Object.freeze(skills);
}

/** Resolve a TaskSpec's selected implementation skills into immutable local snapshots. */
export function snapshotTaskSkills(task: TaskSpec, roots: readonly SkillRoot[]): readonly ResolvedSkill[] {
  return resolveTaskSkills(task.implementationSkills, roots);
}

function resolveRoots(roots: readonly SkillRoot[]): Map<SkillRequirement['source'], ResolvedRoot> {
  if (!Array.isArray(roots)) throw new Error('Skill roots must be an array');
  const result = new Map<SkillRequirement['source'], ResolvedRoot>();
  for (const root of roots) {
    if (!root || typeof root !== 'object' || !SKILL_SOURCES.includes(root.source)) {
      throw new Error('Skill root has an invalid source');
    }
    if (typeof root.path !== 'string' || root.path.length === 0) {
      throw new Error(`Skill root for ${root.source} must have a path`);
    }
    if (result.has(root.source)) throw new Error(`Duplicate ${root.source} skill root`);

    const path = resolve(root.path);
    let realPath: string;
    try {
      if (!lstatSync(path).isDirectory()) throw new Error(`Skill root for ${root.source} is not a directory: ${path}`);
      realPath = realpathSync(path);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Skill root for ')) throw error;
      throw new Error(`Cannot access ${root.source} skill root: ${path}`, { cause: error });
    }
    result.set(root.source, { source: root.source, path, realPath });
  }
  return result;
}

function validateRequirement(requirement: SkillRequirement): void {
  if (!requirement || typeof requirement !== 'object' || typeof requirement.name !== 'string' || !SKILL_NAME.test(requirement.name)) {
    throw new Error(`Invalid skill name: ${String(requirement?.name)}`);
  }
  if (!SKILL_ROLES.includes(requirement.role)) throw new Error(`Invalid skill role: ${String(requirement.role)}`);
  if (typeof requirement.required !== 'boolean') throw new Error(`Skill ${requirement.name} requires boolean required`);
  if (!SKILL_SOURCES.includes(requirement.source)) throw new Error(`Invalid skill source: ${String(requirement.source)}`);
}

function isInsideRoot(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

function isSafeLocalRoot(path: string, container: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return false;
    return isInsideRoot(realpathSync(resolve(container)), realpathSync(path));
  } catch {
    return false;
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
