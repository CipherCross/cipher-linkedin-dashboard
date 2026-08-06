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

import { assertKeyBelongsToTenant } from './keys.js'
import {
  assertSignedUrlTtl,
  assertUploadContentType,
  assertUploadSize,
} from './policy.js'
import {
  ObjectStorageError,
  ObjectStorageUnavailableError,
  type ObjectStat,
  type ObjectStorageProvider,
  type PresignGetInput,
  type PresignPutInput,
  type SignedObjectUrl,
} from './provider.js'

/** Scheme for URLs this fake issues. Not fetchable, and meant not to be. */
export const FAKE_STORAGE_SCHEME = 'memory:'

interface StoredObject {
  readonly sizeBytes: number
  readonly contentType: string
  readonly etag: string
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
  }): void {
    assertKeyBelongsToTenant(input.key, this.tenantId)
    this.objects.set(input.key, {
      sizeBytes: input.sizeBytes,
      contentType: input.contentType,
      etag: randomUUID().replace(/-/g, ''),
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
    return {
      key,
      sizeBytes: stored.sizeBytes,
      contentType: stored.contentType,
      etag: stored.etag,
    }
  }

  async deleteObject(key: string): Promise<void> {
    this.assertOpen()
    assertKeyBelongsToTenant(key, this.tenantId)
    // Idempotent, like the real thing: no complaint when it was already gone.
    this.objects.delete(key)
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
