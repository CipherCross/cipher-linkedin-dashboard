/**
 * The deterministic manifest, the lead-photo key mapping, and reconciliation.
 *
 * The numbers in `FIXTURES` are **pinned literals**, not values read from the
 * files at test time. That is the point of them: the spec grades this slice on
 * "fixture count/size/checksum", and a test that hashed the fixtures and compared
 * the result to itself would pass for any bytes at all. These are the sizes and
 * digests recorded when the fixtures were created, so a fixture edited by accident
 * — or a hash function quietly changed — fails here.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { ObjectKeyError } from '../api/_lib/storage/keys.js'
import {
  IMAGE_SNIFF_BYTES,
  LEAD_PHOTO_CLASS,
  isLeadPhotoSourcePath,
  leadPhotoObjectKey,
  leadPhotoSourcePath,
  sniffImageContentType,
} from '../api/_lib/storage/leadPhotoObjects.js'
import {
  buildObjectManifest,
  hexToBase64,
  ObjectManifestError,
  parseObjectManifest,
  reconcileManifests,
  serializeObjectManifest,
  sha256Base64,
  sha256Hex,
  type ObjectManifestEntry,
} from '../api/_lib/storage/manifest.js'

const TENANT = 'acme'

const FIXTURE_ROOT = fileURLToPath(
  new URL('./fixtures/objects/lead-photos/', import.meta.url),
)

/** Path → (bytes, sha256), pinned when the fixtures were created. */
const FIXTURES = {
  'notebook-1/alice.jpg': {
    sizeBytes: 69,
    sha256: 'bb523ee5e8c47a7a269dc310c68dd0f640bbf6ea04d10037737d2568ddc4956e',
    contentType: 'image/png',
  },
  'notebook-1/bob-smith.jpg': {
    sizeBytes: 34,
    sha256: '86be52bdb7547413cafb3ed175a806a798c65de98b40849e0b974c47d187de65',
    contentType: 'image/webp',
  },
  'notebook-2/carol_2.jpg': {
    sizeBytes: 69,
    sha256: 'bb523ee5e8c47a7a269dc310c68dd0f640bbf6ea04d10037737d2568ddc4956e',
    contentType: 'image/png',
  },
} as const

const entry = (
  key: string,
  sizeBytes: number,
  sha256: string,
  contentType = 'image/jpeg',
): ObjectManifestEntry => ({ key, sizeBytes, sha256, contentType })

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

