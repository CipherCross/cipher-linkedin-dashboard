/**
 * The agent release destination: a second bucket, a second credential, and a key
 * grammar that deliberately does not borrow `keys.ts`'s.
 *
 * ## Why this is not `lead-photos` with another class added
 *
 * Spec §5 puts `lead-photos` and agent release artifacts in "two destinations and
 * two permission sets", and `keys.ts` restates the second half of that in its own
 * header: the agent-artifact bucket's keys are **not tenant-prefixed and must not
 * borrow this grammar by accident**. Both halves matter and they are separate
 * claims:
 *
 * - **Two destinations.** A release artifact is not tenant data. Every tenant on
 *   this codebase runs the same `agent.py`, so filing it under `t/<tenant>/` would
 *   either duplicate one file per tenant or lie about which tenant owns it. It has
 *   no tenant, so it gets no tenant prefix, so it cannot live in a bucket whose
 *   entire isolation story is that prefix.
 * - **Two permission sets.** The lead-photos token may write; this one is minted
 *   **read-only** on the bucket, because nothing in the request path ever writes a
 *   release. `deploy.sh` publishes with a separate operator-held credential that no
 *   deployment holds. So a full compromise of the dashboard's environment yields
 *   the ability to *serve* releases, never to *publish* one — and publishing is the
 *   step that reaches every notebook.
 *
 * That second point is the reason the signature in `manifest.ts`-shaped form is
 * worth anything at all. See `verify_release_signature` in `agent.py`.
 *
 * ## The layout
 *
 *   agent/current.json            — the pointer: which version is current
 *   agent/<version>/agent.py      — the bytes
 *   agent/<version>/manifest.json — version, sha256, size, released_at, signature
 *
 * A pointer object rather than a mutable `agent/agent.py` at a fixed key, because
 * a release must be *addressable after it is superseded*: a notebook that fails
 * verification needs the operator to be able to look at exactly the bytes it
 * rejected, and a bucket that overwrites one key has already destroyed them.
 */

import { DataStoreContractError } from '../data/contracts.js'
import {
  INTERNAL_OPERATION_TTL_SECONDS,
  MIN_SIGNED_URL_TTL_SECONDS,
} from './policy.js'
import { presignUrl, type Sigv4Credentials } from './sigv4.js'

export type EnvSource = Readonly<Record<string, string | undefined>>

export const AGENT_RELEASE_ENDPOINT_ENV = 'AGENT_RELEASE_ENDPOINT'
export const AGENT_RELEASE_BUCKET_ENV = 'AGENT_RELEASE_BUCKET'
export const AGENT_RELEASE_ACCESS_KEY_ID_ENV = 'AGENT_RELEASE_ACCESS_KEY_ID'
export const AGENT_RELEASE_SECRET_ACCESS_KEY_ENV =
  'AGENT_RELEASE_SECRET_ACCESS_KEY'
export const AGENT_RELEASE_REGION_ENV = 'AGENT_RELEASE_REGION'

export const DEFAULT_AGENT_RELEASE_REGION = 'auto'

/**
 * How long a notebook's download URL lives.
 *
 * Two minutes: the notebook fetches it immediately and once. Deliberately far
 * below `MAX_GET_TTL_SECONDS`, which is sized for a browser rendering a page of
 * avatars — this URL is consumed by one program in one request, and a longer life
 * only widens the window in which a leaked URL serves the fleet's update channel.
 */
export const RELEASE_DOWNLOAD_TTL_SECONDS = 120

/** The prefix everything in this bucket lives under. */
export const RELEASE_KEY_PREFIX = 'agent'

/** The pointer object naming the current version. */
export const RELEASE_POINTER_KEY = `${RELEASE_KEY_PREFIX}/current.json`

/**
 * A release version, as it appears in a key.
 *
 * Deliberately narrower than semver: digits and dots only, three components. The
 * value is interpolated into an object path, so anything that could contain a
 * separator, a dot-segment or a percent sign is refused rather than escaped —
 * the same allowlist argument `keys.ts` makes, made again here because this file
 * is *not* allowed to reuse that grammar and a silent divergence would be worse
 * than a restatement.
 */
const VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/

