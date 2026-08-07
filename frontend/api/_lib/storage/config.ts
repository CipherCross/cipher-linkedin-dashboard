/**
 * Server-only configuration for the object-storage layer.
 *
 * The pattern is `neonConfig.ts`'s and `identity/config.ts`'s, unchanged:
 * refuse a `VITE_` name, refuse to resolve in a browser, and fail with an
 * explanatory error rather than falling back to anything.
 *
 * **The names are provider-neutral (`OBJECT_STORAGE_*`, not `R2_*`), and that
 * is a decision rather than a style.** G0 keeps AWS S3 as the retained
 * fallback, and both providers take the same four inputs — endpoint, bucket,
 * access key id, secret. Naming the variables after the selected vendor would
 * mean a provider swap edits every deployment environment as well as one
 * adapter file, which is exactly the coupling `ObjectStorageProvider` exists to
 * prevent. The vendor's name appears in `r2Provider.ts` and nowhere else.
 *
 * **Why a storage credential is a fourth credential, not a reuse of one.** This
 * deployment already holds three separate server-only credentials — the runtime
 * database role, the AI execution principal and the identity store — kept apart
 * because they are authorized differently. A storage credential joins them for
 * the same reason: it grants object access and nothing else, and a compromise
 * of it must not be a read of the database. It is also the one credential whose
 * scope is set outside this repository, in the provider's own token settings,
 * which is why `keys.ts` enforces tenant isolation independently in code.
 */

import { DataStoreContractError } from '../data/contracts.js'
import { isValidTenantId } from './keys.js'
import type { Sigv4Credentials } from './sigv4.js'

/**
 * The region used when the environment names none.
 *
 * `auto` is the literal R2 requires — it has no regions in the S3 sense. It is
 * declared here rather than imported from `r2Provider.ts` on purpose: this
 * module is the provider-neutral half, and a neutral module importing from an
 * adapter is the coupling `ObjectStorageProvider` exists to prevent. The S3
 * fallback sets a real region explicitly and never reaches this default.
 */
export const DEFAULT_OBJECT_STORAGE_REGION = 'auto'

/** Endpoint origin, e.g. `https://<account>.r2.cloudflarestorage.com`. */
export const OBJECT_STORAGE_ENDPOINT_ENV = 'OBJECT_STORAGE_ENDPOINT'
/** The tenant's private bucket. */
export const OBJECT_STORAGE_BUCKET_ENV = 'OBJECT_STORAGE_BUCKET'
export const OBJECT_STORAGE_ACCESS_KEY_ID_ENV = 'OBJECT_STORAGE_ACCESS_KEY_ID'
export const OBJECT_STORAGE_SECRET_ACCESS_KEY_ENV =
  'OBJECT_STORAGE_SECRET_ACCESS_KEY'
/** Optional; `auto` for R2, a real region for the S3 fallback. */
export const OBJECT_STORAGE_REGION_ENV = 'OBJECT_STORAGE_REGION'
/**
 * Which tenant this deployment's objects belong to.
 *
 * **Why this is an environment variable and not a column.** `N-S19.md` known
 * limit 4 states the gap: nothing in the canonical schema carries a tenant id,
 * because multi-tenancy is `S21`+. Every caller today would have to supply a
 * constant, and S19 declined to choose it.
 *
 * S20 has to choose, because it has the first caller — and the environment is the
 * right place for exactly as long as the situation lasts. G0's storage decision is
 * a *private bucket per tenant*, so a deployment already names its tenant when it
 * names its bucket; putting the id beside `OBJECT_STORAGE_BUCKET` keeps the two
 * facts in one place, and a deployment that sets one and not the other fails
 * closed rather than writing into a prefix nobody chose.
 *
 * There is deliberately **no default.** A fallback such as `default` or `primary`
 * would be the value production silently ran on, and moving off it later means
 * rewriting every key in the bucket. When `S21` gives the schema a tenant id, this
 * variable becomes the bootstrap value for the workspace's own row and the request
 * path reads the column instead.
 */
export const OBJECT_STORAGE_TENANT_ID_ENV = 'OBJECT_STORAGE_TENANT_ID'

export type EnvSource = Readonly<Record<string, string | undefined>>

export class ObjectStorageConfigurationError extends DataStoreContractError {
  constructor(message: string) {
    super('OBJECT_STORAGE_CONFIGURATION_MISSING', message)
    this.name = 'ObjectStorageConfigurationError'
  }
}

function assertServerSide(name: string): void {
  if (typeof window !== 'undefined') {
    throw new ObjectStorageConfigurationError(
      `${name} is server-only and must not be resolved in a browser context`,
    )
  }
  if (name.startsWith('VITE_')) {
    throw new ObjectStorageConfigurationError(
      `${name} is browser-exposed; a storage credential must never use a ` +
        `VITE_ prefix. The browser receives short-lived signed URLs, never the ` +
        `credential that mints them.`,
    )
  }
}

