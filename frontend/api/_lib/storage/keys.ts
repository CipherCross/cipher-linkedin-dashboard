/**
 * Tenant object-key isolation: the grammar every object key must satisfy, and
 * the refusal that runs before any key reaches a provider.
 *
 * ## Why keys are *built* here rather than validated at the edge
 *
 * G0's storage decision is a private bucket per tenant, so the bucket boundary
 * is already one isolation mechanism. This module is a second, independent one,
 * and the reason to have both is that they fail differently:
 *
 * - The **bucket** boundary is enforced by the provider and by whatever scope
 *   its token was issued with. It fails if a token is minted too broadly — an
 *   account-scoped R2 token instead of a bucket-scoped one is a single
 *   mis-click in a dashboard, and nothing in the application can detect it.
 * - The **key prefix** is enforced here, in code, by a test. It fails if this
 *   file is wrong.
 *
 * Neither covers the other's failure, which is the entire argument for paying
 * for both. A provider instance is bound to one tenant at construction and
 * refuses every key outside `t/<tenantId>/`, so a request that has somehow
 * acquired another tenant's key is refused before a URL is ever signed — even
 * if the credential behind it would have permitted the read.
 *
 * ## Why the grammar is an allowlist and not a blocklist
 *
 * `src/lib/leadPhotos.ts` already carries a blocklist version of this idea for
 * the Supabase path: reject `..`, reject `://`, reject `?`. That was correct for
 * a display helper over service-written values, and it is the wrong shape here,
 * because a blocklist has to anticipate its attacker. This accepts a small
 * character set and refuses everything else, so the interesting cases —
 * percent-encoded traversal (`%2e%2e`), a Unicode homoglyph separator, a NUL,
 * a trailing space that some stores silently strip — are refused without any of
 * them having been thought of. They are still tested, but the test documents
 * the property rather than creating it.
 *
 * **Not in scope:** the agent-artifact bucket. G0 places it in a separately
 * scoped bucket with its own credential, and the spec gives it to `S23`. Its
 * keys are not tenant-prefixed and must not borrow this grammar by accident.
 */

import { DataStoreContractError } from '../data/contracts.js'

/** The single-character namespace every tenant object lives under. */
export const TENANT_KEY_PREFIX = 't'

/**
 * S3 and R2 both cap an object key at 1024 bytes. Enforced here so the refusal
 * is ours and explains itself, rather than a 400 from a provider.
 */
export const MAX_OBJECT_KEY_LENGTH = 1024

/**
 * The object classes this application stores, as an allowlist.
 *
 * A new class is added by the slice that needs it, together with its
 * content-type and size policy in `policy.ts` — the two are meant to be edited
 * in the same commit, because a class with no policy would otherwise inherit
 * the most permissive one by omission.
 */
export const OBJECT_CLASSES = ['lead-photos'] as const
export type ObjectClass = (typeof OBJECT_CLASSES)[number]

export class ObjectKeyError extends DataStoreContractError {
  constructor(message: string) {
    super('OBJECT_KEY_INVALID', message)
    this.name = 'ObjectKeyError'
  }
}

/**
 * A tenant identifier as it appears in a key.
 *
 * Lowercase because object keys are case-sensitive and a tenant that could
 * appear as both `Acme` and `acme` would occupy two prefixes that look like one.
 */
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * One path segment: ASCII word characters, with at most one dot introducing a
 * short extension. No spaces, no percent signs, no dots at the edges — so `.`,
 * `..` and `...` are all unrepresentable rather than special-cased.
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9]{1,8})?$/

export interface TenantObjectKey {
  readonly tenantId: string
  readonly objectClass: ObjectClass
  readonly segments: readonly string[]
}

export function isValidTenantId(value: unknown): value is string {
  return typeof value === 'string' && TENANT_ID_PATTERN.test(value)
}

export function isValidKeySegment(value: unknown): value is string {
  return typeof value === 'string' && SEGMENT_PATTERN.test(value)
}

function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (!isValidTenantId(tenantId)) {
    throw new ObjectKeyError(
      `Tenant id ${JSON.stringify(tenantId)} is not a lowercase alphanumeric ` +
        `token of at most 64 characters. A tenant id becomes an object-key ` +
        `prefix, so anything else would let one tenant's prefix contain or ` +
        `resemble another's.`,
    )
  }
}

/**
 * Build a validated object key. This is the only supported way to make one:
 * every entry point that accepts caller-influenced values funnels through here,
 * so a key that exists is a key that has already been refused or accepted.
 */
