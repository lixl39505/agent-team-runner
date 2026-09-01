import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskSpec } from './types.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function skillPath(role: 'worker' | 'reviewer' | 'integrator'): string {
  return join(packageRoot, 'skills', `team-${role}`, 'SKILL.md');
}

export function loadSkill(role: 'worker' | 'reviewer' | 'integrator'): string {
  const raw = readFileSync(skillPath(role), 'utf8');
  return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

export function syncSkills(repoRoot: string): string[] {
  const written: string[] = [];
  for (const hostRoot of ['.agents/skills', '.claude/skills']) {
    for (const role of ['worker', 'reviewer', 'integrator'] as const) {
      const target = join(repoRoot, hostRoot, `team-${role}`, 'SKILL.md');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(skillPath(role), 'utf8'), 'utf8');
      written.push(target);
    }
  }
  return written;
}

export function writeTaskMarkdown(path: string, task: TaskSpec, baseSha: string): void {
  const list = (values: string[]) => values.length ? values.map((value) => `- ${value}`).join('\n') : '- 无';
  const body = `# ${task.id} ${task.title}

## 执行元数据

- 任务 ID: ${task.id}
- 基础提交: ${baseSha}
- 依赖任务: ${task.dependsOn.join(', ') || '无'}
- Agent: ${task.agent ?? '继承 worker 角色配置'}

## 目标

${task.description}

必须包含:

${list(task.acceptance)}

## 变更范围

允许修改目录:

${list(task.allowedPaths)}

禁止修改目录:

${list(task.blockedPaths)}

## 验证命令

${list(task.verificationCommands)}

## 完成与交付标准

执行策略:

- Worker 先形成计划，再按策略自动执行。
- Worker 不负责 Git 提交、合并、rebase、push 或部署。
- Runner 负责路径校验、重跑测试、暂存和提交。
- Reviewer 批准前，任务不得标记为完成。

完成条件:

- [ ] 功能闭环可用
- [ ] 权限正确
- [ ] 数据边界正确
- [ ] 无越界功能实现
- [ ] 所有逻辑可测试
- [ ] 指定验证命令全部通过

`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

export function ensureGitignore(repoRoot: string): void {
  const target = join(repoRoot, '.gitignore');
  const markers = ['.agent-team/state.sqlite', '.agent-team/state.sqlite-*', '.agent-team/runs/'];
  let current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const lines = new Set(current.split(/\r?\n/));
  for (const marker of markers) {
    if (!lines.has(marker)) {
      current += `${current && !current.endsWith('\n') ? '\n' : ''}${marker}\n`;
      lines.add(marker);
    }
  }
  writeFileSync(target, current, 'utf8');
}
