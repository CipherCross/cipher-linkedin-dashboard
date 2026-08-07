/**
 * The lead-photo read: the signing service, the path flag, the tenant
 * configuration, and the provider's new byte-level operations.
 *
 * The forbidden-key tests are the centre of this file. What they pin is not "a
 * traversal is refused" — `keys.ts` owns that — but the narrower property this
 * slice adds: **a browser cannot name an object.** It sends lead ids, the server
 * derives keys from a column, and a `photo_path` that does not map produces no URL
 * rather than a URL to something else.
 */

import { describe, expect, it } from 'vitest'

import {
  deploymentPhotoPath,
  deploymentReadPath,
} from '../api/activity-daily.js'
import {
  objectStorageConfigured,
  ObjectStorageConfigurationError,
  OBJECT_STORAGE_TENANT_ID_ENV,
  readObjectStorageTenantId,
} from '../api/_lib/storage/config.js'
import { FakeObjectStorageProvider } from '../api/_lib/storage/fakeProvider.js'
import {
  LEAD_PHOTO_URL_TTL_SECONDS,
  LeadPhotoRequestError,
  MAX_PHOTO_BATCH,
  parseLeadIdList,
  parseLeadPhotoRequest,
  signLeadPhotoUrls,
  type LeadPhotoRow,
} from '../api/_lib/storage/leadPhotoService.js'
import { MAX_GET_TTL_SECONDS } from '../api/_lib/storage/policy.js'
import {
  base64ChecksumToHex,
  parseListObjectsV2,
  R2ObjectStorageProvider,
} from '../api/_lib/storage/r2Provider.js'
import { sha256Base64 } from '../api/_lib/storage/manifest.js'
import { ObjectStorageError } from '../api/_lib/storage/provider.js'

const TENANT = 'acme'

const provider = () => new FakeObjectStorageProvider({ tenantId: TENANT })

const row = (leadId: string, photoPath: string | null): LeadPhotoRow => ({
  lead_id: leadId,
  photo_path: photoPath,
})

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

/** A configured environment, as a deployment would set it. */
const CONFIGURED = {
  OBJECT_STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  OBJECT_STORAGE_BUCKET: 'acme-lead-photos',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'access-key-id',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret-access-key',
  OBJECT_STORAGE_TENANT_ID: TENANT,
} as const

