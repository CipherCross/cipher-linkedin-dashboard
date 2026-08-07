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

import { assertKeyBelongsToTenant, assertPrefixBelongsToTenant } from './keys.js'
import {
  assertSignedUrlTtl,
  assertUploadContentType,
  assertUploadSize,
  INTERNAL_OPERATION_TTL_SECONDS,
} from './policy.js'
import {
  ObjectStorageError,
  ObjectStorageUnavailableError,
  type ListObjectsInput,
  type ListObjectsPage,
  type ListedObject,
  type ObjectStat,
  type ObjectStorageProvider,
  type PresignGetInput,
  type PresignPutInput,
  type PutObjectInput,
  type SignedObjectUrl,
} from './provider.js'
import { presignUrl, type SignedMethod, type Sigv4Credentials } from './sigv4.js'

/** R2 has no regions in the S3 sense and requires this literal. */
export const R2_DEFAULT_REGION = 'auto'

/**
 * The header that turns a checksum into a *verified* one.
 *
 * Sent on PutObject with a base64 SHA-256; the store recomputes the hash over the
 * body it received and refuses the write on a mismatch. It is a **signed** header,
 * so it is also mandatory and exact — a proxy that stripped it would break the
 * signature rather than silently disabling the check.
 */
export const CHECKSUM_HEADER = 'x-amz-checksum-sha256'

/**
 * S3 returns a stored checksum from HEAD/GET only when this asks for it.
 *
 * Whether R2 honours it is **unproven** — nothing in this repository has spoken to
 * R2 (see the header). `statObject` therefore treats an absent checksum as
 * `null` rather than as an error, and `manifest.ts` has a distinct
 * `checksumUnverified` status for a reconciliation run where every object comes
 * back that way. That is the difference between a tool that degrades to a weaker
 * claim and one that reports green after comparing nothing.
 */
export const CHECKSUM_MODE_HEADER = 'x-amz-checksum-mode'