describe('lead photo key mapping', () => {
  it('maps a photo_path to a tenant key and back', () => {
    const key = leadPhotoObjectKey({
      tenantId: TENANT,
      photoPath: 'notebook-1/alice.jpg',
    })
    expect(key).toBe('t/acme/lead-photos/notebook-1/alice.jpg')
    expect(leadPhotoSourcePath(key)).toBe('notebook-1/alice.jpg')
  })

  it('round-trips every fixture path', () => {
    for (const path of Object.keys(FIXTURES)) {
      const key = leadPhotoObjectKey({ tenantId: TENANT, photoPath: path })
      expect(leadPhotoSourcePath(key)).toBe(path)
    }
  })

  it('keeps two tenants apart for the same photo path', () => {
    const one = leadPhotoObjectKey({ tenantId: 'acme', photoPath: 'n/a.jpg' })
    const two = leadPhotoObjectKey({ tenantId: 'acme2', photoPath: 'n/a.jpg' })
    expect(one).not.toBe(two)
  })

  /**
   * The mapping accepts exactly the shape `agent.py` writes. Each of these would
   * otherwise become a legal key for an object no lead row points at, which is the
   * failure this arity check exists for — nothing breaks, and the photo is
   * unreachable.
   */
  it.each([
    ['a bare filename', 'alice.jpg'],
    ['three segments', 'notebook-1/nested/alice.jpg'],
    ['a leading separator', '/notebook-1/alice.jpg'],
    ['a trailing separator', 'notebook-1/alice.jpg/'],
    ['a doubled separator', 'notebook-1//alice.jpg'],
    ['traversal', 'notebook-1/../alice.jpg'],
    ['percent-encoded traversal', 'notebook-1/%2e%2e%2falice.jpg'],
    ['a URL', 'https://example.test/alice.jpg'],
    ['an absolute Windows path', 'C:\\photos\\alice.jpg'],
    ['a NUL', 'notebook-1/alice\u0000.jpg'],
    ['a trailing space', 'notebook-1/alice.jpg '],
    ['a homoglyph separator', 'notebook-1\u2215alice.jpg'],
    ['an empty string', ''],
  ])('refuses %s', (_label, path) => {
    expect(() =>
      leadPhotoObjectKey({ tenantId: TENANT, photoPath: path }),
    ).toThrow(ObjectKeyError)
    expect(isLeadPhotoSourcePath(path)).toBe(false)
  })

  /**
   * `photo_path` is typed `string | null` and the service filters the NULL, so a
   * non-string can only arrive from a caller that skipped both — which is exactly
   * when a `TypeError` from `value.split` would surface as a 500 instead of a
   * refusal. The type check was silent until this existed.
   */
  it.each([[null], [123], [{}], [[]], [undefined]])(
    'refuses %j, which is not a string at all',
    (value) => {
      expect(() =>
        leadPhotoObjectKey({ tenantId: TENANT, photoPath: value as never }),
      ).toThrow(ObjectKeyError)
      expect(isLeadPhotoSourcePath(value)).toBe(false)
    },
  )

  it('refuses a key from another object class', () => {
    // Not a lead-photo key, so it has no photo_path — and the refusal is not a
    // parse failure: the key itself is well formed.
    expect(() => leadPhotoSourcePath('t/acme/lead-photos/only-one-segment')).toThrow(
      ObjectKeyError,
    )
  })
})

describe('image sniffing', () => {
  it('recognises the three allowed types by magic bytes', () => {
    const jpeg = new Uint8Array(IMAGE_SNIFF_BYTES).fill(0)
    jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0)
    expect(sniffImageContentType(jpeg)).toBe('image/jpeg')

    const png = new Uint8Array(IMAGE_SNIFF_BYTES).fill(0)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    expect(sniffImageContentType(png)).toBe('image/png')

    const webp = new Uint8Array(IMAGE_SNIFF_BYTES).fill(0)
    webp.set([0x52, 0x49, 0x46, 0x46], 0)
    webp.set([0x57, 0x45, 0x42, 0x50], 8)
    expect(sniffImageContentType(webp)).toBe('image/webp')
  })

  it('sniffs the committed fixtures rather than trusting their .jpg names', async () => {
    // The whole reason sniffing exists: the sync agent names every object `.jpg`
    // whatever LinkedIn served, so two of these three are not JPEGs.
    for (const [path, expected] of Object.entries(FIXTURES)) {
      const bytes = new Uint8Array(await readFile(`${FIXTURE_ROOT}${path}`))
      expect(sniffImageContentType(bytes)).toBe(expected.contentType)
    }
  })

  it('refuses an HTML error page saved with an image name', async () => {
    const bytes = new Uint8Array(
      await readFile(`${FIXTURE_ROOT}notebook-1/error-page.jpg`),
    )
    expect(sniffImageContentType(bytes)).toBeNull()
  })

  it('refuses an SVG, which the policy allowlist also excludes', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')
    expect(sniffImageContentType(svg)).toBeNull()
  })

  it('refuses bytes too short to decide on', () => {
    expect(sniffImageContentType(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
  })

  it('does not accept a RIFF container that is not WebP', () => {
    const wav = new Uint8Array(IMAGE_SNIFF_BYTES).fill(0)
    wav.set([0x52, 0x49, 0x46, 0x46], 0)
    wav.set([0x57, 0x41, 0x56, 0x45], 8)
    expect(sniffImageContentType(wav)).toBeNull()
  })
})

