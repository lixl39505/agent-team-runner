import {
  createHostCapabilityRegistry,
  hostCapabilityProfile,
  type HostCapability,
  type HostCapabilityDeclarations,
  type HostCapabilityProfile,
  type HostName
} from './capabilities.js';

export type HostAction = 'resumeExternalThread' | 'startReviewTurn';

export interface HostActionRequest {
  host: string;
  externalThreadId: string;
  runId: string;
  clientId: string;
  /** This must be true for an outer Host action to be attempted. */
  explicitlyRequested: boolean;
}

export interface HostActionTransport {
  resumeExternalThread?(request: HostActionRequest): Promise<void>;
  startReviewTurn?(request: HostActionRequest): Promise<void>;
}

export interface HostActionResult {
  action: HostAction;
  host: string;
  externalThreadId: string;
  attempted: boolean;
  status: 'not_requested' | 'undeclared' | 'unavailable' | 'completed' | 'failed';
  fallback: 'durable_context_and_tui';
  error?: string;
}

export interface HostAdapterOptions {
  declarations?: HostCapabilityDeclarations;
  transports?: Partial<Record<HostName, HostActionTransport>>;
}

function failure(
  request: HostActionRequest,
  action: HostAction,
  status: HostActionResult['status'],
  error?: string
): HostActionResult {
  return {
    action,
    host: request.host,
    externalThreadId: request.externalThreadId,
    attempted: false,
    status,
    fallback: 'durable_context_and_tui',
    ...(error === undefined ? {} : { error })
  };
}

/**
 * Optional bridge for APIs owned by an outer Host process. The daemon never guesses
 * that a Host supports these actions; callers must request them and declarations gate them.
 */
export class HostAdapter {
  private readonly registry: Record<HostName, HostCapabilityProfile>;
  private readonly transports: Partial<Record<HostName, HostActionTransport>>;

  constructor(options: HostAdapterOptions = {}) {
    this.registry = createHostCapabilityRegistry(options.declarations);
    this.transports = options.transports ?? {};
  }

  capabilities(host: string): HostCapabilityProfile | undefined {
    return hostCapabilityProfile(this.registry, host);
  }

  async resumeExternalThread(request: HostActionRequest): Promise<HostActionResult> {
    return await this.attempt('resumeExternalThread', request);
  }

  async startReviewTurn(request: HostActionRequest): Promise<HostActionResult> {
    return await this.attempt('startReviewTurn', request);
  }

  private async attempt(action: HostAction, request: HostActionRequest): Promise<HostActionResult> {
    if (!request.explicitlyRequested) return failure(request, action, 'not_requested');
    const profile = this.capabilities(request.host);
    if (!profile || !profile.capabilities[action as HostCapability].declared) {
      return failure(request, action, 'undeclared');
    }
    const transport = this.transports[profile.host]?.[action];
    if (!transport) return failure(request, action, 'unavailable');
    try {
      await transport(request);
      return {
        action,
        host: request.host,
        externalThreadId: request.externalThreadId,
        attempted: true,
        status: 'completed',
        fallback: 'durable_context_and_tui'
      };
    } catch (error) {
      return {
        ...failure(request, action, 'failed', error instanceof Error ? error.message : String(error)),
        attempted: true
      };
    }
  }
}
