import test from 'node:test';
import assert from 'node:assert/strict';
import { compileClaude } from '../dist/agent/claude/policy.js';
import { compileCodex } from '../dist/agent/codex/policy.js';
import { compileOpenCode, compileOpenCodeBasePermission } from '../dist/agent/opencode/policy.js';

test('claude compile preserves native asks behind coarse role boundaries', () => {
  const worker = compileClaude('workspace-write');
  assert.equal(worker.permissionMode, 'default');
  assert.deepEqual(worker.allowedTools.sort(), ['Glob', 'Grep', 'Read']);
  for (const gated of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']) {
    assert.equal(worker.allowedTools.includes(gated), false, `${gated} must use Claude native permission handling`);
    assert.equal(worker.disallowedTools.includes(gated), false, `${gated} must not be hard-denied for workers`);
  }

  const readOnly = compileClaude('read-only');
  for (const mutating of ['Edit', 'Write', 'NotebookEdit']) {
    assert.ok(readOnly.disallowedTools.includes(mutating));
  }
  assert.equal(readOnly.disallowedTools.includes('Bash'), false, 'read-only sandbox, not command parsing, enforces writes');
  assert.equal(readOnly.disallowedTools.includes('WebFetch'), false, 'network remains natively approvable');
});

test('codex compile uses native untrusted approvals and role sandboxes', () => {
  const readOnly = compileCodex('read-only', '/repo');
  assert.deepEqual(readOnly.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(readOnly.approvalPolicy, 'untrusted');
  assert.equal(readOnly.access, 'read-only');

  const worker = compileCodex('workspace-write', '/repo');
  assert.deepEqual(worker.sandboxPolicy, {
    type: 'workspaceWrite', writableRoots: ['/repo'], networkAccess: false,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true
  });
  assert.equal(worker.approvalPolicy, 'untrusted');
  assert.equal(worker.access, 'workspace-write');
});

test('opencode asks natively for mutable, network, and external operations', () => {
  assert.deepEqual(compileOpenCodeBasePermission(), {
    '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
    bash: 'ask', edit: 'ask', webfetch: 'ask', websearch: 'ask', external_directory: 'ask'
  });
  assert.equal(compileOpenCode('read-only').access, 'read-only');
  assert.equal(compileOpenCode('workspace-write').access, 'workspace-write');
});
