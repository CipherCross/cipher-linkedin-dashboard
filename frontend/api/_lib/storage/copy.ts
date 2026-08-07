/**
 * The copy: an export directory of lead photos into a tenant's bucket, with a
 * manifest as the receipt.
 *
 * ## The three properties this is built around
 *
 * **1. It is resumable, because at cutover it will be interrupted.** A freeze
 * window is the worst possible place to discover that a failed copy has to start
 * over. So every object is addressed by a key derived from its source path, the
 * write is an overwrite, and a second run over the same source skips what is
 * already there and correct. There is no state file to lose: the destination
 * bucket *is* the progress record.
 *
 * **2. A "verified" copy means a checksum somebody else computed.** The tool
 * hashes each file before writing it and sends that hash to the store, which
 * recomputes it over the body that arrived and refuses a mismatch. That is what
 * makes the claim mean anything — a tool that hashed the bytes it read and then
 * reported success has proved that it can read a file. Where the store cannot
 * confirm a checksum, the report says `sizeOnly` rather than `verified`; see
 * `manifest.ts`.
 *
 * **3. A refusal is a finding, not a stop.** An export written by tooling nobody
 * here controls will contain surprises: a `.jpg` that is an HTML error page, a
 * path with three segments, a stray zero-byte file. Each is reported against its
 * source path and the rest of the copy continues. Stopping on the first would
 * mean an operator learns about one problem per run, and each run is a full walk.
 *
 * ## Why `dryRun` is the mode this session can prove
 *
 * A dry run reads every source byte, derives every key, computes every checksum
 * and builds the manifest — it just never writes. That is not a degraded mode: the
 * manifest a dry run produces is *the same artifact* a real run produces, so the
 * count, the byte total and the digest are gradeable with no bucket in existence.
 * When the bucket does exist, the same manifest is what reconciliation compares
 * against, and a real run is a dry run plus the writes.
 */

import {
  ObjectKeyError,
  tenantObjectPrefix,
  type ObjectClass,
} from './keys.js'
import {
  LEAD_PHOTO_CLASS,
  leadPhotoObjectKey,
  sniffImageContentType,
} from './leadPhotoObjects.js'
import {
  buildObjectManifest,
  hexToBase64,
  reconcileManifests,
  sha256Hex,
  type ObjectManifest,
  type ObjectManifestEntry,
  type ObservedObject,
  type ReconciliationReport,
} from './manifest.js'
import { assertUploadContentType, assertUploadSize } from './policy.js'
import type { ObjectSource } from './objectSource.js'
import type { ObjectStorageProvider } from './provider.js'

/**
 * Why one object was not copied.
 *
 * Named cases rather than free text: an operator's first question about a report
 * with 40 failures is whether they are 40 of one thing, and a tally needs a
 * closed set. The `detail` carries the specifics.
 */
export type CopySkipReason =
  | 'forbidden-key'
  | 'unsupported-content'
  | 'policy-denied'
  | 'write-failed'

export interface CopyFailure {
  readonly sourcePath: string
  readonly reason: CopySkipReason
  readonly detail: string
}

export interface CopyReport {
  /** The source's name, for the log. Never enters the manifest. */
  readonly source: string
  readonly provider: string
  readonly tenantId: string
  readonly dryRun: boolean
  /** Source entries the walk saw, before any refusal. */
  readonly examined: number
  /** Objects written on this run. */
  readonly written: number
  /** Already present, same size and matching checksum. */
  readonly skipped: number
  /**
   * Already present with the same size but no checksum the store would confirm,
   * so this run rewrote them.
   *
   * Counted separately because it is the difference between a second run being
   * free and a second run re-uploading the whole bucket — which is a thing an
   * operator needs to see rather than infer from a duration.
   */
  readonly rewrittenUnverified: number
  readonly failures: readonly CopyFailure[]
  /**
   * What the source says should be in the bucket: every object the copy accepted,
   * including ones that were skipped as already-present.
   *
   * This is the artifact reconciliation compares against, so it describes the
   * intended end state rather than this run's activity.
   */
  readonly manifest: ObjectManifest
}

export interface CopyOptions {
  readonly source: ObjectSource
  readonly provider: ObjectStorageProvider
  readonly tenantId: string
  /** Read, hash and plan; write nothing. */
  readonly dryRun?: boolean
  /** Which class the source tree holds. Only `lead-photos` exists today. */
  readonly objectClass?: ObjectClass
  /** Called once per examined object, for progress on a long run. */
  readonly onProgress?: (examined: number, total: number) => void
}

/**
 * Copy a source tree into the tenant's bucket and return the receipt.
 *
 * The provider's own `tenantId` is compared against the requested one before
 * anything is read. A provider is bound to one tenant at construction and
 * re-checks every key, so a mismatch would be caught later anyway — but it would
 * be caught as several thousand individual key refusals rather than as one
 * sentence naming the actual mistake.
 */