/** Lowercase hex SHA-256. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/

/** Base64 Ed25519 signature: 64 bytes. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/

/**
 * The largest release this path will serve.
 *
 * `agent.py` is ~100 KB. The cap exists so a manifest claiming a gigabyte cannot
 * make a notebook allocate one before it has checked anything.
 */
export const MAX_RELEASE_BYTES = 4 * 1024 * 1024

/** The smallest plausible agent. Mirrors `self_update`'s own size floor. */
export const MIN_RELEASE_BYTES = 10_000

export class AgentReleaseConfigurationError extends DataStoreContractError {
  constructor(message: string) {
    super('AGENT_RELEASE_NOT_CONFIGURED', message)
    this.name = 'AgentReleaseConfigurationError'
  }
}

export class AgentReleaseError extends DataStoreContractError {
  constructor(message: string) {
    super('AGENT_RELEASE_INVALID', message)
    this.name = 'AgentReleaseError'
  }
}

export interface AgentReleaseConfig {
  readonly endpoint: string
  readonly bucket: string
  readonly region: string
  readonly credentials: Sigv4Credentials
}

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/

function readRequired(env: EnvSource, name: string): string {
  const value = env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentReleaseConfigurationError(
      `${name} is not set. The agent release path needs its own bucket and its ` +
        `own read-only bucket-scoped token, separate from the lead-photos ` +
        `bucket. Until it is set this deployment answers 503 for release ` +
        `downloads and notebooks keep their current agent build.`,
    )
  }
  return value.trim()
}

export function readAgentReleaseConfig(
  env: EnvSource = process.env,
): AgentReleaseConfig {
  const rawEndpoint = readRequired(env, AGENT_RELEASE_ENDPOINT_ENV)
  let endpoint: URL
  try {
    endpoint = new URL(rawEndpoint)
  } catch {
    throw new AgentReleaseConfigurationError(
      `${AGENT_RELEASE_ENDPOINT_ENV} must be an absolute URL such as ` +
        `https://example.r2.cloudflarestorage.com`,
    )
  }
  if (endpoint.protocol !== 'https:') {
    throw new AgentReleaseConfigurationError(
      `${AGENT_RELEASE_ENDPOINT_ENV} must be https. A signed URL is a bearer ` +
        `token and must never cross a plaintext connection.`,
    )
  }

  const bucket = readRequired(env, AGENT_RELEASE_BUCKET_ENV)
  if (!BUCKET_PATTERN.test(bucket)) {
    throw new AgentReleaseConfigurationError(
      `${AGENT_RELEASE_BUCKET_ENV} must be a single lowercase path segment; ` +
        `${JSON.stringify(bucket)} is not one`,
    )
  }

  const accessKeyId = readRequired(env, AGENT_RELEASE_ACCESS_KEY_ID_ENV)
  const secretAccessKey = readRequired(env, AGENT_RELEASE_SECRET_ACCESS_KEY_ENV)
  if (accessKeyId === secretAccessKey) {
    throw new AgentReleaseConfigurationError(
      `${AGENT_RELEASE_ACCESS_KEY_ID_ENV} and ` +
        `${AGENT_RELEASE_SECRET_ACCESS_KEY_ENV} must be different values`,
    )
  }

  // Checked, and this is the one configuration mistake that would be invisible
  // otherwise: pointing the release path at the lead-photos bucket would put
  // tenant photos and fleet release artifacts behind one credential and undo the
  // whole separation this file exists for. The variables can still name the same
  // *account*, which is fine — buckets are the boundary.
  const photoBucket = env.OBJECT_STORAGE_BUCKET?.trim()
  if (photoBucket && photoBucket === bucket) {
    throw new AgentReleaseConfigurationError(
      `${AGENT_RELEASE_BUCKET_ENV} names the same bucket as ` +
        `OBJECT_STORAGE_BUCKET. Release artifacts and tenant objects live in ` +
        `two destinations with two permission sets; one bucket for both means ` +
        `the credential that serves photos can also serve — and, if it was ` +
        `minted writable, publish — agent releases.`,
    )
  }

  const region =
    env[AGENT_RELEASE_REGION_ENV]?.trim() || DEFAULT_AGENT_RELEASE_REGION

  return {
    endpoint: endpoint.origin,
    bucket,
    region,
    credentials: { accessKeyId, secretAccessKey },
  }
}

