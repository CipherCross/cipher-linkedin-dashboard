/**
 * The signer, graded against AWS's own published worked example.
 *
 * **Why this file exists at all.** `sigv4.ts` is hand-written rather than taken
 * from `@aws-sdk/*`, and the argument for that (see its docblock) rests
 * entirely on the claim that a hand-written signer is *checkable*. This is the
 * check. Without it the module would be an unverifiable guess, and the honest
 * move would have been the dependency.
 *
 * The vector is the presigned-GET example from "Authenticating Requests: Using
 * Query Parameters (AWS Signature Version 4)" — AWS's long-standing
 * documentation example, using its published example credentials. Those
 * credentials are famously fake: `AKIAIOSFODNN7EXAMPLE` appears in AWS's own
 * public documentation and grants nothing. No real credential appears in this
 * repository.
 *
 * A signature is a hash of every input at once, so this single equality covers
 * the canonicalization rules, the query-parameter ordering and encoding, the
 * header normalization, the scope string and the four-step key derivation
 * simultaneously. Any one of them wrong changes all 64 hex characters.
 */

import { describe, expect, it } from 'vitest'

import {
  buildCanonicalRequest,
  deriveSigningKey,
  encodeRfc3986,
  formatAmzDate,
  presignUrl,
  signedHeadersOf,
  SIGV4_ALGORITHM,
} from '../api/_lib/storage/sigv4.js'

/** AWS's published documentation example credentials. Fake by construction. */
const EXAMPLE_CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
} as const

const EXAMPLE_SIGNATURE =
  'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'

describe('SigV4 query-string presigning', () => {
  it("reproduces AWS's published example signature exactly", () => {
    const result = presignUrl({
      method: 'GET',
      origin: 'https://examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      service: 's3',
      credentials: EXAMPLE_CREDENTIALS,
      expiresInSeconds: 86_400,
      signedAt: new Date('2013-05-24T00:00:00Z'),
    })

    expect(result.signature).toBe(EXAMPLE_SIGNATURE)
  })

  it('builds the published canonical request for that example', () => {
    const { canonicalRequest } = buildCanonicalRequest({
      method: 'GET',
      path: '/test.txt',
      query: {
        'X-Amz-Algorithm': SIGV4_ALGORITHM,
        'X-Amz-Credential':
          'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
        'X-Amz-Date': '20130524T000000Z',
        'X-Amz-Expires': '86400',
        'X-Amz-SignedHeaders': 'host',
      },
      headers: { host: 'examplebucket.s3.amazonaws.com' },
    })

    expect(canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
        'host:examplebucket.s3.amazonaws.com',
        '',
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n'),
    )
  })

  it('puts the signature last and leaves the signed parameters in the URL', () => {
    const result = presignUrl({
      method: 'GET',
      origin: 'https://examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      service: 's3',
      credentials: EXAMPLE_CREDENTIALS,
      expiresInSeconds: 86_400,
      signedAt: new Date('2013-05-24T00:00:00Z'),
    })

    const url = new URL(result.url)
    expect(url.searchParams.get('X-Amz-Signature')).toBe(EXAMPLE_SIGNATURE)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('86400')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    // The secret must never appear in a URL; only the access key id does.
    expect(result.url).not.toContain(EXAMPLE_CREDENTIALS.secretAccessKey)
  })

  it('signs extra headers, which is what makes them mandatory at upload time', () => {
    const result = presignUrl({
      method: 'PUT',
      origin: 'https://account.r2.cloudflarestorage.com',
      path: '/bucket/t/tenant/lead-photos/a.jpg',
      region: 'auto',
      service: 's3',
      credentials: EXAMPLE_CREDENTIALS,
      expiresInSeconds: 300,
      signedAt: new Date('2026-08-06T12:00:00Z'),
      headers: { 'content-type': 'image/jpeg', 'content-length': '1024' },
    })

    const signedHeaders = new URL(result.url).searchParams.get(
      'X-Amz-SignedHeaders',
    )
    // Sorted, lowercased, semicolon-joined — and `host` is always present.
    expect(signedHeaders).toBe('content-length;content-type;host')
  })

  /**
   * Added because a mutation that removed the sort reddened nothing: every
   * parameter `presignUrl` adds happens to be inserted in alphabetical order
   * already, so the sort was a no-op on the only inputs under test. A caller
   * passing a response-header override would have been the first to find out.
   */
  it('sorts canonical query parameters regardless of insertion order', () => {
    const { canonicalRequest } = buildCanonicalRequest({
      method: 'GET',
      path: '/test.txt',
      query: {
        'X-Amz-SignedHeaders': 'host',
        'response-content-disposition': 'inline',
        'X-Amz-Algorithm': SIGV4_ALGORITHM,
      },
      headers: { host: 'example.com' },
    })

    expect(canonicalRequest.split('\n')[2]).toBe(
      'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-SignedHeaders=host&' +
        'response-content-disposition=inline',
    )
  })

  it('advertises exactly the header list it signed', () => {
    // These were two separate computations until a mutation showed they could
    // disagree without any test noticing; `signedHeadersOf` is now the only one.
    const headers = { host: 'example.com', 'Content-Type': 'image/png' }
    const { signedHeaders } = buildCanonicalRequest({
      method: 'PUT',
      path: '/a.png',
      query: {},
      headers,
    })
    expect(signedHeaders).toBe(signedHeadersOf(headers))
    expect(signedHeaders).toBe('content-type;host')
  })

  it('encodes the characters encodeURIComponent leaves behind', () => {
    // These five are the entire difference between encodeURIComponent and
    // RFC 3986, and a single one of them unescaped breaks only the objects
    // whose names contain it.
    expect(encodeRfc3986("!'()*")).toBe('%21%27%28%29%2A')
    expect(encodeRfc3986('a/b')).toBe('a%2Fb')
    expect(encodeRfc3986('-_.~')).toBe('-_.~')
  })

  it('formats the timestamp the way the scope string requires', () => {
    expect(formatAmzDate(new Date('2013-05-24T00:00:00.123Z'))).toEqual({
      amzDate: '20130524T000000Z',
      dateStamp: '20130524',
    })
  })

  it('derives a key that changes with every scope dimension', () => {
    const base = {
      secretAccessKey: EXAMPLE_CREDENTIALS.secretAccessKey,
      dateStamp: '20130524',
      region: 'us-east-1',
      service: 's3',
    }
    const key = deriveSigningKey(base).toString('hex')

    // A signature is bound to its date, region and service; if any of these
    // produced the same key, a leaked one would travel further than its scope.
    expect(deriveSigningKey({ ...base, dateStamp: '20130525' }).toString('hex')).not.toBe(key)
    expect(deriveSigningKey({ ...base, region: 'auto' }).toString('hex')).not.toBe(key)
    expect(deriveSigningKey({ ...base, service: 'sqs' }).toString('hex')).not.toBe(key)
  })
})
