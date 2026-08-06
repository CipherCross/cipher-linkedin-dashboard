/**
 * The `ObjectStorageProvider` contract, proved twice over.
 *
 * **Against the fake**, the six properties S19 is accepted on — allow, deny,
 * missing, expiry, type and size — are proved as *behaviour*: a URL is issued,
 * presented to something that enforces the terms it was issued under, and
 * accepted or refused. Proving them only as `assert*` calls would leave the
 * question this chain has been bitten by twice unanswered, which is not whether
 * a limit computes correctly but whether the call site consults it
 * (N-ROSTER mutations 9 and 10).
 *
 * **Against the R2 adapter**, the same contract is exercised with an injected
 * `fetch`, which covers everything about that adapter except the one thing no
 * test in this repository can cover today: whether R2 accepts the URLs. S19 may
 * not create a bucket, a token or a credential, so that half is a known limit
 * and S20's first job. The signature bytes themselves are graded separately,
 * against AWS's published vector, in `objectStorageSigv4.test.ts`.
 *
 * No credential in this file is real: they are AWS's own published
 * documentation examples, which grant nothing.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { ObjectStorageConfigurationError } from '../api/_lib/storage/config.js'
import { ObjectKeyError } from '../api/_lib/storage/keys.js'
import {
  getObjectStorageProvider,
  objectStorageProviderExists,
  resetObjectStorageProviders,
} from '../api/_lib/storage/runtime.js'
import { FakeObjectStorageProvider } from '../api/_lib/storage/fakeProvider.js'
import { ObjectStoragePolicyError } from '../api/_lib/storage/policy.js'
import {
  ObjectStorageUnavailableError,
  type ObjectStorageProvider,
} from '../api/_lib/storage/provider.js'
import {
  R2ObjectStorageProvider,
  type FetchLike,
} from '../api/_lib/storage/r2Provider.js'

const TENANT = 'acme'
const KEY = 't/acme/lead-photos/notebook-1/jane-doe.jpg'
const OTHER_TENANT_KEY = 't/globex/lead-photos/notebook-1/jane-doe.jpg'

/** AWS's published documentation example credentials. Fake by construction. */
const EXAMPLE_CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
} as const

// ---------------------------------------------------------------- the fake

