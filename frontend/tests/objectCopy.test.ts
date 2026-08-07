/**
 * The copy tooling: the filesystem source, the copy engine and reconciliation
 * against a destination.
 *
 * Graded against the committed fixtures with **pinned** counts, sizes and digests
 * — see the header of `objectManifest.test.ts` for why they are literals — and
 * against a fake provider that verifies the checksums it is sent. No bucket, no
 * network, no production bytes.
 */

import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { copyObjects, reconcileDestination } from '../api/_lib/storage/copy.js'
import { FakeObjectStorageProvider } from '../api/_lib/storage/fakeProvider.js'
import { ObjectKeyError } from '../api/_lib/storage/keys.js'
import {
  FilesystemObjectSource,
  ObjectSourceError,
} from '../api/_lib/storage/objectSource.js'
import { serializeObjectManifest, sha256Hex } from '../api/_lib/storage/manifest.js'
import { IMAGE_SNIFF_BYTES } from '../api/_lib/storage/leadPhotoObjects.js'

const TENANT = 'acme'

const FIXTURE_ROOT = fileURLToPath(
  new URL('./fixtures/objects/lead-photos', import.meta.url),
)

/** What the fixture tree holds, pinned. Five files; three are copyable. */
const COPYABLE = 3
const COPYABLE_BYTES = 69 + 34 + 69
const PNG_SHA = 'bb523ee5e8c47a7a269dc310c68dd0f640bbf6ea04d10037737d2568ddc4956e'
const WEBP_SHA = '86be52bdb7547413cafb3ed175a806a798c65de98b40849e0b974c47d187de65'

/**
 * The digest of the manifest a dry run over the fixtures produces.
 *
 * Pinned, because "deterministic" is the property under test and a value computed
 * at test time would make the assertion vacuous. It changes when the fixtures
 * change, when the key layout changes, or when the canonical serialization changes
 * — each of which is something a reviewer should be told about.
 *
 * It is also reproducible **without this codebase**, which is what makes it a pin
 * rather than a recording of whatever the code happened to emit:
 *
 * ```
 * printf 'object-manifest\t1\ncount\t3\tbytes\t172\n…' | shasum -a 256
 * ```
 *
 * with the three entry lines spelled as `serializeObjectManifest` documents.
 */
const FIXTURE_MANIFEST_DIGEST =
  '1e3d5138ab0740a56243cd124d4ae0ff48e2e5236d49251a3cd6b42ab6b98d94'

const source = () => new FilesystemObjectSource({ root: FIXTURE_ROOT })
const provider = () => new FakeObjectStorageProvider({ tenantId: TENANT })

async function tempSource(
  build: (root: string) => Promise<void>,
): Promise<FilesystemObjectSource> {
  const root = await mkdtemp(join(tmpdir(), 'object-source-'))
  await build(root)
  return new FilesystemObjectSource({ root })
}

