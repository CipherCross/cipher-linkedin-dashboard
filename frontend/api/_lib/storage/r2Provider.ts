/**
 * The Cloudflare R2 adapter — the only file in this layer that knows which
 * provider was selected.
 *
 * R2 is reached through its S3-compatible API, so everything here is ordinary
 * S3: SigV4 query signing, path-style addressing, `auto` as the region. That is
 * why G0 could keep AWS S3 as the portable fallback without a second adapter —
 * swapping providers is an endpoint and a credential, not a rewrite.
 *
 * ## Server-performed operations, and why they still go through a signed URL
 *
 * `statObject` and `deleteObject` are not signable by policy: no browser should
 * ever hold a capability to stat or destroy an object. But the *server* still
 * has to make the request, and it has two ways to authenticate one — a signed
 * `Authorization` header, or a presigned URL it consumes itself. This uses the
 * second, deliberately:
 *
 * - It keeps exactly one signing path in the codebase. Header signing differs
 *   from query signing in the payload hash and the header set, so implementing
 *   both would double the surface that the known-answer test covers only half
 *   of.
 * - The URL is minted with a 30-second life inside one function invocation and
 *   is never returned, logged or serialized. `presignInternal` is private and
 *   its result is consumed on the next line.
 *
 * The distinction the policy cares about is who *holds* a capability, not which
 * HTTP mechanism carried it.
 *
 * ## What is unproven here, and stays unproven until S20
 *
 * S19 may not create an R2 bucket, token or credential file, so nothing in this
 * file has ever spoken to R2. What *is* proved offline: the signature bytes
 * (against AWS's published vector), the key refusals, the policy refusals, and
 * this adapter's response handling (against an injected `fetch`). What is not:
 * that R2 accepts these URLs. That is the first thing S20 must do once the
 * owner opens the bucket gate, and it is recorded as a known limit rather than
 * implied to be done.
 */

import { assertKeyBelongsToTenant } from './keys.js'
import {
  assertSignedUrlTtl,
  assertUploadContentType,
  assertUploadSize,
  INTERNAL_OPERATION_TTL_SECONDS,
} from './policy.js'
import {
  ObjectStorageUnavailableError,
  type ObjectStat,
  type ObjectStorageProvider,
  type PresignGetInput,
  type PresignPutInput,
  type SignedObjectUrl,
} from './provider.js'
import { presignUrl, type SignedMethod, type Sigv4Credentials } from './sigv4.js'

/** R2 has no regions in the S3 sense and requires this literal. */
export const R2_DEFAULT_REGION = 'auto'

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>

export interface R2ObjectStorageOptions {
  readonly tenantId: string
  readonly bucket: string
  /** Endpoint origin, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string
  readonly region?: string
  readonly credentials: Sigv4Credentials
  /** Injectable so the adapter's response handling is testable offline. */
  readonly fetchImpl?: FetchLike
  readonly now?: () => number
}

export class R2ObjectStorageProvider implements ObjectStorageProvider {
  readonly name = 'cloudflare-r2'
  readonly tenantId: string

  private readonly bucket: string
  private readonly endpoint: string
  private readonly region: string
  private readonly credentials: Sigv4Credentials
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private closed = false

  constructor(options: R2ObjectStorageOptions) {
    this.tenantId = options.tenantId
    this.bucket = options.bucket
    this.endpoint = options.endpoint
    this.region = options.region ?? R2_DEFAULT_REGION
    this.credentials = options.credentials
    this.fetchImpl =
      options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.now = options.now ?? (() => Date.now())
  }

  async presignGet(input: PresignGetInput): Promise<SignedObjectUrl> {
    this.assertOpen()
    assertKeyBelongsToTenant(input.key, this.tenantId)
    const ttlSeconds = assertSignedUrlTtl('get', input.ttlSeconds)

    const signedAt = new Date(this.now())
    const { url } = presignUrl({
      method: 'GET',
      origin: this.endpoint,
      path: this.pathFor(input.key),
      region: this.region,
      service: 's3',
      credentials: this.credentials,
      expiresInSeconds: ttlSeconds,
      signedAt,
    })

    return {
      url,
      method: 'GET',
      expiresAt: new Date(signedAt.getTime() + ttlSeconds * 1000).toISOString(),
      requiredHeaders: {},
    }
  }

