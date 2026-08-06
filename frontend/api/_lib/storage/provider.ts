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
 * **What is not here, and whose job it is.** There is no `listObjects`, no
 * `copyObject` and no manifest. The spec gives the object manifest, checksum
 * reconciliation and copy tooling to `S20`, and adding a listing method now
 * would be an unused surface that the first real caller would probably want
 * shaped differently.
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

  close(): Promise<void>
}

/** Where an object of a given class lives, for callers building keys. */
export interface ObjectLocation {
  readonly tenantId: string
  readonly objectClass: ObjectClass
  readonly segments: readonly string[]
}