/** Whether this deployment can serve releases at all, as a boolean. */
export function agentReleaseConfigured(env: EnvSource = process.env): boolean {
  try {
    readAgentReleaseConfig(env)
    return true
  } catch {
    return false
  }
}

export function isValidReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value)
}

/** The key holding one release's bytes. */
export function releaseArtifactKey(version: string): string {
  if (!isValidReleaseVersion(version)) {
    throw new AgentReleaseError(
      `Release version ${JSON.stringify(version)} is not three dot-separated ` +
        `numbers. The value is interpolated into an object path, so it is ` +
        `accepted from an allowlist rather than escaped.`,
    )
  }
  return `${RELEASE_KEY_PREFIX}/${version}/agent.py`
}

/** The key holding one release's signed manifest. */
export function releaseManifestKey(version: string): string {
  if (!isValidReleaseVersion(version)) {
    throw new AgentReleaseError(
      `Release version ${JSON.stringify(version)} is not three dot-separated numbers`,
    )
  }
  return `${RELEASE_KEY_PREFIX}/${version}/manifest.json`
}

/**
 * What `deploy.sh` writes and what a notebook verifies.
 *
 * `signature` covers `canonicalReleaseManifest()` of the other four fields, so
 * the *version*, the *hash* and the *size* are all inside the signature — a
 * manifest whose hash was swapped for another real release's would not verify,
 * and neither would one replayed under a different version number.
 */
export interface AgentReleaseManifest {
  readonly version: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly releasedAt: string
  readonly signature: string
}

/**
 * The exact bytes the signature covers.
 *
 * Fixed field order and separators written out by hand rather than
 * `JSON.stringify` of an object literal: the signed form is a wire contract with
 * a Python verifier, and it must not be able to change because someone reordered
 * an interface. `canonicalJson` in `ingest.ts` sorts keys for the same class of
 * reason; this one does not sort, it *fixes*, because there are exactly four
 * fields and they will never be added to without a new signature version.
 */
export function canonicalReleaseManifest(input: {
  readonly version: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly releasedAt: string
}): string {
  return [
    'lh2-agent-release/1',
    input.version,
    input.sha256,
    String(input.sizeBytes),
    input.releasedAt,
  ].join('\n')
}

/**
 * Parse a manifest object's bytes, refusing anything malformed.
 *
 * **This does not verify the signature, and cannot.** The verifying key lives on
 * the notebook and nowhere else — see the agent's `release transport` section.
 * That is the entire design: this server holds a *read-only* credential on the
 * release bucket and no signing key at all, so a compromised deployment can serve
 * whatever the bucket holds and can never produce a manifest a notebook accepts.
 * Checking a signature here would suggest otherwise while adding nothing.
 */
export function parseReleaseManifest(body: unknown): AgentReleaseManifest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentReleaseError('a release manifest must be a JSON object')
  }
  const record = body as Record<string, unknown>

  const version = String(record.version ?? '')
  if (!isValidReleaseVersion(version)) {
    throw new AgentReleaseError('manifest.version is not a release version')
  }

  const sha256 = String(record.sha256 ?? '').toLowerCase()
  if (!SHA256_PATTERN.test(sha256)) {
    throw new AgentReleaseError('manifest.sha256 is not 64 lowercase hex digits')
  }

  const sizeBytes = record.size_bytes
  if (
    typeof sizeBytes !== 'number' ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes < MIN_RELEASE_BYTES ||
    sizeBytes > MAX_RELEASE_BYTES
  ) {
    throw new AgentReleaseError(
      `manifest.size_bytes must be an integer between ${MIN_RELEASE_BYTES} ` +
        `and ${MAX_RELEASE_BYTES}`,
    )
  }

  const releasedAt = String(record.released_at ?? '')
  if (Number.isNaN(new Date(releasedAt).valueOf())) {
    throw new AgentReleaseError('manifest.released_at is not an ISO-8601 instant')
  }

  const signature = String(record.signature ?? '')
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new AgentReleaseError(
      'manifest.signature is not a base64 Ed25519 signature',
    )
  }

  return { version, sha256, sizeBytes, releasedAt, signature }
}

