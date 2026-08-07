/**
 * An in-memory `ObjectStorageProvider`, plus the piece that makes it worth
 * having: a `deliver()` method that behaves like the store on the other end of
 * a signed URL.
 *
 * **Why the fake also plays the store.** A fake that only returned URL strings
 * could assert that a URL was produced and nothing about what it permits, and
 * "what it permits" is the entire subject of S19. So this fake keeps the terms
 * of every URL it issues and enforces them when one is presented: the method,
 * the expiry, the exact key, and every header that was signed. That makes the
 * six acceptance properties — allow, deny, missing, expiry, type, size —
 * testable as *behaviour* in the default `npm test`, with no bucket, no token
 * and no network.
 *
 * **What it is not.** It is not a re-implementation of R2, and it must never be
 * used to assert R2's behaviour. It does not compute a signature, so it proves
 * nothing about signing — `objectStorageSigv4.test.ts` owns that against AWS's
 * published vector. The division is the one `fakeProvider.ts` in `identity/`
 * already draws: this suite proves the *product* honours the contract, and the
 * adapter's own correctness is proved elsewhere, or recorded as unproven.
 *
 * The fake is faithful on exactly the properties the product depends on: a URL
 * is a bearer token, it stops working at its expiry, it addresses one key and
 * one method, and a signed header is mandatory rather than advisory.
 */

import { randomUUID } from 'node:crypto'

import { assertKeyBelongsToTenant, assertPrefixBelongsToTenant } from './keys.js'
import { sha256Base64, sha256Hex } from './manifest.js'
import {
  assertSignedUrlTtl,
  assertUploadContentType,
  assertUploadSize,
} from './policy.js'
import {
  ObjectStorageError,
  ObjectStorageUnavailableError,
  type ListObjectsInput,
  type ListObjectsPage,
  type ObjectStat,
  type ObjectStorageProvider,
  type PresignGetInput,
  type PresignPutInput,
  type PutObjectInput,
  type SignedObjectUrl,
} from './provider.js'

/** Scheme for URLs this fake issues. Not fetchable, and meant not to be. */
export const FAKE_STORAGE_SCHEME = 'memory:'

interface StoredObject {
  readonly sizeBytes: number
  readonly contentType: string
  readonly etag: string
  /**
   * Hex SHA-256, or `null` for an object written without one.
   *
   * The fake keeps the distinction the real store makes rather than hashing
   * everything it holds: an object seeded by a test or uploaded through a signed
   * PUT has no checksum, and `manifest.ts`'s `checksumUnverified` status is only
   * exercisable if some path can actually produce it.
   */
  readonly checksumSha256: string | null
}

interface IssuedGrant {
  readonly key: string
  readonly method: 'GET' | 'PUT'
  readonly expiresAtMs: number
  readonly requiredHeaders: Readonly<Record<string, string>>
}

export interface DeliveryRequest {
  readonly url: string
  readonly method: 'GET' | 'PUT'
  readonly headers?: Readonly<Record<string, string>>
  /** Bytes actually sent, which need not match the declared `content-length`. */
  readonly bodyBytes?: number
}

export interface DeliveryResult {
  readonly status: number
  readonly reason?: string
}

export interface FakeObjectStorageOptions {
  readonly tenantId: string
  /** Injectable so a test can pass an expiry without sleeping. */
  readonly now?: () => number
}

export class FakeObjectStorageProvider implements ObjectStorageProvider {
  readonly name = 'fake'
  readonly tenantId: string

  private readonly objects = new Map<string, StoredObject>()
  private readonly grants = new Map<string, IssuedGrant>()
  private readonly now: () => number
  private closed = false

  constructor(options: FakeObjectStorageOptions) {
    this.tenantId = options.tenantId
    this.now = options.now ?? (() => Date.now())
  }