export function buildTenantObjectKey(input: {
  readonly tenantId: string
  readonly objectClass: ObjectClass
  readonly segments: readonly string[]
}): string {
  assertTenantId(input.tenantId)

  if (!OBJECT_CLASSES.includes(input.objectClass)) {
    throw new ObjectKeyError(
      `Object class ${JSON.stringify(input.objectClass)} is not one of ` +
        `${OBJECT_CLASSES.join(', ')}. Classes are an allowlist; add one here ` +
        `and give it a content-type and size policy in the same change.`,
    )
  }

  if (!Array.isArray(input.segments) || input.segments.length === 0) {
    throw new ObjectKeyError('An object key needs at least one path segment')
  }

  for (const segment of input.segments) {
    if (!isValidKeySegment(segment)) {
      throw new ObjectKeyError(
        `Object key segment ${JSON.stringify(segment)} is not accepted. ` +
          `Segments are [A-Za-z0-9_-] with at most one short extension; ` +
          `separators, dots, percent signs, whitespace and non-ASCII are ` +
          `refused rather than escaped.`,
      )
    }
  }

  const key = [
    TENANT_KEY_PREFIX,
    input.tenantId,
    input.objectClass,
    ...input.segments,
  ].join('/')

  // Byte length, not code-unit length: the provider's limit is on bytes, and
  // the segment grammar is ASCII so the two agree — but the check is written
  // against the thing that is actually limited.
  if (Buffer.byteLength(key, 'utf8') > MAX_OBJECT_KEY_LENGTH) {
    throw new ObjectKeyError(
      `Object key is ${Buffer.byteLength(key, 'utf8')} bytes, over the ` +
        `${MAX_OBJECT_KEY_LENGTH}-byte limit`,
    )
  }

  return key
}

/**
 * Parse a key back into its parts, refusing anything `buildTenantObjectKey`
 * would not have produced.
 *
 * **This used to end with a round-trip check** — rebuild the key from the
 * parsed parts, demand an exact match — on the theory that it would catch
 * non-canonical input without anyone having to anticipate the specific trick.
 * The mutation pass showed it was unreachable: every component is validated by
 * the same rules the builder applies and `join` is deterministic, so a doubled
 * separator or a trailing slash is already refused as an empty *segment* before
 * the comparison happens. Worse, it was masking the object-class check below —
 * deleting that check reddened nothing, because the round-trip called the
 * builder, which re-checked the class.
 *
 * It is gone rather than kept-and-documented, because a guard that cannot fire
 * is a guard nobody can maintain: the next person to loosen the segment grammar
 * would have no way to discover that the safety net they were relying on had
 * never been load-bearing.
 */
export function parseTenantObjectKey(key: unknown): TenantObjectKey {
  if (typeof key !== 'string' || key === '') {
    throw new ObjectKeyError('An object key must be a non-empty string')
  }
  if (Buffer.byteLength(key, 'utf8') > MAX_OBJECT_KEY_LENGTH) {
    throw new ObjectKeyError(
      `Object key exceeds the ${MAX_OBJECT_KEY_LENGTH}-byte limit`,
    )
  }

  const parts = key.split('/')
  if (parts.length < 4 || parts[0] !== TENANT_KEY_PREFIX) {
    throw new ObjectKeyError(
      `Object key ${JSON.stringify(key)} is not under the ` +
        `${TENANT_KEY_PREFIX}/<tenant>/<class>/ namespace`,
    )
  }

  const [, tenantId, objectClass, ...segments] = parts
  assertTenantId(tenantId)

  if (!OBJECT_CLASSES.includes(objectClass as ObjectClass)) {
    throw new ObjectKeyError(
      `Object class ${JSON.stringify(objectClass)} is not an allowed class`,
    )
  }
  for (const segment of segments) {
    if (!isValidKeySegment(segment)) {
      throw new ObjectKeyError(
        `Object key segment ${JSON.stringify(segment)} is not accepted`,
      )
    }
  }

  return { tenantId, objectClass: objectClass as ObjectClass, segments }
}

/**
 * The check a provider runs on every operation.
 *
 * Deliberately not `key.startsWith(prefix)`. A prefix comparison accepts
 * `t/acme-evil/...` for tenant `acme`, because one tenant id can be a prefix of
 * another; this parses the key and compares the tenant *segment* for equality.
 */
export function assertKeyBelongsToTenant(
  key: unknown,
  tenantId: string,
): TenantObjectKey {
  assertTenantId(tenantId)
  const parsed = parseTenantObjectKey(key)

  if (parsed.tenantId !== tenantId) {
    // The message names neither the requested tenant nor the key's owner
    // beyond what the caller already supplied: a refusal should not be a
    // discovery channel for which tenants exist.
    throw new ObjectKeyError(
      `Object key does not belong to tenant ${JSON.stringify(tenantId)}`,
    )
  }

  return parsed
}