/** Parse the pointer object. One field, and it is a version. */
export function parseReleasePointer(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentReleaseError('the release pointer must be a JSON object')
  }
  const version = String((body as Record<string, unknown>).version ?? '')
  if (!isValidReleaseVersion(version)) {
    throw new AgentReleaseError('the release pointer names no valid version')
  }
  return version
}

// ---------------------------------------------------------------------------
// The store access.
// ---------------------------------------------------------------------------

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface AgentReleaseStoreOptions {
  readonly config?: AgentReleaseConfig
  readonly fetchImpl?: FetchLike
  readonly now?: () => number
}

/**
 * Read-only access to the release bucket.
 *
 * Every method is a GET. There is deliberately no write of any kind here — not
 * even an unused one — because the only thing standing between "the dashboard can
 * serve releases" and "the dashboard can publish releases" is that the code to do
 * the second does not exist and the token is not minted for it. A convenience
 * `putRelease` would erode both at once.
 */
export class AgentReleaseStore {
  private readonly config: AgentReleaseConfig
  private readonly fetchImpl: FetchLike
  private readonly now: () => number

  constructor(options: AgentReleaseStoreOptions = {}) {
    this.config = options.config ?? readAgentReleaseConfig()
    this.fetchImpl =
      options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.now = options.now ?? (() => Date.now())
  }

  private signedUrl(key: string, ttlSeconds: number): {
    readonly url: string
    readonly expiresAt: string
  } {
    const signedAt = new Date(this.now())
    const { url } = presignUrl({
      method: 'GET',
      origin: this.config.endpoint,
      path: `/${this.config.bucket}/${key}`,
      region: this.config.region,
      service: 's3',
      credentials: this.config.credentials,
      expiresInSeconds: ttlSeconds,
      signedAt,
    })
    return {
      url,
      expiresAt: new Date(signedAt.getTime() + ttlSeconds * 1000).toISOString(),
    }
  }

  /** A short-lived URL the server consumes itself, never returns. */
  private async readJson(key: string): Promise<unknown> {
    const { url } = this.signedUrl(key, INTERNAL_OPERATION_TTL_SECONDS)
    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'GET' })
    } catch (error) {
      throw new AgentReleaseError(
        `the release bucket could not be reached: ${
          error instanceof Error ? error.name : 'unknown error'
        }`,
      )
    }
    if (response.status === 404) {
      throw new AgentReleaseError(`${key} is not present in the release bucket`)
    }
    if (!response.ok) {
      throw new AgentReleaseError(
        `the release bucket answered ${response.status} for ${key}`,
      )
    }
    try {
      return await response.json()
    } catch {
      throw new AgentReleaseError(`${key} is not valid JSON`)
    }
  }

  /** The version the pointer names. */
  async currentVersion(): Promise<string> {
    return parseReleasePointer(await this.readJson(RELEASE_POINTER_KEY))
  }

  /**
   * One release's manifest, checked against the version that was asked for.
   *
   * The cross-check is not redundant with the signature: the signature proves the
   * operator produced this manifest, and this proves the bucket returned the
   * manifest for the key that was requested. A bucket that answered
   * `agent/1.14.0/manifest.json` with a genuine, correctly-signed manifest for
   * 1.9.0 would otherwise get a notebook to downgrade itself to a real old build
   * — a rollback attack that every individual signature check passes.
   */
  async manifest(version: string): Promise<AgentReleaseManifest> {
    const manifest = parseReleaseManifest(
      await this.readJson(releaseManifestKey(version)),
    )
    if (manifest.version !== version) {
      throw new AgentReleaseError(
        `the manifest at ${releaseManifestKey(version)} declares version ` +
          `${manifest.version}`,
      )
    }
    return manifest
  }

  /** A URL a notebook may download the release bytes with. */
  downloadUrl(version: string): { readonly url: string; readonly expiresAt: string } {
    const ttl = Math.max(RELEASE_DOWNLOAD_TTL_SECONDS, MIN_SIGNED_URL_TTL_SECONDS)
    return this.signedUrl(releaseArtifactKey(version), ttl)
  }
}
