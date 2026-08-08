/**
 * Closed application-owned control-plane bridge vocabulary for S26.
 *
 * The bridge is intentionally not a generic proxy: it accepts only these
 * named operations and never receives a caller-provided URL, header map, SQL,
 * shell command, environment value, or arbitrary provider payload.
 */
export const S26_BRIDGE_PROTOCOL_VERSION = "s26-control-plane.v1" as const;

const BRIDGE_OPERATIONS = {
  /**
   * Neon has a public project control-plane API, but it deliberately does not
   * expose a portable migration ledger, SQL/RLS smoke suite, or full recovery
   * workflow. Those operations stay in the application-owned bridge.
   */
  data: [
    "inspect",
    "portable-schema-apply",
    "smoke",
    "recovery-capture",
    "recovery-restore",
    "recovery-verify",
  ],
  identity: [
    "inspect",
    "configure",
    "support-membership",
    "company-admin-invite",
    "smoke",
    "recovery-capture",
    "recovery-restore",
    "recovery-verify",
  ],
  /** R2 bucket creation is direct; object-level checks and recovery are bridged. */
  objectStorage: ["smoke", "recovery-capture", "recovery-restore", "recovery-verify"],
  /** Vercel project/domain APIs are direct; server-held values and evidence are bridged. */
  hosting: [
    "inspect",
    "environment-bind",
    "build",
    "schedules",
    "promote",
    "rollback",
    "verify",
    "recovery-capture",
    "recovery-restore",
    "recovery-verify",
  ],
  smtp: ["inspect", "configure", "smoke"],
  domain: ["inspect"],
  sourceRepository: ["inspect"],
} as const;

export type S26BridgeCapability = keyof typeof BRIDGE_OPERATIONS;
export type S26BridgeOperation<C extends S26BridgeCapability> =
  (typeof BRIDGE_OPERATIONS)[C][number];

const capabilityPath: Record<S26BridgeCapability, string> = {
  data: "data",
  identity: "identity",
  objectStorage: "object-storage",
  hosting: "hosting",
  smtp: "smtp",
  domain: "domain",
  sourceRepository: "source-repository",
};

/** Returns the only bridge endpoint shape used by S26 adapters. */
export function s26BridgePath<C extends S26BridgeCapability>(
  capability: C,
  operation: S26BridgeOperation<C>,
): string {
  return `s26/control-plane/v1/${capabilityPath[capability]}/${operation}`;
}

export function isS26BridgeOperation(
  capability: string,
  operation: string,
): boolean {
  return (Object.entries(BRIDGE_OPERATIONS) as readonly [string, readonly string[]][])
    .some(([candidateCapability, operations]) =>
      candidateCapability === capability && operations.includes(operation));
}

export interface S26BridgeRoute {
  readonly capability: S26BridgeCapability;
  readonly operation: string;
}

/** Parses only the fixed bridge route grammar; no caller-supplied URL survives. */
export function parseS26BridgePath(path: string): S26BridgeRoute | null {
  const match = /^\/?s26\/control-plane\/v1\/(data|identity|object-storage|hosting|smtp|domain|source-repository)\/([a-z-]+)$/.exec(path);
  if (!match) return null;
  const pathCapability = match[1]!;
  const operation = match[2]!;
  const capability = (Object.entries(capabilityPath).find(([, value]) => value === pathCapability)?.[0]) as S26BridgeCapability | undefined;
  return capability && isS26BridgeOperation(capability, operation)
    ? { capability, operation }
    : null;
}