const png = () => {
  const bytes = new Uint8Array(IMAGE_SNIFF_BYTES + 8)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

describe('the filesystem source', () => {
  it('lists every file in the tree, sorted, with sizes', async () => {
    const objects = await source().listObjects()
    expect(objects.map((object) => object.path)).toEqual([
      'notebook-1/alice.jpg',
      'notebook-1/bob-smith.jpg',
      'notebook-1/error-page.jpg',
      'notebook-1/nested/deep.jpg',
      'notebook-2/carol_2.jpg',
    ])
    expect(objects[0].sizeBytes).toBe(69)
    expect(objects[1].sizeBytes).toBe(34)
  })

  it('reads a file and its bytes hash to the pinned digest', async () => {
    const bytes = await source().readObject('notebook-1/alice.jpg')
    expect(sha256Hex(bytes)).toBe(PNG_SHA)
  })

  it.each([
    ['traversal', '../secrets.env'],
    ['deep traversal', 'notebook-1/../../secrets.env'],
    ['an absolute path', '/etc/hosts'],
    ['the root itself', '.'],
    ['an empty path', ''],
  ])('refuses to read %s', async (_label, path) => {
    await expect(source().readObject(path)).rejects.toThrow(ObjectSourceError)
  })

  /**
   * A symlink in an export is either an artifact of the export tool or an attempt
   * to have the copy read something outside the tree and publish it into a bucket
   * the whole team can fetch from. Skipped by the walk, and unreadable by name.
   */
  it('skips symlinks rather than following them', async () => {
    const escapee = await tempSource(async (root) => {
      await mkdir(join(root, 'notebook-1'))
      await writeFile(join(root, 'notebook-1', 'real.jpg'), png())
      await writeFile(join(root, 'outside.txt'), 'secret')
      await symlink(join(root, 'outside.txt'), join(root, 'notebook-1', 'link.jpg'))
    })

    const listed = await escapee.listObjects()
    expect(listed.map((object) => object.path)).toEqual(['notebook-1/real.jpg', 'outside.txt'])
  })

  it('refuses a tree deeper than its limit instead of walking forever', async () => {
    const deep = await tempSource(async (root) => {
      let path = root
      for (let level = 0; level < 4; level++) {
        path = join(path, `level-${level}`)
        await mkdir(path)
      }
      await writeFile(join(path, 'a.jpg'), png())
    })
    const shallow = new FilesystemObjectSource({
      root: (deep as unknown as { root: string }).root,
      maxDepth: 2,
    })
    await expect(shallow.listObjects()).rejects.toThrow(ObjectSourceError)
  })

  it('needs a root', () => {
    expect(() => new FilesystemObjectSource({ root: '  ' })).toThrow(ObjectSourceError)
  })

  /**
   * A directory is not an object. Without the regular-file check the read reaches
   * `readFile`, which fails with `EISDIR` — a raw system error rather than this
   * layer's refusal, and one a caller cannot distinguish from a provider fault.
   */
  it('refuses to read a directory as an object', async () => {
    await expect(source().readObject('notebook-1')).rejects.toThrow(ObjectSourceError)
  })

  /**
   * The case a prefix comparison gets wrong, and the reason containment is tested
   * with `relative()` rather than `startsWith()`.
   *
   * A sibling directory whose name *extends* the root's name — `/export` beside
   * `/export-old` — resolves to a path that starts with the root's string and is
   * not inside the root. Every traversal case above is refused either way, so this
   * is the only shape that tells the two implementations apart; a mutation to
   * `startsWith` was silent until this existed.
   */
  it('refuses a sibling directory whose name extends the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'object-source-'))
    const sibling = `${root}-old`
    await mkdir(sibling)
    await writeFile(join(sibling, 'secret.jpg'), png())

    const source = new FilesystemObjectSource({ root })
    const escape = `../${basename(sibling)}/secret.jpg`
    await expect(source.readObject(escape)).rejects.toThrow(ObjectSourceError)
  })

})

describe('a dry run over the fixtures', () => {
  it('reports the pinned count, byte total and manifest digest', async () => {
    const report = await copyObjects({
      source: source(),
      provider: provider(),
      tenantId: TENANT,
      dryRun: true,
    })

    expect(report.dryRun).toBe(true)
    expect(report.examined).toBe(5)
    expect(report.written).toBe(0)
    expect(report.manifest.objectCount).toBe(COPYABLE)
    expect(report.manifest.totalBytes).toBe(COPYABLE_BYTES)
    expect(report.manifest.digest).toBe(FIXTURE_MANIFEST_DIGEST)
  })

  it('writes nothing to the destination', async () => {
    const destination = provider()
    await copyObjects({
      source: source(),
      provider: destination,
      tenantId: TENANT,
      dryRun: true,
    })
    expect(destination.objectCount()).toBe(0)
  })

  it('names both refusals, by reason and source path', async () => {
    const report = await copyObjects({
      source: source(),
      provider: provider(),
      tenantId: TENANT,
      dryRun: true,
    })

    expect(report.failures).toEqual([
      {
        sourcePath: 'notebook-1/error-page.jpg',
        reason: 'unsupported-content',
        detail: expect.stringContaining('not JPEG, PNG or WebP'),
      },
      {
        sourcePath: 'notebook-1/nested/deep.jpg',
        reason: 'forbidden-key',
        detail: expect.stringContaining('<instance_id>/<file>'),
      },
    ])
  })

  it('produces a byte-identical manifest on a second run', async () => {
    const first = await copyObjects({
      source: source(),
      provider: provider(),
      tenantId: TENANT,
      dryRun: true,
    })
    const second = await copyObjects({
      source: source(),
      provider: provider(),
      tenantId: TENANT,
      dryRun: true,
    })
    expect(serializeObjectManifest(second.manifest)).toBe(
      serializeObjectManifest(first.manifest),
    )
  })

  it('derives keys under the tenant and the class', async () => {
    const report = await copyObjects({
      source: source(),
      provider: provider(),
      tenantId: TENANT,
      dryRun: true,
    })
    expect(report.manifest.entries.map((entry) => entry.key)).toEqual([
      't/acme/lead-photos/notebook-1/alice.jpg',
      't/acme/lead-photos/notebook-1/bob-smith.jpg',
      't/acme/lead-photos/notebook-2/carol_2.jpg',
    ])
  })

  it('records the sniffed content type, not one derived from the .jpg names', async () => {
    const report = await copyObjects({
      source: source(),
      provider: provider(),
      tenantId: TENANT,
      dryRun: true,
    })
    expect(report.manifest.entries.map((entry) => entry.contentType)).toEqual([
      'image/png',
      'image/webp',
      'image/png',
    ])
  })
})

