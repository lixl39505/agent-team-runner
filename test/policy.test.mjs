import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOnlyPolicy, workerPolicy, integratorPolicy, decideBash, decideWrite, decideTool } from '../dist/core/policy.js';

const config = {
  verification: { allowedCommandPrefixes: ['pnpm test', 'npm run'], globalCommands: [] },
  integration: { allowedPaths: ['specs/**'], runAgentAfterCherryPick: true }
};

const task = {
  id: 'T001', title: 't', description: 'd', dependsOn: [],
  allowedPaths: ['src/api/**'], blockedPaths: ['src/api/secrets.ts'],
  acceptance: [], verificationCommands: []
};

test('read-only roles cannot write and only run read-only git commands', () => {
  const policy = readOnlyPolicy();
  assert.equal(decideWrite(policy, 'src/api/index.ts').allowed, false);
  assert.equal(decideBash(policy, 'git status --porcelain').allowed, true);
  assert.equal(decideBash(policy, 'git diff HEAD').allowed, true);
  assert.equal(decideBash(policy, 'pnpm test').allowed, false);
  assert.equal(decideBash(policy, 'git push origin main').allowed, false);
});

test('worker policy allows allowed paths, denies blocked and out-of-scope paths', () => {
  const policy = workerPolicy(task, config);
  assert.equal(decideWrite(policy, 'src/api/router.ts').allowed, true);
  // blocked 优先于 allowed
  const denied = decideWrite(policy, 'src/api/secrets.ts');
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /blocked/);
  assert.equal(decideWrite(policy, 'src/core/index.ts').allowed, false);
  // 验证命令前缀可用
  assert.equal(decideBash(policy, 'pnpm test --filter api').allowed, true);
  assert.equal(decideBash(policy, 'npm run build').allowed, true);
  assert.equal(decideBash(policy, 'node evil.js').allowed, false);
  // worker 可创建目录（新文件的父目录）
  assert.equal(decideBash(policy, 'mkdir -p src/api').allowed, true);
  assert.equal(decideBash(policy, 'rm -rf src').allowed, false);
  // 复合命令与 shell 元字符拒绝（与事后验证器同语义）
  assert.equal(decideBash(policy, 'pnpm test && rm -rf /').allowed, false);
});

test('absolute paths are normalized against the session cwd', () => {
  const policy = workerPolicy(task, config);
  assert.equal(decideWrite(policy, `${process.cwd()}/src/api/router.ts`, process.cwd()).allowed, true);
  assert.equal(decideWrite(policy, '/etc/passwd', process.cwd()).allowed, false);
});

test('absolute writes to not-yet-existing files resolve via parent realpath', () => {
  const policy = workerPolicy(task, config);
  const tmp = mkdtempSync(join(tmpdir(), 'agent-team-policy-'));
  const real = realpathSync(tmp);
  // macOS 的 /var → /private/var 符号链接：新文件（不存在）经符号链接形态的绝对路径也必须放行
  const linked = real.startsWith('/private/') ? real.replace('/private/', '/') : null;
  mkdirSync(join(tmp, 'src', 'api'), { recursive: true });
  assert.equal(decideWrite(policy, `${real}/src/api/new-file.ts`, tmp).allowed, true);
  if (linked) {
    assert.equal(decideWrite(policy, `${linked}/src/api/new-file.ts`, tmp).allowed, true);
  }
  // 越界新文件仍然拒绝
  assert.equal(decideWrite(policy, `${real}/outside/new-file.ts`, tmp).allowed, false);
});

test('integrator conflict resolution is limited to conflict files', () => {
  const policy = integratorPolicy('resolve_conflict', config, ['src/api/merge.ts']);
  assert.equal(decideWrite(policy, 'src/api/merge.ts').allowed, true);
  assert.equal(decideWrite(policy, 'src/api/router.ts').allowed, false);
  const finalize = integratorPolicy('finalize', config);
  assert.equal(decideWrite(finalize, 'specs/architecture.md').allowed, true);
  assert.equal(decideWrite(finalize, 'src/api/router.ts').allowed, false);
});

test('decideTool dispatches by tool kind and denies network tools by default', () => {
  const policy = workerPolicy(task, config);
  assert.equal(decideTool(policy, 'Bash', { command: 'pnpm test' }).allowed, true);
  assert.equal(decideTool(policy, 'Bash', { command: 'curl http://evil' }).allowed, false);
  assert.equal(decideTool(policy, 'Write', { file_path: 'src/api/new.ts' }).allowed, true);
  assert.equal(decideTool(policy, 'Edit', { file_path: 'src/api/secrets.ts' }).allowed, false);
  const web = decideTool(policy, 'WebFetch', { url: 'https://example.com' });
  assert.equal(web.allowed, false);
  assert.match(web.reason, /network/);
  // 未知工具默认放行（事后验证器兜底）
  assert.equal(decideTool(policy, 'Read', { file_path: 'src/api/secrets.ts' }).allowed, true);
});