export async function copyObjects(options: CopyOptions): Promise<CopyReport> {
  const { source, provider, tenantId } = options
  const objectClass = options.objectClass ?? LEAD_PHOTO_CLASS
  const dryRun = options.dryRun === true

  if (provider.tenantId !== tenantId) {
    throw new ObjectKeyError(
      `The provider is bound to a different tenant than the copy was asked for`,
    )
  }

  const sourceObjects = await source.listObjects()
  const entries: ObjectManifestEntry[] = []
  const failures: CopyFailure[] = []
  let written = 0
  let skipped = 0
  let rewrittenUnverified = 0
  let examined = 0

  for (const sourceObject of sourceObjects) {
    examined += 1
    options.onProgress?.(examined, sourceObjects.length)

    let key: string
    try {
      key = keyFor(objectClass, tenantId, sourceObject.path)
    } catch (error) {
      failures.push({
        sourcePath: sourceObject.path,
        reason: 'forbidden-key',
        detail: messageOf(error),
      })
      continue
    }

    const body = await source.readObject(sourceObject.path)

    // Sniffed, never derived from the name — `leadPhotoObjects.ts` records why:
    // the agent calls every object `.jpg` whatever LinkedIn served.
    const contentType = sniffImageContentType(body)
    if (contentType === null) {
      failures.push({
        sourcePath: sourceObject.path,
        reason: 'unsupported-content',
        detail:
          `the first ${Math.min(body.byteLength, 12)} bytes are not JPEG, PNG ` +
          `or WebP, so this is not an object this class accepts`,
      })
      continue
    }

    // The same policy a browser upload passes through. A copy is a write of the
    // same class, so a file the policy would refuse from a client must not enter
    // the bucket through a back door that happens to be trusted.
    try {
      assertUploadContentType(objectClass, contentType)
      assertUploadSize(objectClass, body.byteLength)
    } catch (error) {
      failures.push({
        sourcePath: sourceObject.path,
        reason: 'policy-denied',
        detail: messageOf(error),
      })
      continue
    }

    const sha256 = sha256Hex(body)
    const entry: ObjectManifestEntry = {
      key,
      sizeBytes: body.byteLength,
      sha256,
      contentType,
    }

    if (dryRun) {
      entries.push(entry)
      continue
    }

    // The skip decision, and the one place resumability lives. A destination
    // object counts as done only when the store reports a checksum equal to
    // ours: equal sizes are not equality, and this loop is the last chance to
    // notice a truncated write from an interrupted run.
    const existing = await provider.statObject(key)
    if (
      existing !== null &&
      existing.sizeBytes === entry.sizeBytes &&
      existing.checksumSha256 === sha256
    ) {
      skipped += 1
      entries.push(entry)
      continue
    }
    if (existing !== null && existing.checksumSha256 === null) {
      rewrittenUnverified += 1
    }

    try {
      await provider.putObject({
        key,
        body,
        contentType,
        checksumSha256: hexToBase64(sha256),
      })
      written += 1
      entries.push(entry)
    } catch (error) {
      // The object is left out of the manifest, so reconciliation will not
      // expect it and the failure has to be dealt with rather than being
      // recorded as an expectation that quietly went unmet.
      failures.push({
        sourcePath: sourceObject.path,
        reason: 'write-failed',
        detail: messageOf(error),
      })
    }
  }

  return {
    source: source.name,
    provider: provider.name,
    tenantId,
    dryRun,
    examined,
    written,
    skipped,
    rewrittenUnverified,
    failures,
    manifest: buildObjectManifest(entries),
  }
}

/**
 * Read the destination back and compare it against a manifest.
 *
 * Two passes, because one cannot answer both questions: the listing finds objects
 * the manifest does not claim, and the per-key stat is the only thing that can
 * return a checksum. The stat pass walks the *manifest*, so a bucket holding a
 * million objects still costs one request per expected object rather than per
 * object present.
 */
export async function reconcileDestination(input: {
  readonly provider: ObjectStorageProvider
  readonly tenantId: string
  readonly manifest: ObjectManifest
  readonly objectClass?: ObjectClass
  /** Guard against an unbounded walk if a provider never stops paging. */
  readonly maxPages?: number
}): Promise<ReconciliationReport> {
  const objectClass = input.objectClass ?? LEAD_PHOTO_CLASS
  const prefix = tenantObjectPrefix(input.tenantId, objectClass)
  const maxPages = input.maxPages ?? 1000

  const present = new Map<string, number>()
  let cursor: string | null = null
  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      throw new ObjectKeyError(
        `The destination listing exceeded ${maxPages} pages; refusing to ` +
          `reconcile against a walk that did not terminate`,
      )
    }
    const listing = await input.provider.listObjects({ prefix, cursor })
    for (const object of listing.objects) present.set(object.key, object.sizeBytes)
    if (listing.nextCursor === null) break
    cursor = listing.nextCursor
  }

  const observed: ObservedObject[] = []
  for (const entry of input.manifest.entries) {
    const stat = await input.provider.statObject(entry.key)
    if (stat === null) continue
    present.delete(entry.key)
    observed.push({
      key: entry.key,
      sizeBytes: stat.sizeBytes,
      sha256: stat.checksumSha256,
      contentType: stat.contentType,
    })
  }

  // Whatever the listing saw and the manifest did not claim. Reported as
  // `unexpected` by `reconcileManifests`, with no checksum fetched: an object
  // nobody expected does not need its hash to be a finding.
  for (const [key, sizeBytes] of present) {
    observed.push({ key, sizeBytes, sha256: null, contentType: null })
  }

  return reconcileManifests({ expected: input.manifest, observed })
}

function keyFor(
  objectClass: ObjectClass,
  tenantId: string,
  sourcePath: string,
): string {
  if (objectClass !== LEAD_PHOTO_CLASS) {
    throw new ObjectKeyError(
      `No source-path mapping is defined for object class ` +
        `${JSON.stringify(objectClass)}. A new class adds one here together ` +
        `with its policy, or it cannot be copied.`,
    )
  }
  return leadPhotoObjectKey({ tenantId, photoPath: sourcePath })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
