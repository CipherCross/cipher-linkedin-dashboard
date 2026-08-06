/**
 * The signed-operation policy and the configuration reader.
 *
 * These are the three limits S19 exists to impose — expiry, type and size —
 * plus the environment refusals that keep a storage credential off the browser.
 * They are tested as pure functions here and as *behaviour* in
 * `objectStorageProvider.test.ts`; both halves matter, because a limit that is
 * computed correctly and then not applied is the failure mode this chain has
 * already met twice (N-ROSTER mutations 9 and 10).
 */

import { describe, expect, it } from 'vitest'

import {
  assertSignedUrlTtl,
  assertUploadContentType,
  assertUploadSize,
  MAX_GET_TTL_SECONDS,
  MAX_PUT_TTL_SECONDS,
  MIN_SIGNED_URL_TTL_SECONDS,
  OBJECT_CLASS_POLICIES,
  ObjectStoragePolicyError,
  SERVER_ONLY_OPERATIONS,
  SIGNABLE_OPERATIONS,
} from '../api/_lib/storage/policy.js'
import {
  ObjectStorageConfigurationError,
  readObjectStorageConfig,
} from '../api/_lib/storage/config.js'

describe('which operations may be signed at all', () => {
  it('offers only get and put to a client', () => {
    expect([...SIGNABLE_OPERATIONS]).toEqual(['get', 'put'])
  })

  /**
   * The security decision this layer turns on. R2 can presign a DELETE
   * perfectly well; handing one to a browser would be a durable, unrevocable
   * capability to destroy a tenant's objects, in exchange for nothing the
   * server cannot do itself.
   */
  it('keeps head and delete server-performed', () => {
    expect([...SERVER_ONLY_OPERATIONS]).toEqual(['head', 'delete'])
    for (const operation of SERVER_ONLY_OPERATIONS) {
      expect(SIGNABLE_OPERATIONS).not.toContain(operation as never)
    }
  })
})

describe('URL expiry', () => {
  it('accepts a lifetime inside the bounds', () => {
    expect(assertSignedUrlTtl('get', 300)).toBe(300)
    expect(assertSignedUrlTtl('put', 60)).toBe(60)
  })

  it('refuses a lifetime under the floor', () => {
    expect(() =>
      assertSignedUrlTtl('get', MIN_SIGNED_URL_TTL_SECONDS - 1),
    ).toThrow(ObjectStoragePolicyError)
  })

  it('refuses a lifetime over the ceiling, per operation', () => {
    expect(() => assertSignedUrlTtl('get', MAX_GET_TTL_SECONDS + 1)).toThrow(
      ObjectStoragePolicyError,
    )
    expect(() => assertSignedUrlTtl('put', MAX_PUT_TTL_SECONDS + 1)).toThrow(
      ObjectStoragePolicyError,
    )
  })

  it('holds uploads to a shorter ceiling than reads', () => {
    // Ten minutes is a fine life for an <img> URL and too long for an upload
    // the user is actively waiting on.
    const tenMinutes = 10 * 60
    expect(assertSignedUrlTtl('get', tenMinutes)).toBe(tenMinutes)
    expect(() => assertSignedUrlTtl('put', tenMinutes)).toThrow(
      ObjectStoragePolicyError,
    )
  })

  it('refuses rather than clamping an out-of-range lifetime', () => {
    // The distinction is the point: a clamp would hand back a URL that expires
    // long before the caller believes, which fails intermittently in
    // production and gets diagnosed as anything but a TTL.
    expect(() => assertSignedUrlTtl('get', 24 * 60 * 60)).toThrow(
      /is not clamped/,
    )
  })

  it('refuses a non-integer lifetime', () => {
    expect(() => assertSignedUrlTtl('get', 60.5)).toThrow(
      ObjectStoragePolicyError,
    )
    expect(() => assertSignedUrlTtl('get', Number.NaN)).toThrow(
      ObjectStoragePolicyError,
    )
  })
})

