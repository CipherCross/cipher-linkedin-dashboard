/**
 * AWS Signature Version 4, query-string ("presigned URL") flavour.
 *
 * **Why this is ~150 lines here instead of a dependency.** The obvious
 * alternative is `@aws-sdk/client-s3` plus `@aws-sdk/s3-request-presigner`.
 * It was rejected on a reason that is specific to this slice rather than on a
 * general preference for writing things twice:
 *
 * - The SDK would not buy *verification*. S19 may not create an R2 bucket, a
 *   token or a credential file, so no adapter written here can be pointed at a
 *   real endpoint either way. What can be checked offline is whether the bytes
 *   we sign match the algorithm — and that is checkable precisely because SigV4
 *   is a published, deterministic function with a published worked example.
 *   `tests/objectStorageSigv4.test.ts` reproduces AWS's own example signature
 *   `aeeed9bb…d404` from its own example credentials. An SDK call with fake
 *   credentials would have produced a URL no test could grade.
 * - Portability is a stated G0 property: AWS S3 is the retained fallback behind
 *   `ObjectStorageProvider`, and R2 and S3 take the *same* signature. One signer
 *   serves both, so this is not R2-specific code.
 * - These functions run inside a Vercel serverless function whose cold start is
 *   on the request path for a lead photo.
 *
 * The trade is recorded honestly in the handoff: a hand-written signer is a
 * thing that can be wrong. What makes it acceptable is that it is wrong
 * *loudly* — a canonicalization mistake changes the signature completely, and
 * the known-answer test would go red rather than dim.
 *
 * **Scope.** Query-string signing only. Header-based (`Authorization:`) signing
 * is not implemented because nothing here needs it: the adapter performs its own
 * server-side operations by presigning with a very short expiry and fetching the
 * result, which keeps one code path signed rather than two.
 */

import { createHash, createHmac } from 'node:crypto'

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256'

/**
 * What a presigned request signs in place of a body digest.
 *
 * A presigned URL is generated before the body exists — often by a different
 * process than the one that will send it — so the payload cannot be hashed.
 * S3 and R2 both accept this literal in that position.
 */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

export type SignedMethod = 'GET' | 'PUT' | 'HEAD' | 'DELETE'

export interface Sigv4Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

export interface PresignInput {
  readonly method: SignedMethod
  /** Endpoint origin, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  readonly origin: string
  /**
   * The *decoded* request path, including any bucket segment for path-style
   * addressing: `/my-bucket/t/<tenant>/lead-photos/x.jpg`. Each segment is
   * encoded here exactly once; passing a pre-encoded path would double-encode
   * it and produce a signature for a different object than the one requested.
   */
  readonly path: string
  readonly region: string
  readonly service: string
  readonly credentials: Sigv4Credentials
  readonly expiresInSeconds: number
  readonly signedAt: Date
  /**
   * Headers to sign beyond `host`.
   *
   * Signing a header makes it *mandatory and exact*: the request is rejected
   * unless it arrives carrying that header with that value. That property is
   * the whole mechanism behind the content-type and size limits in
   * `policy.ts` — see `r2Provider.ts`.
   */
  readonly headers?: Readonly<Record<string, string>>
  /** Extra query parameters to sign, e.g. a response-header override. */
  readonly query?: Readonly<Record<string, string>>
}

export interface PresignResult {
  readonly url: string
  readonly signature: string
  /** Exposed so the known-answer test can grade the intermediate steps. */
  readonly canonicalRequest: string
  readonly stringToSign: string
}

/**
 * RFC 3986 percent-encoding.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped, and AWS requires them escaped.
 * A single unescaped `(` in a filename would shift the canonical request and
 * break every signature for that object only — the kind of defect that passes
 * every test written against ASCII-safe fixtures.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * Encode a path for the canonical request: each segment encoded, separators
 * left alone. A `/` inside an object key would therefore become a separator —
 * which is why `keys.ts` builds keys out of validated segments rather than
 * accepting arbitrary strings.
 */
export function encodeCanonicalPath(path: string): string {
  return path.split('/').map(encodeRfc3986).join('/')
}