function readRequired(env: EnvSource, name: string, purpose: string): string {
  assertServerSide(name)
  const value = env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ObjectStorageConfigurationError(
      `${name} is not set. ${purpose} Set it in the server environment ` +
        `(never as VITE_${name}) and re-run. Refusing to continue: an ` +
        `unconfigured storage layer would mint URLs that authenticate nobody.`,
    )
  }
  return value.trim()
}

export interface ObjectStorageRuntimeConfig {
  readonly endpoint: string
  readonly bucket: string
  readonly region: string
  readonly credentials: Sigv4Credentials
}

/**
 * A bucket name has to be a single path segment: it is interpolated into the
 * signed path, so a value containing a separator would silently re-target the
 * request at a different object than the key says.
 */
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/

export function readObjectStorageConfig(
  env: EnvSource = process.env,
): ObjectStorageRuntimeConfig {
  const rawEndpoint = readRequired(
    env,
    OBJECT_STORAGE_ENDPOINT_ENV,
    `The object storage layer needs its S3-compatible endpoint origin.`,
  )

  let endpoint: URL
  try {
    endpoint = new URL(rawEndpoint)
  } catch {
    throw new ObjectStorageConfigurationError(
      `${OBJECT_STORAGE_ENDPOINT_ENV} must be an absolute URL such as ` +
        `https://example.r2.cloudflarestorage.com`,
    )
  }
  if (endpoint.protocol !== 'https:') {
    // Not negotiable: the signed URL and the object bytes both travel over it,
    // and a signature observed in transit is usable until it expires.
    throw new ObjectStorageConfigurationError(
      `${OBJECT_STORAGE_ENDPOINT_ENV} must be https. A signed URL is a bearer ` +
        `token and must never cross a plaintext connection.`,
    )
  }

  const bucket = readRequired(
    env,
    OBJECT_STORAGE_BUCKET_ENV,
    `The object storage layer needs the tenant's private bucket name.`,
  )
  if (!BUCKET_PATTERN.test(bucket)) {
    throw new ObjectStorageConfigurationError(
      `${OBJECT_STORAGE_BUCKET_ENV} must be a single lowercase path segment; ` +
        `${JSON.stringify(bucket)} is not one`,
    )
  }

  const accessKeyId = readRequired(
    env,
    OBJECT_STORAGE_ACCESS_KEY_ID_ENV,
    `The object storage layer needs a bucket-scoped access key id.`,
  )
  const secretAccessKey = readRequired(
    env,
    OBJECT_STORAGE_SECRET_ACCESS_KEY_ENV,
    `The object storage layer needs the secret for its bucket-scoped token.`,
  )
  if (accessKeyId === secretAccessKey) {
    throw new ObjectStorageConfigurationError(
      `${OBJECT_STORAGE_ACCESS_KEY_ID_ENV} and ` +
        `${OBJECT_STORAGE_SECRET_ACCESS_KEY_ENV} must be different values`,
    )
  }

  const region =
    env[OBJECT_STORAGE_REGION_ENV]?.trim() || DEFAULT_OBJECT_STORAGE_REGION

  return {
    endpoint: endpoint.origin,
    bucket,
    region,
    credentials: { accessKeyId, secretAccessKey },
  }
}

/**
 * The deployment's tenant id, validated as one.
 *
 * Read separately from `readObjectStorageConfig` rather than folded into it, so
 * the copy tooling — which needs a tenant and a provider — and a caller that only
 * wants to know whether storage is configured at all can each ask for what they
 * use. It is validated here as well as inside `keys.ts` because this is where a
 * deployment's typo enters the system, and a message naming the variable is worth
 * more at that point than one naming a key grammar.
 */
export function readObjectStorageTenantId(
  env: EnvSource = process.env,
): string {
  const raw = readRequired(
    env,
    OBJECT_STORAGE_TENANT_ID_ENV,
    `The object storage layer needs the tenant whose objects this deployment ` +
      `serves; object keys are prefixed with it.`,
  )
  if (!isValidTenantId(raw)) {
    throw new ObjectStorageConfigurationError(
      `${OBJECT_STORAGE_TENANT_ID_ENV} must be a lowercase alphanumeric token ` +
        `of at most 64 characters (hyphens allowed, not leading); ` +
        `${JSON.stringify(raw)} is not one. It becomes an object-key prefix, so ` +
        `anything else would let one tenant's prefix resemble another's.`,
    )
  }
  return raw
}

/**
 * Whether this deployment can serve objects at all, as a boolean.
 *
 * Used by the one caller that must not throw: the unauthenticated path-flag
 * lookup, which answers "which photo path does this deployment serve" and has to
 * answer `supabase` — not fail — when storage is unconfigured. Every other caller
 * wants the exception, because by then a missing credential is a fault rather than
 * a state.
 */
export function objectStorageConfigured(env: EnvSource = process.env): boolean {
  try {
    readObjectStorageConfig(env)
    readObjectStorageTenantId(env)
    return true
  } catch {
    return false
  }
}