describe('signing a batch of lead photos', () => {
  it('signs a URL per lead that has a photo', async () => {
    const result = await signLeadPhotoUrls({
      rows: [row(ID_A, 'notebook-1/alice.jpg'), row(ID_B, 'notebook-2/bob.jpg')],
      provider: provider(),
      tenantId: TENANT,
    })

    expect(result.photos).toHaveLength(2)
    expect(result.photos[0].leadId).toBe(ID_A)
    expect(result.photos[0].url).toContain('t/acme/lead-photos/notebook-1/alice.jpg')
    expect(result.refused).toEqual([])
  })

  it('returns a URL a store would accept, and refuses it once expired', async () => {
    const clock = { now: 1_000_000 }
    const store = new FakeObjectStorageProvider({
      tenantId: TENANT,
      now: () => clock.now,
    })
    store.seedObject({
      key: 't/acme/lead-photos/notebook-1/alice.jpg',
      sizeBytes: 69,
      contentType: 'image/png',
    })

    const { photos } = await signLeadPhotoUrls({
      rows: [row(ID_A, 'notebook-1/alice.jpg')],
      provider: store,
      tenantId: TENANT,
    })
    expect(store.deliver({ url: photos[0].url, method: 'GET' })).toEqual({ status: 200 })

    clock.now += (LEAD_PHOTO_URL_TTL_SECONDS + 1) * 1000
    expect(store.deliver({ url: photos[0].url, method: 'GET' })).toEqual({
      status: 403,
      reason: 'expired',
    })
  })

  it('is a read capability only — the same URL cannot upload', async () => {
    const store = provider()
    const { photos } = await signLeadPhotoUrls({
      rows: [row(ID_A, 'notebook-1/alice.jpg')],
      provider: store,
      tenantId: TENANT,
    })
    expect(store.deliver({ url: photos[0].url, method: 'PUT', bodyBytes: 10 })).toEqual({
      status: 403,
      reason: 'method not signed',
    })
  })

  it('reports the expiry it signed', async () => {
    const clock = { now: 1_700_000_000_000 }
    const { photos } = await signLeadPhotoUrls({
      rows: [row(ID_A, 'notebook-1/alice.jpg')],
      provider: new FakeObjectStorageProvider({ tenantId: TENANT, now: () => clock.now }),
      tenantId: TENANT,
    })
    expect(photos[0].expiresAt).toBe(
      new Date(clock.now + LEAD_PHOTO_URL_TTL_SECONDS * 1000).toISOString(),
    )
  })

  it('omits a lead with no photo rather than erroring', async () => {
    const result = await signLeadPhotoUrls({
      rows: [row(ID_A, null), row(ID_B, '')],
      provider: provider(),
      tenantId: TENANT,
    })
    expect(result.photos).toEqual([])
    expect(result.refused).toEqual([])
  })

  it('signs within the policy ceiling', () => {
    expect(LEAD_PHOTO_URL_TTL_SECONDS).toBeLessThanOrEqual(MAX_GET_TTL_SECONDS)
  })

  /**
   * A provider failure is not a property of one row. Reporting it as a refusal
   * would tell the caller "this lead's path is malformed" when the truth is "the
   * store is unreachable", and a reconciliation or a retry would then be aimed at
   * the wrong thing.
   */
  it('propagates a provider failure instead of reporting refused rows', async () => {
    const broken = provider()
    broken.breakProvider()
    await expect(
      signLeadPhotoUrls({
        rows: [row(ID_A, 'notebook-1/alice.jpg')],
        provider: broken,
        tenantId: TENANT,
      }),
    ).rejects.toThrow()
  })
})

describe('forbidden keys — what a client cannot reach', () => {
  /**
   * Every one of these is a `photo_path` *value*, i.e. what an attacker would have
   * to get into the column to escape. None of them produces a URL.
   */
  it.each([
    ['traversal', 'notebook-1/../../etc/passwd'],
    ['percent-encoded traversal', 'notebook-1/%2e%2e/alice.jpg'],
    ['another tenant', '../other/lead-photos/alice.jpg'],
    ['a full key of another tenant', 't/other/lead-photos/n/alice.jpg'],
    ['an absolute path', '/notebook-1/alice.jpg'],
    ['a URL', 'https://evil.test/x.jpg'],
    ['a query string', 'notebook-1/alice.jpg?x=1'],
    ['a NUL', 'notebook-1/alice\u0000.jpg'],
    ['a newline', 'notebook-1/alice\n.jpg'],
    ['a bare filename', 'alice.jpg'],
    ['too many segments', 'notebook-1/deep/alice.jpg'],
    ['a whitespace-padded path', ' notebook-1/alice.jpg '],
  ])('refuses %s and signs nothing', async (_label, photoPath) => {
    const result = await signLeadPhotoUrls({
      rows: [row(ID_A, photoPath)],
      provider: provider(),
      tenantId: TENANT,
    })
    expect(result.photos).toEqual([])
    expect(result.refused).toEqual([ID_A])
  })

  it('keeps signing the rest of the batch when one row is refused', async () => {
    const result = await signLeadPhotoUrls({
      rows: [row(ID_A, 'notebook-1/../escape.jpg'), row(ID_B, 'notebook-2/bob.jpg')],
      provider: provider(),
      tenantId: TENANT,
    })
    expect(result.refused).toEqual([ID_A])
    expect(result.photos.map((photo) => photo.leadId)).toEqual([ID_B])
  })

  /**
   * A mismatched tenant is the *caller's* mistake and is refused before any row is
   * looked at — not degraded into "every photo_path is malformed", which is what a
   * per-row refusal would have said.
   */
  it('refuses a provider bound to another tenant, before signing anything', async () => {
    await expect(
      signLeadPhotoUrls({
        rows: [row(ID_A, 'notebook-1/alice.jpg')],
        provider: provider(),
        tenantId: 'other',
      }),
    ).rejects.toThrow(/bound to a different tenant/)
  })
})

