/**
 * The provider-neutral object-storage contract.
 *
 * **The interface is small on purpose, and for the reason `IdentityProvider`'s
 * is.** G0 selected Cloudflare R2 and explicitly retained AWS S3 as the
 * portable fallback. That retention is only worth anything if swapping the
 * adapter is a bounded change, and it is bounded only while the application
 * depends on few members. So the surface is declared here, `r2Provider.ts` is
 * the only file that knows what R2 is, and every caller talks to this.
 *
 * **What a provider deliberately cannot do:**
 *
 * - It cannot decide *who* may touch an object. Authorization happens before a
 *   provider is called, against the canonical database, exactly as it does for
 *   identity. A provider answers "here is a URL for this key, bounded like
 *   this" — never "this user may read this lead".
 * - It cannot reach another tenant. An instance is bound to one tenant at
 *   construction and every method re-checks the key against it
 *   (`assertKeyBelongsToTenant`). The check is per call rather than per
 *   instance because a long-lived instance in a warm serverless container
 *   outlives the request that created it.
 * - It cannot hand out a `head` or `delete` capability. Those exist as
 *   server-performed methods; see `policy.ts` for why that asymmetry is
 *   deliberate.
 * - It never touches bytes on the read path. `presignGet` returns a URL for the
 *   browser to fetch directly; object bytes do not pass through a function.
 *
 * **What S19 left out, and what S20 added.** S19 shipped no `listObjects` and no
 * byte-level write, on the stated ground that an unused surface would probably be
 * the wrong shape for its first real caller. S20 is that caller, and the shape it
 * wanted differs from the guess in two ways worth recording:
 *
 * - `putObject` takes an **optional SHA-256** and, when given one, the store is
 *   asked to verify it. A copy tool that hashes the bytes itself and then trusts
 *   its own upload has proved that it read the source correctly and nothing about
 *   what arrived; see `copy.ts`.
 * - `listObjects` answers `ObservedObject`, not `ObjectStat`, and its checksums
 *   are `null`. A listing cannot carry them — `ListObjectsV2` returns size and
 *   `ETag` and no checksum value — and a method that filled the field in from the
 *   `ETag` would be reporting an MD5 as a SHA-256. Reconciliation asks for each
 *   object's checksum separately, and `manifest.ts` has a distinct status for the
 *   case where it comes back unknown.
 *
 * Still absent: `copyObject` (server-side copy within one bucket, which nothing
 * needs). S23's authenticated machine photo path is now a server-side caller of
 * `putObject`, and its separate release-artifact bucket is intentionally owned
 * by `releaseArtifacts.ts`, not by this tenant-object contract.
 */

import { DataStoreContractError } from '../data/contracts.js'
import type { ObjectClass } from './keys.js'

export class ObjectStorageError extends DataStoreContractError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = 'ObjectStorageError'
  }
}

/** The provider was reached and refused, or could not be reached at all. */
export class ObjectStorageUnavailableError extends ObjectStorageError {
  constructor(message: string) {
    super('OBJECT_STORAGE_UNAVAILABLE', message)
    this.name = 'ObjectStorageUnavailableError'
  }
}

export interface SignedObjectUrl {
  readonly url: string
  readonly method: 'GET' | 'PUT'
  /**
   * When the URL stops working, as a UTC instant.
   *
   * Returned rather than left implicit because the caller usually has to cache
   * the URL for slightly less than this — `leadPhotos.ts` already does exactly
   * that against the Supabase path, with a refresh skew.
   */
  readonly expiresAt: string
  /**
   * Headers the request **must** carry, verbatim.
   *
   * These are not advisory. They are signed into the URL, so a request that
   * omits or alters one fails signature verification at the store. For a `put`
   * this is how the content-type and byte-count limits are enforced at all —
   * see `policy.ts`.
   */
  readonly requiredHeaders: Readonly<Record<string, string>>
}

export interface ObjectStat {
  readonly key: string
  readonly sizeBytes: number
  readonly contentType: string | null
  readonly etag: string | null
  /**
   * The stored SHA-256 as lowercase hex, or `null` when the store does not
   * report one.
   *
   * **`null` is a real answer and must not be smoothed away.** An object written
   * without a checksum has none to return, and a store may decline to return one
   * it holds. The field is not the `ETag`: for a single-part upload an `ETag` is
   * an MD5, for a multipart one it is a hash of hashes, and presenting either as
   * a SHA-256 would make a reconciliation report claim a comparison it never
   * made. `manifest.ts` carries `checksumUnverified` for exactly this case.
   */
  readonly checksumSha256: string | null
}