describe('the fixtures, by count size and checksum', () => {
  it('matches the pinned size and digest of every fixture', async () => {
    for (const [path, expected] of Object.entries(FIXTURES)) {
      const bytes = new Uint8Array(await readFile(`${FIXTURE_ROOT}${path}`))
      expect(bytes.byteLength).toBe(expected.sizeBytes)
      expect(sha256Hex(bytes)).toBe(expected.sha256)
    }
  })

  it('agrees between the hex and base64 encodings of one hash', async () => {
    const bytes = new Uint8Array(await readFile(`${FIXTURE_ROOT}notebook-1/alice.jpg`))
    expect(hexToBase64(sha256Hex(bytes))).toBe(sha256Base64(bytes))
  })

  it('refuses to convert something that is not a hex digest', () => {
    expect(() => hexToBase64('not-a-digest')).toThrow(ObjectManifestError)
    // Upper case is refused too: the manifest holds one spelling, so accepting
    // both would let two spellings of one hash compare unequal.
    expect(() => hexToBase64(HASH_A.toUpperCase())).toThrow(ObjectManifestError)
  })
})

describe('manifest determinism', () => {
  it('sorts by key, so input order cannot reach the digest', () => {
    const a = buildObjectManifest([
      entry('t/acme/lead-photos/n/b.jpg', 2, HASH_B),
      entry('t/acme/lead-photos/n/a.jpg', 1, HASH_A),
    ])
    const b = buildObjectManifest([
      entry('t/acme/lead-photos/n/a.jpg', 1, HASH_A),
      entry('t/acme/lead-photos/n/b.jpg', 2, HASH_B),
    ])

    expect(a.entries.map((e) => e.key)).toEqual([
      't/acme/lead-photos/n/a.jpg',
      't/acme/lead-photos/n/b.jpg',
    ])
    expect(a.digest).toBe(b.digest)
    expect(serializeObjectManifest(a)).toBe(serializeObjectManifest(b))
  })

  it('counts objects and bytes', () => {
    const manifest = buildObjectManifest([
      entry('t/acme/lead-photos/n/a.jpg', 69, HASH_A),
      entry('t/acme/lead-photos/n/b.jpg', 34, HASH_B),
    ])
    expect(manifest.objectCount).toBe(2)
    expect(manifest.totalBytes).toBe(103)
  })

  it('changes the digest when any field of any entry changes', () => {
    const base = buildObjectManifest([entry('t/acme/lead-photos/n/a.jpg', 1, HASH_A)])
    const digests = new Set([
      base.digest,
      buildObjectManifest([entry('t/acme/lead-photos/n/b.jpg', 1, HASH_A)]).digest,
      buildObjectManifest([entry('t/acme/lead-photos/n/a.jpg', 2, HASH_A)]).digest,
      buildObjectManifest([entry('t/acme/lead-photos/n/a.jpg', 1, HASH_B)]).digest,
      buildObjectManifest([
        entry('t/acme/lead-photos/n/a.jpg', 1, HASH_A, 'image/png'),
      ]).digest,
    ])
    expect(digests.size).toBe(5)
  })

  it('gives an empty manifest a stable digest and zero totals', () => {
    const empty = buildObjectManifest([])
    expect(empty.objectCount).toBe(0)
    expect(empty.totalBytes).toBe(0)
    expect(empty.digest).toBe(buildObjectManifest([]).digest)
    // Distinct from a manifest with one object, which a digest over nothing at
    // all would not be.
    expect(empty.digest).not.toBe(
      buildObjectManifest([entry('t/acme/lead-photos/n/a.jpg', 0, HASH_A)]).digest,
    )
  })

  it('refuses a duplicate key rather than keeping one', () => {
    expect(() =>
      buildObjectManifest([
        entry('t/acme/lead-photos/n/a.jpg', 1, HASH_A),
        entry('t/acme/lead-photos/n/a.jpg', 2, HASH_B),
      ]),
    ).toThrow(ObjectManifestError)
  })

  it.each([
    ['a non-hex checksum', entry('t/a/lead-photos/n/a.jpg', 1, 'nope')],
    ['an upper-case checksum', entry('t/a/lead-photos/n/a.jpg', 1, HASH_A.toUpperCase())],
    ['a negative size', entry('t/a/lead-photos/n/a.jpg', -1, HASH_A)],
    ['a fractional size', entry('t/a/lead-photos/n/a.jpg', 1.5, HASH_A)],
    ['an empty key', entry('', 1, HASH_A)],
    ['a tab in a key', entry('t/a/lead-photos/n/a\tb.jpg', 1, HASH_A)],
    ['a newline in a key', entry('t/a/lead-photos/n/a\nb.jpg', 1, HASH_A)],
    ['no content type', entry('t/a/lead-photos/n/a.jpg', 1, HASH_A, '')],
  ])('refuses %s', (_label, bad) => {
    expect(() => buildObjectManifest([bad])).toThrow(ObjectManifestError)
  })
})