describe('a real copy into the destination', () => {
  it('writes every copyable object with a verified checksum', async () => {
    const destination = provider()
    const report = await copyObjects({
      source: source(),
      provider: destination,
      tenantId: TENANT,
    })

    expect(report.written).toBe(COPYABLE)
    expect(report.skipped).toBe(0)
    expect(destination.objectCount()).toBe(COPYABLE)

    const stat = await destination.statObject('t/acme/lead-photos/notebook-1/alice.jpg')
    expect(stat).toMatchObject({
      sizeBytes: 69,
      contentType: 'image/png',
      checksumSha256: PNG_SHA,
    })
  })

  it('stores the WebP under its sniffed type', async () => {
    const destination = provider()
    await copyObjects({ source: source(), provider: destination, tenantId: TENANT })
    const stat = await destination.statObject(
      't/acme/lead-photos/notebook-1/bob-smith.jpg',
    )
    expect(stat?.contentType).toBe('image/webp')
    expect(stat?.checksumSha256).toBe(WEBP_SHA)
  })

  /** The property a freeze window depends on: a second run is nearly free. */
  it('is resumable — a second run writes nothing and skips everything', async () => {
    const destination = provider()
    await copyObjects({ source: source(), provider: destination, tenantId: TENANT })
    const again = await copyObjects({
      source: source(),
      provider: destination,
      tenantId: TENANT,
    })

    expect(again.written).toBe(0)
    expect(again.skipped).toBe(COPYABLE)
    // The manifest still describes the intended end state, not this run's activity.
    expect(again.manifest.objectCount).toBe(COPYABLE)
    expect(again.manifest.digest).toBe(FIXTURE_MANIFEST_DIGEST)
  })

  /**
   * The case an interrupted run leaves behind. Equal sizes are not equality, so a
   * destination object whose checksum differs is rewritten rather than skipped.
   */
  it('rewrites an object of the right size with the wrong bytes', async () => {
    const destination = provider()
    destination.seedObject({
      key: 't/acme/lead-photos/notebook-1/alice.jpg',
      sizeBytes: 69,
      contentType: 'image/png',
      checksumSha256: 'c'.repeat(64),
    })

    const report = await copyObjects({
      source: source(),
      provider: destination,
      tenantId: TENANT,
    })
    expect(report.written).toBe(COPYABLE)
    expect(report.skipped).toBe(0)
    const stat = await destination.statObject('t/acme/lead-photos/notebook-1/alice.jpg')
    expect(stat?.checksumSha256).toBe(PNG_SHA)
  })

  it('rewrites an object the store holds without a checksum, and says so', async () => {
    const destination = provider()
    destination.seedObject({
      key: 't/acme/lead-photos/notebook-1/alice.jpg',
      sizeBytes: 69,
      contentType: 'image/png',
    })

    const report = await copyObjects({
      source: source(),
      provider: destination,
      tenantId: TENANT,
    })
    expect(report.rewrittenUnverified).toBe(1)
    expect(report.written).toBe(COPYABLE)
  })

  it('reports a write failure and leaves that object out of the manifest', async () => {
    const destination = provider()
    const failing = new Proxy(destination, {
      get(target, property, receiver) {
        if (property === 'putObject') {
          return async (input: Parameters<FakeObjectStorageProvider['putObject']>[0]) => {
            if (input.key.endsWith('bob-smith.jpg')) {
              throw new Error('the store refused this write')
            }
            return destination.putObject(input)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })

    const report = await copyObjects({
      source: source(),
      provider: failing,
      tenantId: TENANT,
    })
    expect(report.written).toBe(COPYABLE - 1)
    // The fixture tree's own two refusals, plus this write failure.
    expect(report.failures).toHaveLength(3)
    expect(report.failures.map((failure) => failure.reason)).toContain('write-failed')
    // Left out on purpose: reconciliation must not expect an object the copy knows
    // it did not write, or the failure becomes an unmet expectation nobody reads.
    expect(report.manifest.objectCount).toBe(COPYABLE - 1)
  })

  /**
   * Refused **before anything is read**, which is the whole value of the check:
   * without it every key would be refused individually by the provider and the
   * operator would get several thousand key errors instead of one sentence naming
   * the actual mistake. So the assertion is that the source was never walked — a
   * mutation removing the check still throws, and was silent until this looked at
   * *when*.
   */
  it('refuses a provider bound to a different tenant before reading the source', async () => {
    const walked: string[] = []
    const watched = {
      name: 'watched',
      listObjects: async () => {
        walked.push('list')
        return source().listObjects()
      },
      readObject: (path: string) => source().readObject(path),
    }

    await expect(
      copyObjects({
        source: watched,
        provider: new FakeObjectStorageProvider({ tenantId: 'other' }),
        tenantId: TENANT,
      }),
    ).rejects.toThrow(ObjectKeyError)
    expect(walked).toEqual([])
  })

  /**
   * The reachable half of the class policy. `sniffImageContentType` answers only
   * the three types the policy allows, so the content-type assertion cannot fire
   * for this class today — the size one can, and an oversized image is a real thing
   * to find in a scraped bucket.
   */
  it('refuses an image over the class size limit', async () => {
    const oversized = await tempSource(async (root) => {
      await mkdir(join(root, 'notebook-1'))
      const big = new Uint8Array(5 * 1024 * 1024 + 1)
      big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
      await writeFile(join(root, 'notebook-1', 'huge.jpg'), big)
    })

    const report = await copyObjects({
      source: oversized,
      provider: provider(),
      tenantId: TENANT,
      dryRun: true,
    })
    expect(report.manifest.objectCount).toBe(0)
    expect(report.failures).toEqual([
      {
        sourcePath: 'notebook-1/huge.jpg',
        reason: 'policy-denied',
        detail: expect.stringContaining('exceeds the 5242880-byte limit'),
      },
    ])
  })

  it('refuses an object class with no source-path mapping', async () => {
    await expect(
      copyObjects({
        source: source(),
        provider: provider(),
        tenantId: TENANT,
        // Only `lead-photos` exists; a future class must add its mapping rather
        // than inherit this one by accident.
        objectClass: 'agent-artifacts' as never,
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      manifest: { objectCount: 0 },
      failures: expect.arrayContaining([
        expect.objectContaining({ reason: 'forbidden-key' }),
      ]),
    })
  })

  it('reports progress once per examined object', async () => {
    const seen: number[] = []
    await copyObjects({
      source: source(),
      provider: provider(),
      tenantId: TENANT,
      dryRun: true,
      onProgress: (examined, total) => seen.push(total - examined),
    })
    expect(seen).toEqual([4, 3, 2, 1, 0])
  })
})

describe('reconciling the destination', () => {
  it('verifies a complete copy', async () => {
    const destination = provider()
    const report = await copyObjects({
      source: source(),
      provider: destination,
      tenantId: TENANT,
    })

    const reconciliation = await reconcileDestination({
      provider: destination,
      tenantId: TENANT,
      manifest: report.manifest,
    })
    expect(reconciliation.verdict).toBe('verified')
    expect(reconciliation.matched).toBe(COPYABLE)
    expect(reconciliation.expectedBytes).toBe(COPYABLE_BYTES)
  })

  it('finds a missing object', async () => {
    const destination = provider()
    const report = await copyObjects({
      source: source(),
      provider: destination,
      tenantId: TENANT,
    })
    await destination.deleteObject('t/acme/lead-photos/notebook-2/carol_2.jpg')

    const reconciliation = await reconcileDestination({
      provider: destination,
      tenantId: TENANT,
      manifest: report.manifest,
    })
    expect(reconciliation.verdict).toBe('failed')
    expect(reconciliation.findings).toEqual([
      { key: 't/acme/lead-photos/notebook-2/carol_2.jpg', status: 'missing' },
    ])
  })

  /** The stale-object direction, which only the listing can see. */
  it('finds an object the manifest does not claim', async () => {
    const destination = provider()
    const report = await copyObjects({
      source: source(),
      provider: destination,
      tenantId: TENANT,
    })
    destination.seedObject({
      key: 't/acme/lead-photos/notebook-9/ghost.jpg',
      sizeBytes: 12,
      contentType: 'image/png',
    })

    const reconciliation = await reconcileDestination({
      provider: destination,
      tenantId: TENANT,
      manifest: report.manifest,
    })
    expect(reconciliation.findings).toEqual([
      { key: 't/acme/lead-photos/notebook-9/ghost.jpg', status: 'unexpected' },
    ])
  })

  it('degrades to sizeOnly when the store reports no checksum', async () => {
    const destination = provider()
    const report = await copyObjects({
      source: source(),
      provider: destination,
      tenantId: TENANT,
      dryRun: true,
    })
    // Seeded rather than copied: a signed browser upload leaves objects in exactly
    // this state, with a size and no checksum.
    for (const entry of report.manifest.entries) {
      destination.seedObject({
        key: entry.key,
        sizeBytes: entry.sizeBytes,
        contentType: entry.contentType,
      })
    }

    const reconciliation = await reconcileDestination({
      provider: destination,
      tenantId: TENANT,
      manifest: report.manifest,
    })
    expect(reconciliation.verdict).toBe('sizeOnly')
    expect(reconciliation.checksumUnverified).toBe(COPYABLE)
  })

  it('walks a listing that pages', async () => {
    const destination = provider()
    const report = await copyObjects({
      source: source(),
      provider: destination,
      tenantId: TENANT,
    })

    // One object per page: the walk must follow the cursor rather than trusting
    // the first page to be the whole bucket.
    const paged = new Proxy(destination, {
      get(target, property, receiver) {
        if (property === 'listObjects') {
          return (input: { prefix: string; cursor?: string | null }) =>
            destination.listObjects({ ...input, limit: 1 })
        }
        return Reflect.get(target, property, receiver)
      },
    })

    const reconciliation = await reconcileDestination({
      provider: paged,
      tenantId: TENANT,
      manifest: report.manifest,
    })
    expect(reconciliation.verdict).toBe('verified')
    expect(reconciliation.actualCount).toBe(COPYABLE)
  })

  it('refuses a listing that never terminates', async () => {
    const destination = provider()
    const endless = new Proxy(destination, {
      get(target, property, receiver) {
        if (property === 'listObjects') {
          // `setTimeout`, not an immediately-resolved promise, and the reason is a
          // finding rather than a detail: with the page ceiling mutated away, a
          // microtask-only loop starves the timer queue, so Vitest's own test
          // timeout never fires and the whole run **hangs** instead of failing.
          // A hang is not a red test — it stalled a mutation pass for ten minutes.
          // Yielding to the macrotask queue lets the timeout win.
          return () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ objects: [], nextCursor: 'always-more' }), 0),
            )
        }
        return Reflect.get(target, property, receiver)
      },
    })

    await expect(
      reconcileDestination({
        provider: endless,
        tenantId: TENANT,
        manifest: (
          await copyObjects({
            source: source(),
            provider: destination,
            tenantId: TENANT,
            dryRun: true,
          })
        ).manifest,
        maxPages: 3,
      }),
    ).rejects.toThrow(ObjectKeyError)
  })
})