export interface PresignGetInput {
  readonly key: string
  readonly ttlSeconds: number
}

export interface PresignPutInput {
  readonly key: string
  readonly ttlSeconds: number
  readonly contentType: string
  /**
   * The exact number of bytes that will be uploaded.
   *
   * Required, not optional, and exact rather than a maximum: it is signed as a
   * mandatory `content-length` header, which is the only thing that actually
   * bounds an upload made with a presigned URL.
   */
  readonly contentLength: number
}

export interface ObjectStorageProvider {
  /** Recorded in logs and in any future object manifest. */
  readonly name: string

  /** The one tenant this instance may address. */
  readonly tenantId: string

  /** A URL the browser may fetch the object with. */
  presignGet(input: PresignGetInput): Promise<SignedObjectUrl>

  /** A URL the browser may upload exactly the declared bytes to. */
  presignPut(input: PresignPutInput): Promise<SignedObjectUrl>

  /**
   * Object metadata, or `null` when the object is not there.
   *
   * `null` rather than a throw, because "absent" is an ordinary answer on this
   * path: a lead whose photo sync has not run yet is not an error. A provider
   * that could not be reached at all throws `ObjectStorageUnavailableError`,
   * and the two must stay distinguishable — treating an outage as "missing"
   * would let a reconciliation pass conclude the store had been emptied.
   */
  statObject(key: string): Promise<ObjectStat | null>

  /**
   * Remove an object.
   *
   * Returns nothing, and that is a deliberate refusal to lie: S3 and R2 both
   * answer `204` to a delete whether or not the object existed, so a provider
   * cannot report which happened without a preceding `statObject`. Callers that
   * genuinely need to know must ask for the stat and accept that the pair is
   * not atomic.
   */
  deleteObject(key: string): Promise<void>

  /**
   * Write bytes from the server, with the store verifying the checksum.
   *
   * **Not signable, for the reason `delete` is not.** An upload the *server*
   * performs is a different operation from an upload a browser performs: this one
   * carries the whole object through the process, so it is only ever used by
   * tooling running outside a request (`copy.ts`), and handing a browser a
   * capability to write arbitrary bytes under any key in the class would defeat
   * the exact-`content-length` mechanism `presignPut` exists for.
   *
   * `checksumSha256` is base64, which is the encoding the store's own header
   * takes; `manifest.ts` holds hex and `hexToBase64` converts. When it is
   * supplied the store recomputes the hash and refuses a body that does not
   * match, which is what makes a copy *verified* rather than merely attempted.
   */
  putObject(input: PutObjectInput): Promise<ObjectStat>

  /**
   * One page of the objects under a prefix.
   *
   * The prefix must be inside this provider's tenant — a listing is the one
   * operation that could otherwise enumerate a neighbour's keys without ever
   * naming one, so `assertKeyBelongsToTenant`'s protection has a prefix-shaped
   * equivalent (`assertPrefixBelongsToTenant`) rather than an exception.
   */
  listObjects(input: ListObjectsInput): Promise<ListObjectsPage>

  close(): Promise<void>
}

export interface PutObjectInput {
  readonly key: string
  readonly body: Uint8Array
  readonly contentType: string
  /** Base64 SHA-256. Omitted only by callers that have no hash to offer. */
  readonly checksumSha256?: string
}

export interface ListObjectsInput {
  /** Tenant-scoped. `t/<tenantId>/` at minimum; deeper narrows the walk. */
  readonly prefix: string
  readonly cursor?: string | null
  readonly limit?: number
}

export interface ListObjectsPage {
  /**
   * What the listing saw. `sha256` is always `null` — see the note in this
   * file's header on why a listing cannot answer it.
   */
  readonly objects: readonly ListedObject[]
  readonly nextCursor: string | null
}

export interface ListedObject {
  readonly key: string
  readonly sizeBytes: number
  readonly etag: string | null
}

/** Where an object of a given class lives, for callers building keys. */
export interface ObjectLocation {
  readonly tenantId: string
  readonly objectClass: ObjectClass
  readonly segments: readonly string[]
}
