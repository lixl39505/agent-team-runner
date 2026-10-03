#!/usr/bin/env bun
// Stand-in `herdr` binary for transport tests. Behavior is driven by a
// control file next to this fixture named control-<ppid>.json — the ppid is
// the bun test process that spawned us, so each test file gets its own
// isolated control channel (no environment-variable races).
//
//   { "mode": "ok|error|usage|garbage|hang|notfound", "version": "...", "agentState": "..." }

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface Control {
  mode?: string;
  version?: string;
  agentState?: string;
}

let control: Control = {};
try {
  control = JSON.parse(readFileSync(join(dirname(import.meta.path), `control-${process.ppid}.json`), 'utf8')) as Control;
} catch {
  /* defaults */
}

const mode = control.mode ?? 'ok';
const agentState = control.agentState;
const args = process.argv.slice(2);

function emit(json: unknown): void {
  console.log(JSON.stringify(json));
}

if (mode === 'hang') {
  await Bun.sleep(60_000);
  process.exit(0);
}

if (mode === 'usage' && args.length > 0) {
  process.stderr.write('error: unexpected argument\n');
  process.exit(2);
}

if (mode === 'error') {
  process.stderr.write(JSON.stringify({ id: 'x', error: { code: 'not_found', message: 'pane not found' } }) + '\n');
  process.exit(1);
}

if (mode === 'garbage') {
  process.stdout.write('this is definitely not json\n');
  process.exit(0);
}

if (mode === 'notfound') {
  process.stderr.write('command not found: herdr\n');
  process.exit(127);
}

// mode ok
const [first, ...rest] = args;
if (first === '--version') {
  console.log(control.version ?? 'herdr 0.8.0-test');
  process.exit(0);
}
if (first === 'api' && rest[0] === 'schema') {
  emit({
    id: 'schema',
    result: {
      methods: [
        'worktree.create', 'worktree.open', 'worktree.remove',
        'agent.start', 'agent.prompt', 'agent.wait', 'agent.get',
        'session.snapshot', 'pane.report_agent', 'plugin.link', 'plugin.action.list',
      ],
    },
  });
  process.exit(0);
}
if (first === 'api' && rest[0] === 'snapshot') {
  emit({
    id: 'snap',
    result: {
      version: '0.8.0-test',
      workspaces: [{ workspace_id: 'w1', label: 'api', worktree: { branch: 'ateam/r1/API', path: '/wt/api' } }],
      tabs: [{ tab_id: 'w1:t', workspace_id: 'w1' }],
      panes: [{ pane_id: 'w1:p', workspace_id: 'w1', tab_id: 'w1:t' }],
      agents: [{ name: 'reviewer', pane_id: 'w1:p', state: agentState ?? 'blocked' }],
    },
  });
  process.exit(0);
}
if (first === 'worktree' && rest[0] === 'create') {
  const branch = rest[rest.indexOf('--branch') + 1] ?? 'unknown';
  emit({
    id: 'wt',
    result: {
      workspace: { workspace_id: 'w9', worktree: { branch, path: `/wt/${branch.replaceAll('/', '-')}` } },
      tab: { tab_id: 'w9:t', workspace_id: 'w9' },
      root_pane: { pane_id: 'w9:p', workspace_id: 'w9', tab_id: 'w9:t' },
      worktree: { workspace_id: 'w9', branch, path: `/wt/${branch.replaceAll('/', '-')}` },
    },
  });
  process.exit(0);
}
if (first === 'pane' && rest[0] === 'split') {
  emit({ id: 'split', result: { pane: { pane_id: 'w1:p7', workspace_id: 'w1', tab_id: 'w1:t' } } });
  process.exit(0);
}
if (first === 'pane' && rest[0] === 'read') {
  process.stdout.write('line one\nline two\n');
  process.exit(0);
}
if (first === 'agent' && rest[0] === 'get') {
  emit({
    id: 'get',
    result: {
      name: 'reviewer', pane_id: 'w1:p', state: agentState ?? 'working',
      agent_session: { source: 'herdr:codex', value: 'sess-42' },
    },
  });
  process.exit(0);
}
if (first === 'agent' && rest[0] === 'start') {
  emit({ id: 'start', result: { agent: { name: args[2] ?? 'agent', pane_id: 'w9:p', state: 'idle' } } });
  process.exit(0);
}
if (first === 'agent' && (rest[0] === 'wait' || rest[0] === 'prompt')) {
  emit({ id: 'wait', result: { pane_id: 'w9:p', state: 'done', agent: { state: 'done' } } });
  process.exit(0);
}
if (first === 'pane' && rest[0] === 'report-agent') {
  emit({ id: 'report', result: { type: 'pane_report_agent', shown: true } });
  process.exit(0);
}
// generic ok for close/focus/remove etc.
emit({ id: 'ok', result: { type: 'ok' } });
process.exit(0);