describe('manifest serialization', () => {
  const manifest = buildObjectManifest([
    entry('t/acme/lead-photos/notebook-1/alice.jpg', 69, HASH_A, 'image/png'),
    entry('t/acme/lead-photos/notebook-2/carol_2.jpg', 34, HASH_B, 'image/webp'),
  ])

  it('writes one line per object with a two-line header', () => {
    const text = serializeObjectManifest(manifest)
    const lines = text.split('\n')
    expect(lines[0]).toBe('object-manifest\t1')
    expect(lines[1]).toBe('count\t2\tbytes\t103')
    expect(lines[2]).toBe(
      `t/acme/lead-photos/notebook-1/alice.jpg\t69\t${HASH_A}\timage/png`,
    )
    // Terminated, so appending an object changes exactly one line.
    expect(text.endsWith('\n')).toBe(true)
  })

  it('round-trips to the same digest', () => {
    const parsed = parseObjectManifest(serializeObjectManifest(manifest))
    expect(parsed.digest).toBe(manifest.digest)
    expect(parsed.entries).toEqual(manifest.entries)
  })

  it('recomputes the digest rather than reading it', () => {
    // An edited artifact must not be able to describe a set it does not hold. The
    // header claims three objects; the entries are two.
    const text = serializeObjectManifest(manifest).replace(
      'count\t2\tbytes\t103',
      'count\t3\tbytes\t103',
    )
    expect(() => parseObjectManifest(text)).toThrow(ObjectManifestError)
  })

  it('refuses a byte total that does not match its entries', () => {
    const text = serializeObjectManifest(manifest).replace('bytes\t103', 'bytes\t999')
    expect(() => parseObjectManifest(text)).toThrow(ObjectManifestError)
  })

  it.each([
    ['not a manifest', 'something-else\t1\ncount\t0\tbytes\t0\n'],
    ['an unsupported version', 'object-manifest\t2\ncount\t0\tbytes\t0\n'],
    ['a malformed header', 'object-manifest\t1\ntotal\t0\tbytes\t0\n'],
    ['a short entry line', `object-manifest\t1\ncount\t1\tbytes\t1\nkey\t1\t${HASH_A}\n`],
    ['nothing at all', ''],
  ])('refuses %s', (_label, text) => {
    expect(() => parseObjectManifest(text)).toThrow(ObjectManifestError)
  })
})

