import { describe, expect, test } from 'bun:test';
import { agentResumeArgs, agentStartArgs } from '../src/herdr/agent-args.ts';

describe('agent-args', () => {
  test('model flag per kind', () => {
    expect(agentStartArgs({ kind: 'claude', model: 'opus' })).toEqual(['--model', 'opus']);
    expect(agentStartArgs({ kind: 'codex', model: 'gpt-5.4' })).toEqual(['--model', 'gpt-5.4']);
    expect(agentStartArgs({ kind: 'opencode', model: 'x' })).toEqual(['--model', 'x']);
  });

  test('extra args appended after model', () => {
    expect(agentStartArgs({ kind: 'claude', args: ['--dangerously-skip-permissions'] })).toEqual([
      '--dangerously-skip-permissions',
    ]);
    expect(agentStartArgs({ kind: 'claude', model: 'm', args: ['--a'] })).toEqual(['--model', 'm', '--a']);
  });

  test('resume argv per native session conventions', () => {
    expect(agentResumeArgs('claude', 's1')).toEqual(['--resume', 's1']);
    expect(agentResumeArgs('codex', 's2')).toEqual(['resume', 's2']);
    expect(agentResumeArgs('opencode', 's3')).toEqual(['--session', 's3']);
  });
});