  /** Put an object there directly, bypassing a signed upload. Test setup. */
  seedObject(input: {
    readonly key: string
    readonly sizeBytes: number
    readonly contentType: string
    /** Hex SHA-256, when a test needs the destination to report one. */
    readonly checksumSha256?: string
  }): void {
    assertKeyBelongsToTenant(input.key, this.tenantId)
    this.objects.set(input.key, {
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      etag: randomUUID().replace(/-/g, ''),
      checksumSha256: input.checksumSha256 ?? null,
    })
  }

  objectCount(): number {
    return this.objects.size
  }

  async presignGet(input: PresignGetInput): Promise<SignedObjectUrl> {
    this.assertOpen()
    assertKeyBelongsToTenant(input.key, this.tenantId)
    const ttl = assertSignedUrlTtl('get', input.ttlSeconds)
    return this.issue(input.key, 'GET', ttl, {})
  }

  async presignPut(input: PresignPutInput): Promise<SignedObjectUrl> {
    this.assertOpen()
    const parsed = assertKeyBelongsToTenant(input.key, this.tenantId)
    const ttl = assertSignedUrlTtl('put', input.ttlSeconds)
    const contentType = assertUploadContentType(
      parsed.objectClass,
      input.contentType,
    )
    const contentLength = assertUploadSize(parsed.objectClass, input.contentLength)

    return this.issue(input.key, 'PUT', ttl, {
      'content-type': contentType,
      'content-length': String(contentLength),
    })
  }

  async statObject(key: string): Promise<ObjectStat | null> {
    this.assertOpen()
    assertKeyBelongsToTenant(key, this.tenantId)
    const stored = this.objects.get(key)
    if (!stored) return null
    return this.statOf(key, stored)
  }

  async deleteObject(key: string): Promise<void> {
    this.assertOpen()
    assertKeyBelongsToTenant(key, this.tenantId)
    // Idempotent, like the real thing: no complaint when it was already gone.
    this.objects.delete(key)
  }

  /**
   * A server-performed write that **verifies the checksum it was given**.
   *
   * The refusal is the point of implementing this in the fake at all: a copy tool
   * that hashes a file, sends the hash, and is never contradicted has proved
   * nothing about the bytes that arrived. So a mismatch here fails the way the
   * real store fails — `ObjectStorageError`, object not written — and `copy.ts`'s
   * "verified" claim is a claim about a check that can come back negative.
   */
  async putObject(input: PutObjectInput): Promise<ObjectStat> {
    this.assertOpen()
    const parsed = assertKeyBelongsToTenant(input.key, this.tenantId)
    const contentType = assertUploadContentType(
      parsed.objectClass,
      input.contentType,
    )
    const sizeBytes = assertUploadSize(parsed.objectClass, input.body.byteLength)

    const actual = sha256Base64(input.body)
    if (input.checksumSha256 !== undefined && input.checksumSha256 !== actual) {
      throw new ObjectStorageError(
        'OBJECT_STORAGE_CHECKSUM_MISMATCH',
        `The body does not match the declared SHA-256 for ${input.key}`,
      )
    }

    const stored: StoredObject = {
      sizeBytes,
      contentType,
      etag: randomUUID().replace(/-/g, ''),
      // Recorded only when the caller declared one, so the store reports back a
      // checksum it verified rather than one it computed for itself.
      checksumSha256:
        input.checksumSha256 === undefined ? null : sha256Hex(input.body),
    }
    this.objects.set(input.key, stored)
    return this.statOf(input.key, stored)
  }

  /**
   * One page of keys under a prefix, in lexicographic order.
   *
   * Sorted and cursored even though the whole map is in memory, because the
   * property callers depend on is the *paging contract* — a walk that follows
   * `nextCursor` must not skip or repeat — and a fake that answered everything at
   * once would let a broken walk pass.
   */
  async listObjects(input: ListObjectsInput): Promise<ListObjectsPage> {
    this.assertOpen()
    const prefix = assertPrefixBelongsToTenant(input.prefix, this.tenantId)
    const limit = input.limit ?? 1000

    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .filter((key) => input.cursor == null || key > input.cursor)
      .sort()

    const page = keys.slice(0, limit)
    return {
      objects: page.map((key) => {
        const stored = this.objects.get(key) as StoredObject
        return { key, sizeBytes: stored.sizeBytes, etag: stored.etag }
      }),
      nextCursor: keys.length > page.length ? page[page.length - 1] : null,
    }
  }

