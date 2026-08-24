import test from 'node:test';
import assert from 'node:assert/strict';
import { compileClaude } from '../dist/agent/claude/policy.js';
import { compileCodex } from '../dist/agent/codex/policy.js';
import { compileOpenCode } from '../dist/agent/opencode/policy.js';
import { readOnlyPolicy, workerPolicy } from '../dist/core/policy.js';

const config = {
  verification: { allowedCommandPrefixes: ['pnpm test'], globalCommands: [] },
  integration: { allowedPaths: ['specs/**'], runAgentAfterCherryPick: false }
};
const task = {
  id: 'T001', title: 't', description: 'd', dependsOn: [],
  allowedPaths: ['src/**'], blockedPaths: ['src/secret.ts'], acceptance: [], verificationCommands: []
};

test('claude compile: gated tools never shadow canUseTool', () => {
  const compiled = compileClaude(workerPolicy(task, config));
  assert.equal(compiled.permissionMode, 'default');
  for (const gated of ['Bash', 'Edit', 'Write', 'NotebookEdit']) {
    assert.equal(compiled.allowedTools.includes(gated), false, `${gated} must go through canUseTool`);
  }
  assert.deepEqual(compiled.allowedTools.sort(), ['Glob', 'Grep', 'Read']);
  // 无网络 → WebFetch/WebSearch 硬禁；交互工具硬禁
  assert.ok(compiled.disallowedTools.includes('WebFetch'));
  assert.ok(compiled.disallowedTools.includes('WebSearch'));
  assert.ok(compiled.disallowedTools.includes('AskUserQuestion'));
  // decide 语义
  assert.equal(compiled.decide('Bash', { command: 'pnpm test' }, '/repo').behavior, 'allow');
  assert.equal(compiled.decide('Bash', { command: 'curl evil' }, '/repo').behavior, 'deny');
  assert.equal(compiled.decide('Write', { file_path: 'src/a.ts' }, '/repo').behavior, 'allow');
  const denied = compiled.decide('Edit', { file_path: 'src/secret.ts' }, '/repo');
  assert.equal(denied.behavior, 'deny');
  assert.match(denied.message, /blocked/);
});

test('claude compile: read-only roles deny all writes', () => {
  const compiled = compileClaude(readOnlyPolicy());
  assert.equal(compiled.decide('Write', { file_path: 'any.ts' }, '/repo').behavior, 'deny');
  assert.equal(compiled.decide('Bash', { command: 'pnpm test' }, '/repo').behavior, 'deny');
  assert.equal(compiled.decide('Bash', { command: 'git status' }, '/repo').behavior, 'allow');
});

test('codex compile: sandbox matrix and approval decisions', () => {
  const readOnly = compileCodex(readOnlyPolicy(), '/repo');
  assert.deepEqual(readOnly.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(readOnly.approvalPolicy, 'untrusted');
  assert.equal(readOnly.decideCommand('git status'), 'acceptForSession');
  assert.equal(readOnly.decideCommand('pnpm test'), 'decline'); // 只读角色只有 git 读命令
  assert.equal(readOnly.decideCommand('node evil.js'), 'decline');
  assert.equal(readOnly.decideFileChange(), 'decline');

  const worker = compileCodex(workerPolicy(task, config), '/repo');
  assert.equal(worker.sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(worker.sandboxPolicy.writableRoots, ['/repo']);
  assert.equal(worker.sandboxPolicy.networkAccess, false);
  assert.equal(worker.decideCommand('pnpm test'), 'acceptForSession'); // worker 有验证命令前缀
  assert.equal(worker.decideCommand('node evil.js'), 'decline');
  assert.equal(worker.decideFileChange(), 'accept');
});

test('opencode compile: runtime permission decisions', () => {
  const compiled = compileOpenCode(workerPolicy(task, config));
  assert.equal(compiled.decide({ type: 'bash', pattern: 'pnpm test' }, '/repo'), 'once');
  assert.equal(compiled.decide({ type: 'bash', pattern: 'node evil.js' }, '/repo'), 'reject');
  assert.equal(compiled.decide({ type: 'edit', pattern: 'src/a.ts' }, '/repo'), 'once');
  assert.equal(compiled.decide({ type: 'edit', pattern: 'src/secret.ts' }, '/repo'), 'reject');
  assert.equal(compiled.decide({ type: 'edit', pattern: 'other/a.ts' }, '/repo'), 'reject');
  assert.equal(compiled.decide({ type: 'webfetch', pattern: 'https://x' }, '/repo'), 'reject');
  assert.equal(compiled.decide({ type: 'unknown' }, '/repo'), 'reject');
});