  async presignPut(input: PresignPutInput): Promise<SignedObjectUrl> {
    this.assertOpen()
    const parsed = assertKeyBelongsToTenant(input.key, this.tenantId)
    const ttlSeconds = assertSignedUrlTtl('put', input.ttlSeconds)
    const contentType = assertUploadContentType(
      parsed.objectClass,
      input.contentType,
    )
    const contentLength = assertUploadSize(
      parsed.objectClass,
      input.contentLength,
    )

    // Signing these two makes them mandatory and exact at upload time, which is
    // the only thing that bounds the upload — see `policy.ts`.
    const requiredHeaders = {
      'content-type': contentType,
      'content-length': String(contentLength),
    }

    const signedAt = new Date(this.now())
    const { url } = presignUrl({
      method: 'PUT',
      origin: this.endpoint,
      path: this.pathFor(input.key),
      region: this.region,
      service: 's3',
      credentials: this.credentials,
      expiresInSeconds: ttlSeconds,
      signedAt,
      headers: requiredHeaders,
    })

    return {
      url,
      method: 'PUT',
      expiresAt: new Date(signedAt.getTime() + ttlSeconds * 1000).toISOString(),
      requiredHeaders,
    }
  }

  async statObject(key: string): Promise<ObjectStat | null> {
    this.assertOpen()
    assertKeyBelongsToTenant(key, this.tenantId)

    const response = await this.send('HEAD', key)

    // 404 is an ordinary answer; anything else unexpected is an outage, and the
    // two must not collapse into each other. A reconciliation pass that read an
    // outage as "absent" would conclude the bucket had been emptied.
    if (response.status === 404) return null
    if (response.status !== 200) {
      throw new ObjectStorageUnavailableError(
        `Object stat failed with status ${response.status}`,
      )
    }

    const length = Number(response.headers.get('content-length'))
    return {
      key,
      sizeBytes: Number.isFinite(length) ? length : 0,
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag'),
    }
  }

  async deleteObject(key: string): Promise<void> {
    this.assertOpen()
    assertKeyBelongsToTenant(key, this.tenantId)

    const response = await this.send('DELETE', key)

    // 204 is the documented success. 200 and 404 are accepted as success too:
    // the operation is idempotent and the caller was told it cannot learn
    // whether the object had been there.
    if (![200, 204, 404].includes(response.status)) {
      throw new ObjectStorageUnavailableError(
        `Object delete failed with status ${response.status}`,
      )
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /** Path-style addressing: the bucket is a path segment, not a subdomain. */
  private pathFor(key: string): string {
    return `/${this.bucket}/${key}`
  }

  /**
   * Sign a short-lived URL and consume it here. Private, and its URL never
   * leaves this method — that containment is what keeps `head` and `delete`
   * server-only in practice and not just in the type.
   */
  private async send(
    method: Extract<SignedMethod, 'HEAD' | 'DELETE'>,
    key: string,
  ): Promise<{ status: number; headers: { get(name: string): string | null } }> {
    const { url } = presignUrl({
      method,
      origin: this.endpoint,
      path: this.pathFor(key),
      region: this.region,
      service: 's3',
      credentials: this.credentials,
      expiresInSeconds: INTERNAL_OPERATION_TTL_SECONDS,
      signedAt: new Date(this.now()),
    })

    try {
      return await this.fetchImpl(url, { method })
    } catch (cause) {
      // The URL is never included in the message: it is a bearer token, and an
      // error message is the most likely thing in this file to reach a log.
      throw new ObjectStorageUnavailableError(
        `Object storage ${method} could not be completed: ` +
          `${cause instanceof Error ? cause.message : 'unknown error'}`,
      )
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