describe('the in-memory provider honours the terms it issues', () => {
  function providerAt(clock: { ms: number }): FakeObjectStorageProvider {
    return new FakeObjectStorageProvider({
      tenantId: TENANT,
      now: () => clock.ms,
    })
  }

  it('allows a read of an object that is there', async () => {
    const clock = { ms: 1_000_000 }
    const provider = providerAt(clock)
    provider.seedObject({ key: KEY, sizeBytes: 2048, contentType: 'image/jpeg' })

    const signed = await provider.presignGet({ key: KEY, ttlSeconds: 300 })
    expect(signed.method).toBe('GET')
    expect(provider.deliver({ url: signed.url, method: 'GET' })).toEqual({
      status: 200,
    })
  })

  it('reports a missing object as 404, distinct from a refusal', async () => {
    const clock = { ms: 1_000_000 }
    const provider = providerAt(clock)

    const signed = await provider.presignGet({ key: KEY, ttlSeconds: 300 })
    // The grant is valid; the object simply is not there. A provider that
    // collapsed this into 403 would make an empty bucket look like a
    // permissions failure, and vice versa.
    expect(provider.deliver({ url: signed.url, method: 'GET' }).status).toBe(404)
    expect(await provider.statObject(KEY)).toBeNull()
  })

  it('stops honouring a URL at its expiry', async () => {
    const clock = { ms: 1_000_000 }
    const provider = providerAt(clock)
    provider.seedObject({ key: KEY, sizeBytes: 2048, contentType: 'image/jpeg' })

    const signed = await provider.presignGet({ key: KEY, ttlSeconds: 60 })
    expect(provider.deliver({ url: signed.url, method: 'GET' }).status).toBe(200)

    clock.ms += 61_000
    expect(provider.deliver({ url: signed.url, method: 'GET' })).toEqual({
      status: 403,
      reason: 'expired',
    })
  })

  it('reports the expiry it actually issued', async () => {
    const clock = { ms: Date.parse('2026-08-06T12:00:00.000Z') }
    const provider = providerAt(clock)
    const signed = await provider.presignGet({ key: KEY, ttlSeconds: 300 })
    expect(signed.expiresAt).toBe('2026-08-06T12:05:00.000Z')
  })

  it('does not let a GET grant perform a PUT', async () => {
    const clock = { ms: 1_000_000 }
    const provider = providerAt(clock)
    const signed = await provider.presignGet({ key: KEY, ttlSeconds: 300 })

    expect(
      provider.deliver({ url: signed.url, method: 'PUT', bodyBytes: 10 }).status,
    ).toBe(403)
  })

  it('does not let the key be edited in the URL', async () => {
    const clock = { ms: 1_000_000 }
    const provider = providerAt(clock)
    provider.seedObject({
      key: OTHER_TENANT_KEY.replace('globex', 'acme'),
      sizeBytes: 1,
      contentType: 'image/jpeg',
    })
    const signed = await provider.presignGet({ key: KEY, ttlSeconds: 300 })

    const tampered = signed.url.replace('jane-doe.jpg', 'someone-else.jpg')
    expect(provider.deliver({ url: tampered, method: 'GET' }).status).toBe(403)
  })

  it('refuses a key belonging to another tenant', async () => {
    const clock = { ms: 1_000_000 }
    const provider = providerAt(clock)
    await expect(
      provider.presignGet({ key: OTHER_TENANT_KEY, ttlSeconds: 300 }),
    ).rejects.toThrow(ObjectKeyError)
  })

  describe('uploads', () => {
    it('accepts an upload that matches everything it declared', async () => {
      const clock = { ms: 1_000_000 }
      const provider = providerAt(clock)
      const signed = await provider.presignPut({
        key: KEY,
        ttlSeconds: 120,
        contentType: 'image/jpeg',
        contentLength: 2048,
      })

      expect(signed.requiredHeaders).toEqual({
        'content-type': 'image/jpeg',
        'content-length': '2048',
      })
      expect(
        provider.deliver({
          url: signed.url,
          method: 'PUT',
          headers: signed.requiredHeaders,
          bodyBytes: 2048,
        }),
      ).toEqual({ status: 200 })
      expect(await provider.statObject(KEY)).toMatchObject({
        sizeBytes: 2048,
        contentType: 'image/jpeg',
      })
    })

    /**
     * The mechanism the size limit actually rests on. The byte count is signed,
     * so a client that asks for a 2 KB grant and then sends 5 MB is refused by
     * the store — not by an application check it has already passed.
     */
    it('refuses a body that differs from the signed length', async () => {
      const clock = { ms: 1_000_000 }
      const provider = providerAt(clock)
      const signed = await provider.presignPut({
        key: KEY,
        ttlSeconds: 120,
        contentType: 'image/jpeg',
        contentLength: 2048,
      })

      expect(
        provider.deliver({
          url: signed.url,
          method: 'PUT',
          headers: signed.requiredHeaders,
          bodyBytes: 5 * 1024 * 1024,
        }).status,
      ).toBe(403)
      expect(provider.objectCount()).toBe(0)
    })

    it('refuses an upload that alters a signed header', async () => {
      const clock = { ms: 1_000_000 }
      const provider = providerAt(clock)
      const signed = await provider.presignPut({
        key: KEY,
        ttlSeconds: 120,
        contentType: 'image/jpeg',
        contentLength: 2048,
      })

      // Declaring an image to pass the check and then sending HTML is exactly
      // what signing the content type prevents.
      expect(
        provider.deliver({
          url: signed.url,
          method: 'PUT',
          headers: { ...signed.requiredHeaders, 'content-type': 'text/html' },
          bodyBytes: 2048,
        }).status,
      ).toBe(403)
    })

    it('refuses an upload that omits a signed header entirely', async () => {
      const clock = { ms: 1_000_000 }
      const provider = providerAt(clock)
      const signed = await provider.presignPut({
        key: KEY,
        ttlSeconds: 120,
        contentType: 'image/jpeg',
        contentLength: 2048,
      })

      expect(
        provider.deliver({ url: signed.url, method: 'PUT', bodyBytes: 2048 })
          .status,
      ).toBe(403)
    })

    it('never issues a grant for a disallowed type or size', async () => {
      const clock = { ms: 1_000_000 }
      const provider = providerAt(clock)

      await expect(
        provider.presignPut({
          key: KEY,
          ttlSeconds: 120,
          contentType: 'image/svg+xml',
          contentLength: 2048,
        }),
      ).rejects.toThrow(ObjectStoragePolicyError)

      await expect(
        provider.presignPut({
          key: KEY,
          ttlSeconds: 120,
          contentType: 'image/jpeg',
          contentLength: 6 * 1024 * 1024,
        }),
      ).rejects.toThrow(ObjectStoragePolicyError)
    })
  })

  it('deletes idempotently and reports nothing about prior existence', async () => {
    const clock = { ms: 1_000_000 }
    const provider = providerAt(clock)
    provider.seedObject({ key: KEY, sizeBytes: 1, contentType: 'image/png' })

    await expect(provider.deleteObject(KEY)).resolves.toBeUndefined()
    expect(await provider.statObject(KEY)).toBeNull()
    // Again, on an object that is already gone.
    await expect(provider.deleteObject(KEY)).resolves.toBeUndefined()
  })

  it('fails loudly once closed', async () => {
    const provider = new FakeObjectStorageProvider({ tenantId: TENANT })
    await provider.close()
    await expect(
      provider.presignGet({ key: KEY, ttlSeconds: 300 }),
    ).rejects.toThrow(ObjectStorageUnavailableError)
  })
})

