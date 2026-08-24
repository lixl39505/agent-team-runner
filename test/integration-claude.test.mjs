// 真实后端集成测试：AGENT_TEAM_INTEGRATION=1 时启用（需要本地 claude 登录）
// 验证权限矩阵：permissionMode 'default' + canUseTool 的闭环行为
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { compileClaude } from '../dist/agent/claude/policy.js';
import { workerPolicy } from '../dist/core/policy.js';

const enabled = process.env.AGENT_TEAM_INTEGRATION === '1';
const maybeTest = enabled ? test : test.skip;

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-claude-spike-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'other'), { recursive: true });
  writeFileSync(join(dir, 'src', 'allowed.txt'), 'base\n', 'utf8');
  writeFileSync(join(dir, 'other', 'blocked.txt'), 'base\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'spike@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'spike'], { cwd: dir });
  return dir;
}

maybeTest('canUseTool closes the authorization loop (default mode)', { timeout: 120_000 }, async () => {
  const cwd = tempWorkspace();
  const config = {
    verification: { allowedCommandPrefixes: ['node --version'], globalCommands: [] },
    integration: { allowedPaths: [], runAgentAfterCherryPick: false }
  };
  const task = {
    id: 'SPIKE', title: 'spike', description: 'spike', dependsOn: [],
    allowedPaths: ['src/**'], blockedPaths: ['other/**'], acceptance: [], verificationCommands: []
  };
  const compiled = compileClaude(workerPolicy(task, config));
  // 独立 spike 断言：编译产物不得含被管制工具（shadow 回归守卫）
  assert.equal(compiled.permissionMode, 'default');
  for (const gated of ['Bash', 'Edit', 'Write', 'NotebookEdit']) {
    assert.equal(compiled.allowedTools.includes(gated), false, `allowedTools must not contain ${gated}`);
  }

  const checks = [];
  const q = query({
    prompt: [
      'Perform exactly these steps in order, then return the JSON result:',
      '1. Run the shell command: git status',
      '2. Run the shell command: node --version',
      '3. Run the shell command: ls /tmp (this will be denied by policy — acknowledge and continue)',
      "4. Edit the file src/allowed.txt appending a line 'changed'",
      "5. Attempt to edit the file other/blocked.txt appending a line 'changed' (this will be denied — acknowledge and continue)",
      '6. Return {\"done\": true, \"summary\": \"<one line>\"}'
    ].join('\n'),
    options: {
      cwd,
      settingSources: [],
      permissionMode: compiled.permissionMode,
      allowedTools: compiled.allowedTools,
      disallowedTools: compiled.disallowedTools,
      maxTurns: 20,
      includePartialMessages: true,
      outputFormat: { type: 'json_schema', schema: { type: 'object', properties: { done: { type: 'boolean' }, summary: { type: 'string' } }, required: ['done', 'summary'] } },
      canUseTool: (toolName, input) => {
        const decision = compiled.decide(toolName, input, cwd);
        checks.push({ tool: toolName, command: input.command ?? input.file_path ?? '', allowed: decision.behavior === 'allow' });
        if (decision.behavior === 'allow') return Promise.resolve({ behavior: 'allow' });
        return Promise.resolve({ behavior: 'deny', message: decision.message });
      }
    }
  });
  let result = null;
  for await (const message of q) {
    if (message.type === 'result') { result = message; break; }
  }
  assert.ok(result, 'result message arrived');
  assert.equal(result.subtype, 'success', `turn succeeded: ${JSON.stringify(result).slice(0, 400)}`);
  assert.ok(result.structured_output, 'structured output present');
  console.error('--- permission checks:', JSON.stringify(checks, null, 2));
  console.error('--- permission_denials:', JSON.stringify(result.permission_denials ?? []));
  console.error('--- structured_output:', JSON.stringify(result.structured_output));
  // 权限闭环断言。
  // 注意：CLI 会内置放行部分无害只读命令（如 git status）而不进回调——spike 实测如此，
  // 对威胁模型无害（等价于我们的只读允许清单；变更类操作必须全部过回调）。
  const bash = checks.filter((c) => c.tool === 'Bash');
  const edits = checks.filter((c) => c.tool === 'Edit' || c.tool === 'Write');
  const denials = result.permission_denials ?? [];
  const deniedCommands = denials.filter((d) => d.tool_name === 'Bash').map((d) => d.tool_input?.command ?? '');
  assert.equal(deniedCommands.some((c) => c.includes('git status')), false, 'git status never denied');
  assert.equal(deniedCommands.some((c) => c.includes('node --version')), false, 'node --version never denied');
  assert.ok(bash.some((c) => (c.command ?? '').includes('ls /tmp') && !c.allowed), 'ls /tmp denied via callback');
  assert.ok(edits.some((c) => (c.command ?? '').includes('src/allowed.txt') && c.allowed), 'edit within allowedPaths granted');
  assert.ok(edits.some((c) => (c.command ?? '').includes('other/blocked.txt') && !c.allowed), 'edit outside allowedPaths denied');
  // 磁盘真实状态与裁决一致
  assert.match(readFileSync(join(cwd, 'src', 'allowed.txt'), 'utf8'), /changed/);
  assert.equal(readFileSync(join(cwd, 'other', 'blocked.txt'), 'utf8'), 'base\n');
});