describe('upload content type', () => {
  it('accepts every allowed image type', () => {
    for (const type of OBJECT_CLASS_POLICIES['lead-photos'].contentTypes) {
      expect(assertUploadContentType('lead-photos', type)).toBe(type)
    }
  })

  /**
   * SVG is a script container. An avatar is rendered against every team
   * member's session, so a stored SVG is a stored cross-site script — this is
   * the one exclusion in the allowlist that must never be relaxed for
   * convenience.
   */
  it('refuses SVG', () => {
    expect(() => assertUploadContentType('lead-photos', 'image/svg+xml')).toThrow(
      ObjectStoragePolicyError,
    )
  })

  it('refuses text/html under an image key', () => {
    expect(() => assertUploadContentType('lead-photos', 'text/html')).toThrow(
      ObjectStoragePolicyError,
    )
  })

  it('compares exactly, not by prefix', () => {
    // Both of these start with an allowed value, and the signed header has to
    // be the exact string anyway.
    expect(() => assertUploadContentType('lead-photos', 'image/png-evil')).toThrow(
      ObjectStoragePolicyError,
    )
    expect(() =>
      assertUploadContentType('lead-photos', 'image/png; charset=utf-8'),
    ).toThrow(ObjectStoragePolicyError)
  })

  it('refuses a missing or non-string type', () => {
    expect(() => assertUploadContentType('lead-photos', undefined)).toThrow(
      ObjectStoragePolicyError,
    )
    expect(() => assertUploadContentType('lead-photos', 42)).toThrow(
      ObjectStoragePolicyError,
    )
  })
})

describe('upload size', () => {
  const MAX = OBJECT_CLASS_POLICIES['lead-photos'].maxBytes

  it('accepts a size up to and including the limit', () => {
    expect(assertUploadSize('lead-photos', 1)).toBe(1)
    expect(assertUploadSize('lead-photos', MAX)).toBe(MAX)
  })

  it('refuses a size over the limit', () => {
    expect(() => assertUploadSize('lead-photos', MAX + 1)).toThrow(
      ObjectStoragePolicyError,
    )
  })

  it('refuses a zero or negative size', () => {
    expect(() => assertUploadSize('lead-photos', 0)).toThrow(
      ObjectStoragePolicyError,
    )
    expect(() => assertUploadSize('lead-photos', -1)).toThrow(
      ObjectStoragePolicyError,
    )
  })

  it('refuses an absent or non-integer size', () => {
    // The byte count is signed into the URL, so it has to be an exact integer
    // rather than something the caller may omit.
    expect(() => assertUploadSize('lead-photos', undefined)).toThrow(
      ObjectStoragePolicyError,
    )
    expect(() => assertUploadSize('lead-photos', 1.5)).toThrow(
      ObjectStoragePolicyError,
    )
    expect(() => assertUploadSize('lead-photos', '1024')).toThrow(
      ObjectStoragePolicyError,
    )
  })
})

describe('reading the storage configuration', () => {
  const VALID = {
    OBJECT_STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    OBJECT_STORAGE_BUCKET: 'tenant-acme',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'access-key-id-value',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret-access-key-value',
  } as const

  it('reads a complete configuration and defaults the region', () => {
    const config = readObjectStorageConfig(VALID)
    expect(config.endpoint).toBe('https://account.r2.cloudflarestorage.com')
    expect(config.bucket).toBe('tenant-acme')
    // R2 has no regions in the S3 sense; `auto` is the literal it requires.
    expect(config.region).toBe('auto')
    expect(config.credentials.accessKeyId).toBe('access-key-id-value')
  })

  it('honours an explicit region, which is what the S3 fallback needs', () => {
    expect(
      readObjectStorageConfig({ ...VALID, OBJECT_STORAGE_REGION: 'eu-central-1' })
        .region,
    ).toBe('eu-central-1')
  })

  for (const name of Object.keys(VALID)) {
    it(`refuses to resolve without ${name}`, () => {
      const env: Record<string, string | undefined> = { ...VALID }
      delete env[name]
      expect(() => readObjectStorageConfig(env)).toThrow(
        ObjectStorageConfigurationError,
      )
    })
  }

  it('refuses a plaintext endpoint', () => {
    expect(() =>
      readObjectStorageConfig({
        ...VALID,
        OBJECT_STORAGE_ENDPOINT: 'http://account.r2.cloudflarestorage.com',
      }),
    ).toThrow(/bearer token/)
  })

  it('refuses an endpoint that is not a URL', () => {
    expect(() =>
      readObjectStorageConfig({ ...VALID, OBJECT_STORAGE_ENDPOINT: 'account.r2' }),
    ).toThrow(ObjectStorageConfigurationError)
  })

  it('refuses a bucket name that is not a single path segment', () => {
    // The bucket is interpolated into the signed path, so a separator in it
    // would silently re-target the request at a different object.
    for (const bucket of ['a/b', '../other', 'UPPER', 'x']) {
      expect(() =>
        readObjectStorageConfig({ ...VALID, OBJECT_STORAGE_BUCKET: bucket }),
      ).toThrow(ObjectStorageConfigurationError)
    }
  })

  it('refuses an access key that equals its own secret', () => {
    expect(() =>
      readObjectStorageConfig({
        ...VALID,
        OBJECT_STORAGE_SECRET_ACCESS_KEY: VALID.OBJECT_STORAGE_ACCESS_KEY_ID,
      }),
    ).toThrow(ObjectStorageConfigurationError)
  })
})
