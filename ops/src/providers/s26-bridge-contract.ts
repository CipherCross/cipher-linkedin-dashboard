/**
 * Closed application-owned control-plane bridge vocabulary for S26.
 *
 * The bridge is intentionally not a generic proxy: it accepts only these
 * named operations and never receives a caller-provided URL, header map, SQL,
 * shell command, environment value, or arbitrary provider payload.
 */
export const S26_BRIDGE_PROTOCOL_VERSION = "s26-control-plane.v1" as const;

const BRIDGE_OPERATIONS = {
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
  smtp: ["inspect", "configure", "smoke"],
  domain: ["inspect"],
  sourceRepository: ["inspect"],
} as const;

export type S26BridgeCapability = keyof typeof BRIDGE_OPERATIONS;
export type S26BridgeOperation<C extends S26BridgeCapability> =
  (typeof BRIDGE_OPERATIONS)[C][number];

const capabilityPath: Record<S26BridgeCapability, string> = {
  identity: "identity",
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