// ------------------------------------------------------------ the R2 adapter

describe('the R2 adapter', () => {
  interface Recorder {
    readonly calls: { url: string; method?: string }[]
    readonly fetchImpl: FetchLike
  }

  function recorder(
    response: { status: number; headers?: Record<string, string> } | Error,
  ): Recorder {
    const calls: { url: string; method?: string }[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method })
      if (response instanceof Error) throw response
      const headers = response.headers ?? {}
      return {
        status: response.status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      }
    }
    return { calls, fetchImpl }
  }

  function provider(overrides: Partial<Recorder> = {}): {
    provider: ObjectStorageProvider
    calls: { url: string; method?: string }[]
  } {
    const rec = recorder({ status: 200 })
    const fetchImpl = overrides.fetchImpl ?? rec.fetchImpl
    const calls = overrides.calls ?? rec.calls
    return {
      calls,
      provider: new R2ObjectStorageProvider({
        tenantId: TENANT,
        bucket: 'tenant-acme',
        endpoint: 'https://account.r2.cloudflarestorage.com',
        credentials: EXAMPLE_CREDENTIALS,
        fetchImpl,
        now: () => Date.parse('2026-08-06T12:00:00.000Z'),
      }),
    }
  }

  it('signs a read URL against the bucket path', async () => {
    const signed = await provider().provider.presignGet({
      key: KEY,
      ttlSeconds: 300,
    })

    const url = new URL(signed.url)
    expect(url.origin).toBe('https://account.r2.cloudflarestorage.com')
    expect(url.pathname).toBe(`/tenant-acme/${KEY}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.expiresAt).toBe('2026-08-06T12:05:00.000Z')
    // The secret mints the signature and must never travel in the URL.
    expect(signed.url).not.toContain(EXAMPLE_CREDENTIALS.secretAccessKey)
  })

  it('signs the upload limits into the URL rather than merely checking them', async () => {
    const signed = await provider().provider.presignPut({
      key: KEY,
      ttlSeconds: 120,
      contentType: 'image/jpeg',
      contentLength: 2048,
    })

    expect(
      new URL(signed.url).searchParams.get('X-Amz-SignedHeaders'),
    ).toBe('content-length;content-type;host')
    expect(signed.requiredHeaders).toEqual({
      'content-type': 'image/jpeg',
      'content-length': '2048',
    })
  })

  it('refuses a cross-tenant key before signing anything', async () => {
    const { provider: p, calls } = provider()
    await expect(
      p.presignGet({ key: OTHER_TENANT_KEY, ttlSeconds: 300 }),
    ).rejects.toThrow(ObjectKeyError)
    expect(calls).toHaveLength(0)
  })

  it('refuses an out-of-policy lifetime before signing anything', async () => {
    await expect(
      provider().provider.presignGet({ key: KEY, ttlSeconds: 24 * 60 * 60 }),
    ).rejects.toThrow(ObjectStoragePolicyError)
  })

  it('reads object metadata from a HEAD response', async () => {
    const rec = recorder({
      status: 200,
      headers: {
        'content-length': '2048',
        'content-type': 'image/jpeg',
        etag: '"abc123"',
      },
    })
    const { provider: p, calls } = provider(rec)

    expect(await p.statObject(KEY)).toEqual({
      key: KEY,
      sizeBytes: 2048,
      contentType: 'image/jpeg',
      etag: '"abc123"',
    })
    expect(calls[0].method).toBe('HEAD')
  })

  it('answers null for a missing object', async () => {
    const { provider: p } = provider(recorder({ status: 404 }))
    expect(await p.statObject(KEY)).toBeNull()
  })

  /**
   * The distinction that matters to any future reconciliation pass: an outage
   * must not read as "the object is gone", or a manifest comparison would
   * conclude the bucket had been emptied.
   */
  it('does not report an outage as a missing object', async () => {
    const { provider: p } = provider(recorder({ status: 500 }))
    await expect(p.statObject(KEY)).rejects.toThrow(
      ObjectStorageUnavailableError,
    )
  })

  it('treats 204, 200 and 404 alike on delete, and anything else as a failure', async () => {
    for (const status of [200, 204, 404]) {
      const { provider: p } = provider(recorder({ status }))
      await expect(p.deleteObject(KEY)).resolves.toBeUndefined()
    }
    const { provider: failing } = provider(recorder({ status: 500 }))
    await expect(failing.deleteObject(KEY)).rejects.toThrow(
      ObjectStorageUnavailableError,
    )
  })

  it('performs head and delete itself with a short-lived URL it never returns', async () => {
    const rec = recorder({ status: 204 })
    const { provider: p, calls } = provider(rec)
    await p.deleteObject(KEY)

    const url = new URL(calls[0].url)
    expect(calls[0].method).toBe('DELETE')
    // Signed like any other request, but with seconds of life, and consumed
    // inside the adapter — no caller ever receives this string.
    expect(url.searchParams.get('X-Amz-Expires')).toBe('30')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not put a signed URL into the error it raises for a failed fetch', async () => {
    const rec = recorder(new Error('socket hang up'))
    const { provider: p } = provider(rec)

    // An error message is the most likely thing in the adapter to reach a log,
    // and the URL in it would be a live capability until it expired.
    await expect(p.statObject(KEY)).rejects.toThrow(ObjectStorageUnavailableError)
    await p.statObject(KEY).catch((error: Error) => {
      expect(error.message).not.toContain('X-Amz-Signature')
      expect(error.message).toContain('socket hang up')
    })
  })

  it('fails loudly once closed', async () => {
    const { provider: p } = provider()
    await p.close()
    await expect(p.statObject(KEY)).rejects.toThrow(ObjectStorageUnavailableError)
  })
})

// --------------------------------------------------------------- the runtime

describe('the shared provider cache', () => {
  const ENV_KEYS = [
    'OBJECT_STORAGE_ENDPOINT',
    'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_ACCESS_KEY_ID',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  ] as const

  function withStorageEnv<T>(run: () => T): T {
    const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
    process.env.OBJECT_STORAGE_ENDPOINT =
      'https://account.r2.cloudflarestorage.com'
    process.env.OBJECT_STORAGE_BUCKET = 'tenant-acme'
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = EXAMPLE_CREDENTIALS.accessKeyId
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY =
      EXAMPLE_CREDENTIALS.secretAccessKey
    try {
      return run()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  beforeEach(async () => {
    await resetObjectStorageProviders()
  })

  it('refuses an invalid tenant id before reading any configuration', () => {
    // Important ordering: this is the point where a caller-supplied value would
    // otherwise become a cache key, and it must be refused with no credential
    // present at all.
    expect(() => getObjectStorageProvider('../evil')).toThrow(ObjectKeyError)
    expect(objectStorageProviderExists('../evil')).toBe(false)
  })

  it('reuses one provider per tenant and keeps tenants apart', () => {
    withStorageEnv(() => {
      const first = getObjectStorageProvider('acme')
      expect(getObjectStorageProvider('acme')).toBe(first)

      const other = getObjectStorageProvider('globex')
      expect(other).not.toBe(first)
      expect(other.tenantId).toBe('globex')
    })
  })

  it('refuses to build anything when the storage layer is unconfigured', () => {
    // No silent fallback to a fake: an unconfigured storage layer must fail
    // rather than mint URLs that authenticate nobody.
    expect(() => getObjectStorageProvider('acme')).toThrow(
      ObjectStorageConfigurationError,
    )
  })
})