describe('reconciliation', () => {
  const manifest = buildObjectManifest([
    entry('t/acme/lead-photos/n/a.jpg', 10, HASH_A, 'image/png'),
    entry('t/acme/lead-photos/n/b.jpg', 20, HASH_B, 'image/png'),
  ])

  const observed = (
    overrides: Partial<Record<'a' | 'b', unknown>> = {},
  ) => [
    {
      key: 't/acme/lead-photos/n/a.jpg',
      sizeBytes: 10,
      sha256: HASH_A,
      contentType: 'image/png',
      ...(overrides.a as object),
    },
    {
      key: 't/acme/lead-photos/n/b.jpg',
      sizeBytes: 20,
      sha256: HASH_B,
      contentType: 'image/png',
      ...(overrides.b as object),
    },
  ]

  it('verifies a faithful copy', () => {
    const report = reconcileManifests({ expected: manifest, observed: observed() })
    expect(report.verdict).toBe('verified')
    expect(report.matched).toBe(2)
    expect(report.findings).toEqual([])
    expect(report.expectedCount).toBe(2)
    expect(report.actualCount).toBe(2)
    expect(report.expectedBytes).toBe(30)
    expect(report.actualBytes).toBe(30)
  })

  /**
   * The distinction the report exists for. Equal sizes are not equality, so a
   * destination that reports no checksum is `sizeOnly` — a weaker claim with its
   * own name — rather than green.
   */
  it('reports sizeOnly when a checksum could not be compared', () => {
    const report = reconcileManifests({
      expected: manifest,
      observed: observed({ b: { sha256: null } }),
    })
    expect(report.verdict).toBe('sizeOnly')
    expect(report.matched).toBe(1)
    expect(report.checksumUnverified).toBe(1)
    expect(report.findings).toEqual([
      { key: 't/acme/lead-photos/n/b.jpg', status: 'checksumUnverified' },
    ])
  })

  it('fails on a checksum mismatch and names no digest', () => {
    const report = reconcileManifests({
      expected: manifest,
      observed: observed({ a: { sha256: 'c'.repeat(64) } }),
    })
    expect(report.verdict).toBe('failed')
    expect(report.findings[0].status).toBe('checksumMismatch')
    expect(report.findings[0].detail).toBeUndefined()
  })

  it('fails on a size mismatch before it looks at the checksum', () => {
    const report = reconcileManifests({
      expected: manifest,
      observed: observed({ a: { sizeBytes: 9, sha256: 'c'.repeat(64) } }),
    })
    expect(report.findings[0].status).toBe('sizeMismatch')
    expect(report.findings[0].detail).toContain('9')
  })

  it('fails on a content-type mismatch', () => {
    const report = reconcileManifests({
      expected: manifest,
      observed: observed({ a: { contentType: 'text/html' } }),
    })
    expect(report.verdict).toBe('failed')
    expect(report.findings[0].status).toBe('contentTypeMismatch')
  })

  it('reports a missing object', () => {
    const report = reconcileManifests({
      expected: manifest,
      observed: [observed()[0]],
    })
    expect(report.verdict).toBe('failed')
    expect(report.findings).toEqual([
      { key: 't/acme/lead-photos/n/b.jpg', status: 'missing' },
    ])
  })

  /** The direction a walk of the expected list alone cannot see. */
  it('reports an object nothing expected', () => {
    const report = reconcileManifests({
      expected: manifest,
      observed: [
        ...observed(),
        {
          key: 't/acme/lead-photos/n/stale.jpg',
          sizeBytes: 5,
          sha256: null,
          contentType: null,
        },
      ],
    })
    expect(report.verdict).toBe('failed')
    expect(report.findings).toEqual([
      { key: 't/acme/lead-photos/n/stale.jpg', status: 'unexpected' },
    ])
    expect(report.actualCount).toBe(3)
  })

  it('refuses a listing that repeats a key', () => {
    expect(() =>
      reconcileManifests({ expected: manifest, observed: [...observed(), observed()[0]] }),
    ).toThrow(ObjectManifestError)
  })

  it('verifies an empty manifest against an empty destination', () => {
    const report = reconcileManifests({
      expected: buildObjectManifest([]),
      observed: [],
    })
    expect(report.verdict).toBe('verified')
  })

  it('knows the class every one of these keys belongs to', () => {
    // Guards the assumption the fixtures and the copy tool share: one class today,
    // and `copy.ts` refuses any other by name.
    expect(LEAD_PHOTO_CLASS).toBe('lead-photos')
  })
})
