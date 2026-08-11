import { OpsError } from "../core/errors.js";

/**
 * Neon exposes no metadata field on a project, so a project that merely carries
 * our deterministic name proves nothing: a name collision inside the same
 * organization is indistinguishable from our own resource.
 *
 * Ownership is therefore written onto the project itself, as a role whose name
 * carries the ownership marker — the same idea as the marker the hosting
 * adapter stores as a Vercel environment variable. Both the client that creates
 * the project and the bridge that inspects it derive the name here, so they
 * cannot disagree.
 *
 * Postgres role names are limited to 63 bytes, so the digest is truncated. 32
 * hex characters is 128 bits, which is far beyond collision reach for a marker
 * that only has to distinguish our own resources from a foreign one.
 */
export function neonOwnershipRoleName(ownershipMarkerDigest: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(ownershipMarkerDigest);
  if (!match) {
    throw new OpsError("provider_error", "Ownership marker digest is malformed");
  }
  return `lh2_owner_${match[1]!.slice(0, 32)}`;
}