export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: Uint8Array
  },
) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  text?: () => Promise<string>
}>

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

    const response = await this.send('HEAD', key, {
      headers: { [CHECKSUM_MODE_HEADER]: 'ENABLED' },
    })

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
      // Base64 on the wire, hex in a manifest. Converted here rather than at the
      // caller so exactly one encoding crosses this boundary.
      checksumSha256: base64ChecksumToHex(response.headers.get(CHECKSUM_HEADER)),
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

  /**
   * Write bytes with the store verifying the hash.
   *
   * The upload is signed the same way everything else here is — a presigned URL
   * consumed inside this method — with two headers signed alongside `host`:
   * `content-type`, for the reason `policy.ts` gives, and the SHA-256, which is
   * what makes the write verified rather than hopeful. A `content-length` header
   * is deliberately *not* signed here: unlike a browser upload, this process holds
   * the whole body and `fetch` sets the length itself, so signing it would add a
   * value that has to agree with one we already control and can therefore only be
   * a source of disagreement.
   */
  async putObject(input: PutObjectInput): Promise<ObjectStat> {
    this.assertOpen()
    const parsed = assertKeyBelongsToTenant(input.key, this.tenantId)
    const contentType = assertUploadContentType(
      parsed.objectClass,
      input.contentType,
    )
    const sizeBytes = assertUploadSize(parsed.objectClass, input.body.byteLength)

    const headers: Record<string, string> = { 'content-type': contentType }
    if (input.checksumSha256 !== undefined) {
      headers[CHECKSUM_HEADER] = input.checksumSha256
    }

    const response = await this.send('PUT', input.key, {
      headers,
      body: input.body,
    })

    // A checksum failure is the store telling us the bytes are wrong, and it is
    // not an outage — retrying would send the same bad body. S3 answers 400 with
    // `BadDigest`; the status alone is enough to keep the two apart.
    if (response.status === 400) {
      throw new ObjectStorageError(
        'OBJECT_STORAGE_CHECKSUM_MISMATCH',
        `The store refused the body written to ${input.key} as malformed or ` +
          `not matching its declared checksum`,
      )
    }
    if (response.status !== 200 && response.status !== 204) {
      throw new ObjectStorageUnavailableError(
        `Object write failed with status ${response.status}`,
      )
    }

    return {
      key: input.key,
      sizeBytes,
      contentType,
      etag: response.headers.get('etag'),
      // What the store *reports*, not what we sent: a caller comparing its own
      // hash against this is comparing against the store's answer, which is the
      // only comparison worth making.
      checksumSha256: base64ChecksumToHex(response.headers.get(CHECKSUM_HEADER)),
    }
  }

  /**
   * `ListObjectsV2`, one page.
   *
   * Two request details are load-bearing rather than incidental:
   *
   * - **`encoding-type=url`.** Object keys travel inside XML, and a key
   *   containing a character XML must escape would otherwise have to be un-escaped
   *   by this parser. Asking the store to percent-encode the keys means the only
   *   decoding step is `decodeURIComponent`, which is a function rather than a
   *   guess. The current key grammar makes this moot; the parser should not depend
   *   on that staying true.
   * - **The cursor is the store's `NextContinuationToken`**, opaque and passed
   *   back verbatim. Deriving a cursor from the last key would look equivalent and
   *   is not: `StartAfter` and a continuation token differ where a page boundary
   *   falls inside a set of keys sharing a prefix.
   */
  async listObjects(input: ListObjectsInput): Promise<ListObjectsPage> {
    this.assertOpen()
    const prefix = assertPrefixBelongsToTenant(input.prefix, this.tenantId)

    const query: Record<string, string> = {
      'list-type': '2',
      prefix,
      'encoding-type': 'url',
      'max-keys': String(input.limit ?? 1000),
    }
    if (input.cursor != null && input.cursor !== '') {
      query['continuation-token'] = input.cursor
    }

    const { url } = presignUrl({
      method: 'GET',
      origin: this.endpoint,
      // The bucket itself, not an object: a listing addresses the container.
      path: `/${this.bucket}`,
      region: this.region,
      service: 's3',
      credentials: this.credentials,
      expiresInSeconds: INTERNAL_OPERATION_TTL_SECONDS,
      signedAt: new Date(this.now()),
      query,
    })

    let response
    try {
      response = await this.fetchImpl(url, { method: 'GET' })
    } catch (cause) {
      throw new ObjectStorageUnavailableError(
        `Object listing could not be completed: ` +
          `${cause instanceof Error ? cause.message : 'unknown error'}`,
      )
    }
    if (response.status !== 200 || typeof response.text !== 'function') {
      throw new ObjectStorageUnavailableError(
        `Object listing failed with status ${response.status}`,
      )
    }

    return parseListObjectsV2(await response.text())
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
    method: Extract<SignedMethod, 'HEAD' | 'DELETE' | 'PUT'>,
    key: string,
    options: {
      readonly headers?: Record<string, string>
      readonly body?: Uint8Array
    } = {},
  ): Promise<{
    status: number
    headers: { get(name: string): string | null }
    text?: () => Promise<string>
  }> {
    const { url } = presignUrl({
      method,
      origin: this.endpoint,
      path: this.pathFor(key),
      region: this.region,
      service: 's3',
      credentials: this.credentials,
      expiresInSeconds: INTERNAL_OPERATION_TTL_SECONDS,
      signedAt: new Date(this.now()),
      headers: options.headers,
    })

    try {
      // The headers are passed as well as signed. Signing puts their names in
      // `X-Amz-SignedHeaders`; the request still has to carry the values, and a
      // signed header that is not sent fails verification rather than being
      // treated as absent.
      return await this.fetchImpl(url, {
        method,
        headers: options.headers,
        body: options.body,
      })
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

/** Base64 SHA-256 as a store reports it → the lowercase hex a manifest holds. */
export function base64ChecksumToHex(value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  const bytes = Buffer.from(value, 'base64')
  // 32 bytes or it is not a SHA-256, whatever the header claimed. A store that
  // answered with a CRC32 must produce `null` here rather than a short "hex
  // digest" that would then fail every comparison as a mismatch.
  if (bytes.byteLength !== 32) return null
  return bytes.toString('hex')
}

/**
 * Parse a `ListObjectsV2` response.
 *
 * Written against the response's documented element names rather than with an XML
 * dependency, and the scope of that decision is worth being explicit about: this
 * reads four elements out of a machine-generated document whose shape is part of
 * the S3 API. It is not a general XML parser and must not become one — a listing
 * that stops matching this is a provider change, which is a thing to notice.
 *
 * `IsTruncated` is not consulted. The presence of a `NextContinuationToken` is
 * what decides whether there is another page: a truncated listing always carries
 * one, and treating the token as the authority means a walk cannot loop on a
 * response that claims truncation without saying where to resume.
 */
export function parseListObjectsV2(xml: string): ListObjectsPage {
  const objects: ListedObject[] = []

  for (const [, contents] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const rawKey = firstTag(contents, 'Key')
    if (rawKey === null) continue
    const size = Number(firstTag(contents, 'Size') ?? '0')
    objects.push({
      // `encoding-type=url` was requested, so the key arrives percent-encoded.
      key: decodeURIComponent(rawKey),
      sizeBytes: Number.isFinite(size) ? size : 0,
      etag: decodeXmlEntities(firstTag(contents, 'ETag')),
    })
  }

  const token = firstTag(xml, 'NextContinuationToken')
  return {
    objects,
    nextCursor: token === null ? null : decodeXmlEntities(token),
  }
}

function firstTag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return match === null ? null : match[1]
}

function decodeXmlEntities(value: string | null): string | null {
  if (value === null) return null
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Last, so a literal `&amp;lt;` decodes to `&lt;` rather than to `<`.
    .replace(/&amp;/g, '&')
}