describe('the lead id list', () => {
  it('splits, trims and deduplicates', () => {
    expect(parseLeadIdList(` ${ID_A}, ${ID_B} ,${ID_A}, `)).toEqual([ID_A, ID_B])
  })

  it('is empty for an absent or blank parameter', () => {
    expect(parseLeadIdList(null)).toEqual([])
    expect(parseLeadIdList('')).toEqual([])
    expect(parseLeadIdList(' , ,')).toEqual([])
  })

  it('caps the batch at what a page renders', () => {
    expect(MAX_PHOTO_BATCH).toBe(100)
  })
})

describe('the request the endpoint accepts', () => {
  const request = (query: string) =>
    parseLeadPhotoRequest(new URL(`https://app.test/api/activity-daily?${query}`))

  it('accepts a batch of uuids', () => {
    expect(request(`lead_ids=${ID_A},${ID_B}`).leadIds).toEqual([ID_A, ID_B])
  })

  it('requires at least one id', () => {
    expect(() => request('lead_ids=')).toThrow(LeadPhotoRequestError)
    expect(() => request('op=leads.photoUrls')).toThrow(LeadPhotoRequestError)
  })

  it('refuses a batch over the cap', () => {
    const ids = Array.from({ length: MAX_PHOTO_BATCH + 1 }, (_unused, index) =>
      ID_A.slice(0, -3) + String(index + 100),
    )
    expect(() => request(`lead_ids=${ids.join(',')}`)).toThrow(/at most 100/)
    // Exactly the cap is accepted, so the boundary is not off by one.
    expect(request(`lead_ids=${ids.slice(0, MAX_PHOTO_BATCH).join(',')}`).leadIds)
      .toHaveLength(MAX_PHOTO_BATCH)
  })

  it.each([
    ['a lead key', 'notebook-1|https://www.linkedin.com/in/alice'],
    ['an object key', 't/acme/lead-photos/notebook-1/alice.jpg'],
    ['a bare number', '42'],
    ['a truncated uuid', ID_A.slice(0, -1)],
    ['SQL', "1' or '1'='1"],
  ])('refuses %s in place of a uuid', (_label, value) => {
    expect(() => request(`lead_ids=${encodeURIComponent(value)}`)).toThrow(
      LeadPhotoRequestError,
    )
  })

  it('counts a batch after deduplication, not before', () => {
    // 200 parameters naming one lead is one signature, so it is not over the cap.
    const repeated = Array.from({ length: 200 }, () => ID_A).join(',')
    expect(request(`lead_ids=${repeated}`).leadIds).toEqual([ID_A])
  })
})

describe('the photo-path flag', () => {
  it('is supabase unless every condition holds', () => {
    expect(deploymentPhotoPath({})).toBe('supabase')
    // Opt-in alone is not enough.
    expect(
      deploymentPhotoPath({ NEON_PHOTOS_DEFAULT: 'neon', ...CONFIGURED }),
    ).toBe('supabase')
    // Nor is the read path alone.
    expect(
      deploymentPhotoPath({ NEON_READS_DEFAULT: 'neon', ...CONFIGURED }),
    ).toBe('supabase')
    // Nor are both, without storage configured.
    expect(
      deploymentPhotoPath({
        NEON_PHOTOS_DEFAULT: 'neon',
        NEON_READS_DEFAULT: 'neon',
      }),
    ).toBe('supabase')
  })

  it('is neon when the opt-in, the read path and the storage config all hold', () => {
    expect(
      deploymentPhotoPath({
        NEON_PHOTOS_DEFAULT: 'neon',
        NEON_READS_DEFAULT: 'neon',
        ...CONFIGURED,
      }),
    ).toBe('neon')
  })

  it.each([['true'], ['1'], ['NEON'], [' neon-ish'], ['']])(
    'treats %j as off',
    (value) => {
      expect(
        deploymentPhotoPath({
          NEON_PHOTOS_DEFAULT: value,
          NEON_READS_DEFAULT: 'neon',
          ...CONFIGURED,
        }),
      ).toBe('supabase')
    },
  )

  it('leaves the read-path flag alone', () => {
    expect(deploymentReadPath({ NEON_PHOTOS_DEFAULT: 'neon' })).toBe('supabase')
    expect(deploymentReadPath({ NEON_READS_DEFAULT: 'neon' })).toBe('neon')
  })
})

