// Error taxonomy + mechanical exit codes (ADR: 0=done 10=needs-attention
// 11=contract-blocked 1=failed 130=interrupted).

export type ExitCode = 0 | 1 | 10 | 11 | 130;

export interface Remediation {
  hint: string;
}

export class AteamError extends Error {
  readonly exitCode: ExitCode;
  readonly remediation?: string;

  constructor(message: string, opts: { exitCode: ExitCode; remediation?: string } = { exitCode: 1 }) {
    super(message);
    this.name = new.target.name;
    this.exitCode = opts.exitCode;
    this.remediation = opts.remediation;
  }
}

/** Contract rejected before a run exists. Usage-level failure. */
export class ContractInvalidError extends AteamError {
  constructor(message: string, readonly issues: string[] = []) {
    super(
      issues.length > 0 ? `${message}\n  - ${issues.join('\n  - ')}` : message,
      { exitCode: 1, remediation: 'fix the contract document and retry' },
    );
  }
}

/** A task escalated to blocked_on_contract; run froze until a revision lands. */
export class ContractBlockedError extends AteamError {
  constructor(message: string) {
    super(message, {
      exitCode: 11,
      remediation: 'revise the contract via `agent-team contract revise`',
    });
  }
}

/** Run needs a human (blocked pane, exhausted attempts...). Panes retained. */
export class NeedsAttentionError extends AteamError {
  constructor(message: string) {
    super(message, { exitCode: 10, remediation: 'inspect `agent-team status` and attach blocked panes' });
  }
}

/** Runtime/Herdr failure. */
export class RuntimeError extends AteamError {}

export class InterruptedError extends AteamError {
  constructor(message = 'interrupted') {
    super(message, { exitCode: 130 });
  }
}

/** doctor probe failed; message carries the remediation. */
export class DoctorError extends AteamError {
  constructor(message: string, remediation: string) {
    super(message, { exitCode: 1, remediation });
  }
}

export function exitCodeOf(error: unknown): ExitCode {
  if (error instanceof AteamError) return error.exitCode;
  return 1;
}