  private statOf(key: string, stored: StoredObject): ObjectStat {
    return {
      key,
      sizeBytes: stored.sizeBytes,
      contentType: stored.contentType,
      etag: stored.etag,
      checksumSha256: stored.checksumSha256,
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /**
   * Behave like the store when a signed URL is presented.
   *
   * Every refusal here mirrors one the real store makes, and the status codes
   * are the ones S3 and R2 use, so a test asserting on them is asserting on
   * something a browser would actually see.
   */
  deliver(request: DeliveryRequest): DeliveryResult {
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch {
      return { status: 400, reason: 'malformed URL' }
    }

    const token = parsed.searchParams.get('token')
    const grant = token ? this.grants.get(token) : undefined
    if (!grant) return { status: 403, reason: 'no such grant' }

    // Expiry first: an expired URL is refused whatever else is wrong with it.
    if (grant.expiresAtMs <= this.now()) {
      return { status: 403, reason: 'expired' }
    }

    if (grant.method !== request.method) {
      // A GET grant is not a PUT grant. The signature covers the method, so
      // the real store refuses this at verification.
      return { status: 403, reason: 'method not signed' }
    }

    // The key is in the path, but the *grant* is what decides which object is
    // addressed — editing the path invalidates the signature rather than
    // redirecting the grant.
    if (decodeURIComponent(parsed.pathname).replace(/^\//, '') !== grant.key) {
      return { status: 403, reason: 'key not signed' }
    }

    const presented = normalizeHeaders(request.headers ?? {})
    for (const [name, expected] of Object.entries(grant.requiredHeaders)) {
      if (presented[name] !== expected) {
        return {
          status: 403,
          reason: `signed header ${name} missing or altered`,
        }
      }
    }

    if (grant.method === 'GET') {
      return this.objects.has(grant.key)
        ? { status: 200 }
        : { status: 404, reason: 'no such object' }
    }

    // A PUT whose body does not match the signed content-length. The real
    // store rejects this because the length is part of what was signed; this
    // is the case that makes the size limit real rather than advisory.
    const declared = Number(grant.requiredHeaders['content-length'])
    const sent = request.bodyBytes ?? 0
    if (sent !== declared) {
      return { status: 403, reason: 'body length differs from signed length' }
    }

    this.objects.set(grant.key, {
      sizeBytes: sent,
      contentType: grant.requiredHeaders['content-type'],
      etag: randomUUID().replace(/-/g, ''),
      // A signed browser upload declares no checksum — the URL signs the length
      // and the type, not the content — so this object has none to report. That
      // is the case `manifest.ts` calls `checksumUnverified`.
      checksumSha256: null,
    })
    return { status: 200 }
  }

  /** Force the next call to fail the way an unreachable provider would. */
  breakProvider(): void {
    this.closed = true
  }

  private issue(
    key: string,
    method: 'GET' | 'PUT',
    ttlSeconds: number,
    requiredHeaders: Readonly<Record<string, string>>,
  ): SignedObjectUrl {
    const token = randomUUID()
    const expiresAtMs = this.now() + ttlSeconds * 1000
    this.grants.set(token, { key, method, expiresAtMs, requiredHeaders })

    return {
      url: `${FAKE_STORAGE_SCHEME}//fake-bucket/${key}?token=${token}`,
      method,
      expiresAt: new Date(expiresAtMs).toISOString(),
      requiredHeaders,
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ObjectStorageUnavailableError(
        'The object storage provider is closed',
      )
    }
  }
}

function normalizeHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase().trim()] = String(value).trim()
  }
  return normalized
}

/** Re-exported so a caller catching provider failures needs one import. */
export { ObjectStorageError }