describe('the tenant id', () => {
  it('reads a valid one', () => {
    expect(readObjectStorageTenantId({ ...CONFIGURED })).toBe(TENANT)
  })

  it('has no default', () => {
    expect(() => readObjectStorageTenantId({})).toThrow(ObjectStorageConfigurationError)
  })

  it.each([
    ['upper case', 'Acme'],
    ['a separator', 'acme/evil'],
    ['a leading hyphen', '-acme'],
    ['a space', 'acme corp'],
    ['too long', 'a'.repeat(65)],
    ['empty', '   '],
  ])('refuses %s', (_label, value) => {
    expect(() =>
      readObjectStorageTenantId({ [OBJECT_STORAGE_TENANT_ID_ENV]: value }),
    ).toThrow(ObjectStorageConfigurationError)
  })

  it('reports configuration as a boolean without throwing', () => {
    expect(objectStorageConfigured({ ...CONFIGURED })).toBe(true)
    expect(objectStorageConfigured({})).toBe(false)
    // Everything but the tenant: configured for S19's purposes, not for S20's.
    const { OBJECT_STORAGE_TENANT_ID: _omitted, ...withoutTenant } = CONFIGURED
    expect(objectStorageConfigured(withoutTenant)).toBe(false)
  })
})

describe('the provider byte-level operations, against the fake', () => {
  it('writes bytes with a checksum the store verifies and reports back', async () => {
    const store = provider()
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const stat = await store.putObject({
      key: 't/acme/lead-photos/notebook-1/alice.jpg',
      body,
      contentType: 'image/png',
      checksumSha256: sha256Base64(body),
    })
    expect(stat.sizeBytes).toBe(body.byteLength)
    expect(stat.checksumSha256).toHaveLength(64)
  })

  it('refuses a body that does not match its declared checksum', async () => {
    const store = provider()
    await expect(
      store.putObject({
        key: 't/acme/lead-photos/notebook-1/alice.jpg',
        body: new Uint8Array([1, 2, 3]),
        contentType: 'image/png',
        checksumSha256: sha256Base64(new Uint8Array([9, 9, 9])),
      }),
    ).rejects.toThrow(ObjectStorageError)
    expect(store.objectCount()).toBe(0)
  })

  it('reports no checksum for an object written without one', async () => {
    const store = provider()
    await store.putObject({
      key: 't/acme/lead-photos/notebook-1/alice.jpg',
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    })
    const stat = await store.statObject('t/acme/lead-photos/notebook-1/alice.jpg')
    expect(stat?.checksumSha256).toBeNull()
  })

  /**
   * The state a *browser* upload leaves behind, and the reason
   * `checksumUnverified` exists at all: a presigned PUT signs the length and the
   * type, not the content, so the store has no checksum to report afterwards. A
   * fake that invented one here would make a reconciliation report claim `verified`
   * for objects nothing ever verified.
   */
  it('records no checksum for an object uploaded through a signed URL', async () => {
    const store = provider()
    const signed = await store.presignPut({
      key: 't/acme/lead-photos/notebook-1/alice.jpg',
      ttlSeconds: 60,
      contentType: 'image/png',
      contentLength: 69,
    })
    expect(
      store.deliver({
        url: signed.url,
        method: 'PUT',
        headers: signed.requiredHeaders,
        bodyBytes: 69,
      }),
    ).toEqual({ status: 200 })

    const stat = await store.statObject('t/acme/lead-photos/notebook-1/alice.jpg')
    expect(stat?.sizeBytes).toBe(69)
    expect(stat?.checksumSha256).toBeNull()
  })

  it('applies the class policy to a server-side write', async () => {
    const store = provider()
    await expect(
      store.putObject({
        key: 't/acme/lead-photos/notebook-1/alice.svg',
        body: new Uint8Array([1, 2, 3]),
        contentType: 'image/svg+xml',
        checksumSha256: sha256Base64(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toThrow()
  })

  it.each([
    ['every tenant', 't/'],
    ['a sibling tenant by prefix', 't/acme-evil/'],
    ['another tenant', 't/other/lead-photos/'],
    ['an empty prefix', ''],
  ])('refuses a listing of %s', async (_label, prefix) => {
    await expect(provider().listObjects({ prefix })).rejects.toThrow()
  })

  it('lists this tenant with either spelling of its own prefix', async () => {
    const store = provider()
    await expect(store.listObjects({ prefix: 't/acme/' })).resolves.toBeDefined()
    await expect(store.listObjects({ prefix: 't/acme' })).resolves.toBeDefined()
  })
})

describe('the R2 adapter, against an injected fetch', () => {
  const options = (
    handler: (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array },
    ) => {
      status: number
      headers?: Record<string, string>
      body?: string
    },
  ) => {
    const calls: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: Uint8Array
    }[] = []
    return {
      calls,
      provider: new R2ObjectStorageProvider({
        tenantId: TENANT,
        bucket: 'acme-lead-photos',
        endpoint: 'https://account.r2.cloudflarestorage.com',
        credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
        fetchImpl: async (url, init) => {
          calls.push({ url, ...init })
          const response = handler(url, init)
          return {
            status: response.status,
            headers: {
              get: (name: string) => response.headers?.[name.toLowerCase()] ?? null,
            },
            text: async () => response.body ?? '',
          }
        },
      }),
    }
  }

  it('signs the checksum header into a write', async () => {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const checksum = sha256Base64(body)
    const { provider: r2, calls } = options(() => ({
      status: 200,
      headers: { etag: '"abc"', 'x-amz-checksum-sha256': checksum },
    }))

    const stat = await r2.putObject({
      key: 't/acme/lead-photos/notebook-1/alice.jpg',
      body,
      contentType: 'image/png',
      checksumSha256: checksum,
    })

    expect(calls[0].method).toBe('PUT')
    expect(calls[0].body).toBe(body)
    expect(calls[0].headers?.['x-amz-checksum-sha256']).toBe(checksum)
    // Signed, not merely sent: the header names appear in the signature's own
    // parameter, so stripping one invalidates the URL.
    const signedHeaders = new URL(calls[0].url).searchParams.get('X-Amz-SignedHeaders')
    expect(signedHeaders).toContain('x-amz-checksum-sha256')
    expect(signedHeaders).toContain('content-type')
    expect(stat.checksumSha256).toHaveLength(64)
  })

  it('distinguishes a rejected body from an outage', async () => {
    const { provider: bad } = options(() => ({ status: 400 }))
    await expect(
      bad.putObject({
        key: 't/acme/lead-photos/notebook-1/alice.jpg',
        body: new Uint8Array([1]),
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/malformed or not matching/)

    const { provider: down } = options(() => ({ status: 503 }))
    await expect(
      down.putObject({
        key: 't/acme/lead-photos/notebook-1/alice.jpg',
        body: new Uint8Array([1]),
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/status 503/)
  })

  it('asks for the stored checksum when it stats an object', async () => {
    const { provider: r2, calls } = options(() => ({
      status: 200,
      headers: {
        'content-length': '69',
        'content-type': 'image/png',
        etag: '"abc"',
        'x-amz-checksum-sha256': sha256Base64(new Uint8Array([1, 2, 3])),
      },
    }))

    const stat = await r2.statObject('t/acme/lead-photos/notebook-1/alice.jpg')
    expect(calls[0].headers?.['x-amz-checksum-mode']).toBe('ENABLED')
    expect(stat?.checksumSha256).toHaveLength(64)
  })

  it('reports no checksum when the store returns none, rather than inventing one', async () => {
    const { provider: r2 } = options(() => ({
      status: 200,
      headers: { 'content-length': '69', etag: '"an-md5-not-a-sha"' },
    }))
    const stat = await r2.statObject('t/acme/lead-photos/notebook-1/alice.jpg')
    expect(stat?.checksumSha256).toBeNull()
    expect(stat?.etag).toBe('"an-md5-not-a-sha"')
  })

  it('lists a page and follows the store’s continuation token', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1/abc=</NextContinuationToken>
  <Contents>
    <Key>t%2Facme%2Flead-photos%2Fnotebook-1%2Falice.jpg</Key>
    <Size>69</Size>
    <ETag>&quot;abc123&quot;</ETag>
  </Contents>
  <Contents>
    <Key>t%2Facme%2Flead-photos%2Fnotebook-2%2Fcarol_2.jpg</Key>
    <Size>34</Size>
    <ETag>&quot;def456&quot;</ETag>
  </Contents>
</ListBucketResult>`
    const { provider: r2, calls } = options(() => ({ status: 200, body: xml }))

    const page = await r2.listObjects({ prefix: 't/acme/lead-photos/' })
    const query = new URL(calls[0].url).searchParams
    expect(query.get('list-type')).toBe('2')
    expect(query.get('encoding-type')).toBe('url')
    expect(query.get('prefix')).toBe('t/acme/lead-photos/')
    expect(page.objects).toEqual([
      {
        key: 't/acme/lead-photos/notebook-1/alice.jpg',
        sizeBytes: 69,
        etag: '"abc123"',
      },
      {
        key: 't/acme/lead-photos/notebook-2/carol_2.jpg',
        sizeBytes: 34,
        etag: '"def456"',
      },
    ])
    expect(page.nextCursor).toBe('1/abc=')
  })

  it('passes a cursor back verbatim', async () => {
    const { provider: r2, calls } = options(() => ({
      status: 200,
      body: '<ListBucketResult></ListBucketResult>',
    }))
    await r2.listObjects({ prefix: 't/acme/lead-photos/', cursor: '1/abc=' })
    expect(new URL(calls[0].url).searchParams.get('continuation-token')).toBe('1/abc=')
  })

  it('refuses a listing outside its tenant before it makes a request', async () => {
    const { provider: r2, calls } = options(() => ({ status: 200, body: '' }))
    await expect(r2.listObjects({ prefix: 't/' })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('treats a non-200 listing as an outage', async () => {
    const { provider: r2 } = options(() => ({ status: 500 }))
    await expect(r2.listObjects({ prefix: 't/acme/lead-photos/' })).rejects.toThrow(
      /status 500/,
    )
  })
})

describe('the listing parser and the checksum decoder', () => {
  it('reads an empty listing as an empty last page', () => {
    expect(parseListObjectsV2('<ListBucketResult></ListBucketResult>')).toEqual({
      objects: [],
      nextCursor: null,
    })
  })

  it('decodes XML entities in an ETag', () => {
    const page = parseListObjectsV2(
      '<Contents><Key>t%2Fa%2Fb.jpg</Key><Size>1</Size><ETag>&quot;x&amp;y&quot;</ETag></Contents>',
    )
    expect(page.objects[0].etag).toBe('"x&y"')
  })

  it('treats a missing size as zero rather than NaN', () => {
    const page = parseListObjectsV2('<Contents><Key>t%2Fa%2Fb.jpg</Key></Contents>')
    expect(page.objects[0].sizeBytes).toBe(0)
  })

  it('ignores a Contents block with no key', () => {
    expect(parseListObjectsV2('<Contents><Size>4</Size></Contents>').objects).toEqual([])
  })

  it('converts a base64 SHA-256 to hex and refuses anything else', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(base64ChecksumToHex(sha256Base64(bytes))).toHaveLength(64)
    expect(base64ChecksumToHex(null)).toBeNull()
    expect(base64ChecksumToHex('   ')).toBeNull()
    // A CRC32 is four bytes: not a SHA-256, so `null` rather than a short digest
    // that would then read as a mismatch on every comparison.
    expect(base64ChecksumToHex(Buffer.from([1, 2, 3, 4]).toString('base64'))).toBeNull()
  })
})
