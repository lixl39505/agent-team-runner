import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeBackend } from '../dist/agent/claude/sdk.js';

async function captureSessionOptions(access, requestApproval) {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-team-claude-cwd-'));
  let capturedOptions;
  const queryFactory = ({ options }) => {
    capturedOptions = options;
    return {
      close() {},
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          structured_output: { status: 'completed' },
          session_id: 'test-session'
        };
      }
    };
  };
  const backend = new ClaudeBackend({}, queryFactory);

  const session = await backend.openSession({
    role: 'worker',
    cwd,
    prompt: 'test',
    schema: { type: 'object' },
    access,
    ...(requestApproval ? { requestApproval } : {}),
    timeoutMs: 1_000,
    staleAfterMs: 1_000
  });
  const outcome = await session.completion();
  await session.close();
  return { cwd, options: capturedOptions, outcome, backend };
}

test('ClaudeBackend forwards cwd and applies a read-only role sandbox', async () => {
  const { cwd, options, outcome } = await captureSessionOptions('read-only');
  assert.equal(options.cwd, cwd);
  assert.equal(options.sandbox.enabled, true);
  assert.equal(options.sandbox.failIfUnavailable, true);
  assert.equal(options.sandbox.allowUnsandboxedCommands, false);
  assert.ok(options.sandbox.filesystem.denyWrite.includes(cwd));
  assert.equal(options.sandbox.network, undefined);
  assert.ok(options.disallowedTools.includes('Write'));
  assert.ok(options.disallowedTools.includes('Task'));
  assert.deepEqual(options.settingSources, []);
  assert.equal(outcome.ok, true);
});

test('Claude workspace sandbox protects Git metadata without making cwd read-only', async () => {
  const { cwd, options } = await captureSessionOptions('workspace-write');
  assert.equal(options.sandbox.filesystem.denyWrite.includes(cwd), false);
  assert.ok(options.sandbox.filesystem.denyWrite.includes(join(cwd, '.git')));
  assert.equal(options.sandbox.network, undefined);
  assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
});

test('Claude canUseTool forwards native context and maps session permission suggestions', async () => {
  const requests = [];
  const { options } = await captureSessionOptions('workspace-write', async (request) => {
    requests.push(request);
    return 'session';
  });
  const result = await options.canUseTool('Bash', { command: 'npm test' }, {
    signal: new AbortController().signal,
    suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'projectSettings' }],
    decisionReason: 'command requires approval',
    title: 'Claude wants to run npm test',
    toolUseID: 'tool-1',
    requestId: 'request-1'
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, 'command');
  assert.equal(requests[0].allowSession, true);
  assert.equal(result.behavior, 'allow');
  assert.equal(result.updatedPermissions[0].destination, 'session');
});

test('Claude read-only sessions cannot elevate unknown or MCP tools', async () => {
  let prompted = false;
  const { options } = await captureSessionOptions('read-only', async () => { prompted = true; return 'once'; });
  const result = await options.canUseTool('mcp__deploy__release', { target: 'production' }, {
    signal: new AbortController().signal,
    toolUseID: 'tool-2',
    requestId: 'request-2'
  });
  assert.equal(result.behavior, 'deny');
  assert.equal(prompted, false);
});