/** `20130524T000000Z` and its `20130524` date stamp. */
export function formatAmzDate(instant: Date): {
  readonly amzDate: string
  readonly dateStamp: string
} {
  const amzDate = instant.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

function canonicalQueryString(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(params[name])}`)
    .join('&')
}

/**
 * The lowercased, sorted header names — the single source for both the
 * `SignedHeaders` line of the canonical request and the `X-Amz-SignedHeaders`
 * query parameter.
 *
 * It is one function because it was briefly two. A mutation that unsorted one
 * copy left the other sorted, so the URL advertised one header order while the
 * signature covered another — a request that fails only at the store, and that
 * no test here caught. Two computations that must agree are a defect waiting
 * for the day they stop agreeing; one computation cannot disagree with itself.
 */
function sortedHeaderNames(
  headers: Readonly<Record<string, string>>,
): readonly string[] {
  return [
    ...new Set(Object.keys(headers).map((name) => name.toLowerCase().trim())),
  ].sort()
}

export function signedHeadersOf(
  headers: Readonly<Record<string, string>>,
): string {
  return sortedHeaderNames(headers).join(';')
}

export function buildCanonicalRequest(input: {
  readonly method: SignedMethod
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string>>
}): { readonly canonicalRequest: string; readonly signedHeaders: string } {
  // Header names are compared lowercased and values are trimmed; anything else
  // signs bytes the server will not reconstruct.
  const normalized = new Map<string, string>()
  for (const [name, value] of Object.entries(input.headers)) {
    normalized.set(name.toLowerCase().trim(), String(value).trim())
  }

  const names = sortedHeaderNames(input.headers)
  const canonicalHeaders = names
    .map((name) => `${name}:${normalized.get(name)}\n`)
    .join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [
    input.method,
    encodeCanonicalPath(input.path),
    canonicalQueryString(input.query),
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n')

  return { canonicalRequest, signedHeaders }
}

export function buildStringToSign(input: {
  readonly amzDate: string
  readonly scope: string
  readonly canonicalRequest: string
}): string {
  return [
    SIGV4_ALGORITHM,
    input.amzDate,
    input.scope,
    createHash('sha256').update(input.canonicalRequest, 'utf8').digest('hex'),
  ].join('\n')
}

/**
 * The four-step signing key derivation. Each step narrows the key by one
 * dimension, which is what makes a leaked signature useless outside its date,
 * region and service.
 */
export function deriveSigningKey(input: {
  readonly secretAccessKey: string
  readonly dateStamp: string
  readonly region: string
  readonly service: string
}): Buffer {
  const kDate = createHmac('sha256', `AWS4${input.secretAccessKey}`)
    .update(input.dateStamp, 'utf8')
    .digest()
  const kRegion = createHmac('sha256', kDate).update(input.region, 'utf8').digest()
  const kService = createHmac('sha256', kRegion).update(input.service, 'utf8').digest()
  return createHmac('sha256', kService).update('aws4_request', 'utf8').digest()
}

export function presignUrl(input: PresignInput): PresignResult {
  const { amzDate, dateStamp } = formatAmzDate(input.signedAt)
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`

  const origin = new URL(input.origin)
  // `URL.host` keeps a non-default port, which the signature must include
  // because the server reconstructs the Host header it actually received.
  const headers: Record<string, string> = { host: origin.host, ...(input.headers ?? {}) }

  // Built once and used for both the canonical request and the returned URL.
  // Two copies of this object is the same trap as two copies of the signed
  // header list: they drift, and the result is a URL whose parameters disagree
  // with what was signed — which fails at the store and nowhere earlier.
  const query: Record<string, string> = {
    ...(input.query ?? {}),
    'X-Amz-Algorithm': SIGV4_ALGORITHM,
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeadersOf(headers),
  }

  const { canonicalRequest } = buildCanonicalRequest({
    method: input.method,
    path: input.path,
    query,
    headers,
  })

  const stringToSign = buildStringToSign({ amzDate, scope, canonicalRequest })
  const signature = createHmac(
    'sha256',
    deriveSigningKey({
      secretAccessKey: input.credentials.secretAccessKey,
      dateStamp,
      region: input.region,
      service: input.service,
    }),
  )
    .update(stringToSign, 'utf8')
    .digest('hex')

  return {
    url:
      `${origin.origin}${encodeCanonicalPath(input.path)}` +
      `?${canonicalQueryString(query)}&X-Amz-Signature=${signature}`,
    signature,
    canonicalRequest,
    stringToSign,
  }
}
