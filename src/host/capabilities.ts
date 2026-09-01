export const hostNames = ['claude-code', 'codex', 'opencode'] as const;
export type HostName = typeof hostNames[number];

export const hostCapabilityNames = [
  'logging',
  'elicitation',
  'idleEvent',
  'resumeExternalThread',
  'startReviewTurn'
] as const;
export type HostCapability = typeof hostCapabilityNames[number];

export type HostCapabilityProbeState = 'unverified' | 'supported' | 'unsupported';

export interface HostCapabilityStatus {
  /** A maintainer has explicitly enabled this capability for the Host integration. */
  declared: boolean;
  /** A Host-specific spike may update this observation; it does not enable the capability itself. */
  probe: HostCapabilityProbeState;
}

export type HostCapabilitySet = Record<HostCapability, HostCapabilityStatus>;

export interface HostCapabilityProfile {
  host: HostName;
  capabilities: HostCapabilitySet;
}

export type HostCapabilityDeclarations = Partial<Record<HostName, Partial<Record<HostCapability, boolean>>>>;

export interface HostCapabilityProbe {
  probe(host: HostName, capability: HostCapability): Promise<boolean>;
}

function capabilitySet(declarations: Partial<Record<HostCapability, boolean>> = {}): HostCapabilitySet {
  return Object.fromEntries(hostCapabilityNames.map((capability) => [capability, {
    declared: declarations[capability] === true,
    probe: 'unverified'
  }])) as HostCapabilitySet;
}

/**
 * Creates the explicit allow-list for outer Host behavior. Built-in Hosts deliberately
 * start unverified and disabled: protocol-level MCP tests are not evidence of Host UI support.
 */
export function createHostCapabilityRegistry(
  declarations: HostCapabilityDeclarations = {}
): Record<HostName, HostCapabilityProfile> {
  return Object.fromEntries(hostNames.map((host) => [host, {
    host,
    capabilities: capabilitySet(declarations[host])
  }])) as Record<HostName, HostCapabilityProfile>;
}

export const defaultHostCapabilityRegistry = createHostCapabilityRegistry();

export function isHostName(value: string): value is HostName {
  return (hostNames as readonly string[]).includes(value);
}

/** Returns a copy so callers cannot mutate the registry used to gate actions. */
export function hostCapabilityProfile(
  registry: Readonly<Record<HostName, HostCapabilityProfile>>,
  host: string
): HostCapabilityProfile | undefined {
  if (!isHostName(host)) return undefined;
  const profile = registry[host];
  return {
    host,
    capabilities: Object.fromEntries(hostCapabilityNames.map((capability) => [capability, {
      ...profile.capabilities[capability]
    }])) as HostCapabilitySet
  };
}

/** Executes Host-specific probes without implicitly promoting their results to an allow-list. */
export async function probeHostCapabilities(
  registry: Readonly<Record<HostName, HostCapabilityProfile>>,
  host: HostName,
  probe: HostCapabilityProbe
): Promise<HostCapabilityProfile> {
  const profile = hostCapabilityProfile(registry, host)!;
  await Promise.all(hostCapabilityNames.map(async (capability) => {
    try {
      profile.capabilities[capability].probe = await probe.probe(host, capability) ? 'supported' : 'unsupported';
    } catch {
      profile.capabilities[capability].probe = 'unsupported';
    }
  }));
  return profile;
}
