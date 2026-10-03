import { describe, expect, test } from 'bun:test';
import {
  AteamError,
  ContractBlockedError,
  ContractInvalidError,
  InterruptedError,
  NeedsAttentionError,
  exitCodeOf,
} from '../src/core/errors.ts';

describe('exit code protocol', () => {
  test('mechanical exit codes', () => {
    expect(exitCodeOf(new NeedsAttentionError('x'))).toBe(10);
    expect(exitCodeOf(new ContractBlockedError('x'))).toBe(11);
    expect(exitCodeOf(new InterruptedError())).toBe(130);
    expect(exitCodeOf(new ContractInvalidError('bad', ['a', 'b']))).toBe(1);
    expect(exitCodeOf(new AteamError('generic'))).toBe(1);
    expect(exitCodeOf(new Error('plain'))).toBe(1);
  });

  test('remediation attached', () => {
    expect(new ContractBlockedError('frozen').remediation).toContain('revise');
    expect(new NeedsAttentionError('x').remediation).toContain('status');
  });

  test('contract invalid error aggregates issues', () => {
    const err = new ContractInvalidError('rejected', ['issue one', 'issue two']);
    expect(err.message).toContain('issue one');
    expect(err.message).toContain('issue two');
  });
});
