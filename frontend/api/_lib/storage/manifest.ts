/**
 * The object manifest: a deterministic, comparable statement of what a set of
 * objects *is*.
 *
 * ## What the manifest is for
 *
 * `S27` freezes the workspace, copies the object bytes and then has to answer one
 * question before unfreezing: **did everything arrive intact?** A count is not an
 * answer (two buckets can hold 4 812 objects each and disagree about one of
 * them), and a byte total is not an answer either (a truncated file and a
 * duplicated one can cancel out). The answer is a per-key checksum, and the
 * artifact that carries it has to be diffable by a human under time pressure.
 *
 * So a manifest is a sorted list of `(key, size, sha256, content-type)` plus one
 * digest over the whole thing. Two manifests agree if and only if their digests
 * agree, and when they do not, `reconcileManifests` says which keys differ and
 * how.
 *
 * ## What "deterministic" is buying, precisely
 *
 * The digest must depend on the *set* of objects and nothing else. Three things
 * follow, and each is a test:
 *
 * 1. **Order is canonical, not incidental.** Entries are sorted by key. A
 *    provider listing arrives in the provider's order and a filesystem walk in
 *    the filesystem's; if either leaked into the digest, the same bucket would
 *    produce different digests on different machines and the artifact would be
 *    worthless as evidence.
 * 2. **No timestamp, no provider name, no run id.** A manifest built from the
 *    source export and a manifest built from the destination bucket must be
 *    *byte-identical* when the copy was faithful. Anything that records when or
 *    where it was built goes in the copy report instead — which is a log, not
 *    evidence.
 * 3. **A duplicate key is a refusal, not a merge.** Two entries for one key mean
 *    the caller's inputs are wrong; silently keeping the last would make the
 *    digest depend on iteration order again, through the back door.
 *
 * ## Why the serialized form is text and not JSON
 *
 * `JSON.stringify` over an object is deterministic in V8 for insertion order,
 * which is exactly the kind of guarantee that is true until someone reorders a
 * field. The canonical form here is one tab-separated line per entry with a
 * two-line header, so the digest depends on values that are visible in the file
 * — and `git diff` over two manifests is line-per-object, which is what somebody
 * comparing them at cutover actually wants.
 */

import { createHash } from 'node:crypto'

import { DataStoreContractError } from '../data/contracts.js'

export class ObjectManifestError extends DataStoreContractError {
  constructor(message: string) {
    super('OBJECT_MANIFEST_INVALID', message)
    this.name = 'ObjectManifestError'
  }
}

/** The manifest format's own version, so a future change is detectable. */
export const OBJECT_MANIFEST_VERSION = 1

export interface ObjectManifestEntry {
  readonly key: string
  readonly sizeBytes: number
  /** Lowercase hex SHA-256 of the object's bytes. */
  readonly sha256: string
  readonly contentType: string
}

export interface ObjectManifest {
  readonly version: number
  readonly objectCount: number
  readonly totalBytes: number
  /** Sorted by key, always. */
  readonly entries: readonly ObjectManifestEntry[]
  /** SHA-256 over the canonical serialization. */
  readonly digest: string
}

const HEX_SHA256 = /^[0-9a-f]{64}$/

/** Lowercase hex SHA-256 of a byte string. The one place the hash is chosen. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The base64 form the S3/R2 checksum headers take.
 *
 * Same bytes as `sha256Hex`, different encoding — kept beside it so the two can
 * never be computed from different inputs.
 */
export function sha256Base64(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64')
}

/** Hex → base64, for turning a manifest entry back into a checksum header. */
export function hexToBase64(hex: string): string {
  if (!HEX_SHA256.test(hex)) {
    throw new ObjectManifestError(
      `${JSON.stringify(hex)} is not a lowercase hex SHA-256 digest`,
    )
  }
  return Buffer.from(hex, 'hex').toString('base64')
}

function assertEntry(entry: ObjectManifestEntry): void {
  if (typeof entry.key !== 'string' || entry.key === '') {
    throw new ObjectManifestError('A manifest entry needs a non-empty key')
  }
  // The canonical form is tab-separated and line-per-entry, so a key carrying
  // either would produce a manifest that parses back into something else.
  if (/[\t\n\r]/.test(entry.key) || /[\t\n\r]/.test(entry.contentType ?? '')) {
    throw new ObjectManifestError(
      `Manifest fields may not contain tabs or newlines: ${JSON.stringify(entry.key)}`,
    )
  }
  if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
    throw new ObjectManifestError(
      `Manifest entry ${entry.key} needs a non-negative integer size, got ` +
        `${JSON.stringify(entry.sizeBytes)}`,
    )
  }
  if (!HEX_SHA256.test(entry.sha256)) {
    throw new ObjectManifestError(
      `Manifest entry ${entry.key} needs a lowercase hex SHA-256, got ` +
        `${JSON.stringify(entry.sha256)}`,
    )
  }
  if (typeof entry.contentType !== 'string' || entry.contentType === '') {
    throw new ObjectManifestError(
      `Manifest entry ${entry.key} needs a content type`,
    )
  }
}

/**
 * Build a manifest from entries in any order.
 *
 * The sort is on the key with `<`, which compares UTF-16 code units. The key
 * grammar in `keys.ts` is ASCII, where that order and byte order coincide — so
 * the canonical order is the same one a provider's lexicographic listing uses,
 * and a future non-ASCII class would have to revisit this line rather than
 * inherit a subtly different order.
 */
export function buildObjectManifest(
  entries: readonly ObjectManifestEntry[],
): ObjectManifest {
  const sorted = [...entries]
  for (const entry of sorted) assertEntry(entry)
  sorted.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].key === sorted[index - 1].key) {
      throw new ObjectManifestError(
        `Duplicate manifest key ${JSON.stringify(sorted[index].key)}. Two ` +
          `entries for one object mean the inputs are wrong; keeping one would ` +
          `make the digest depend on iteration order.`,
      )
    }
  }

  const totalBytes = sorted.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  const withoutDigest = {
    version: OBJECT_MANIFEST_VERSION,
    objectCount: sorted.length,
    totalBytes,
    entries: sorted as readonly ObjectManifestEntry[],
  }

  return {
    ...withoutDigest,
    digest: createHash('sha256')
      .update(canonicalText(withoutDigest), 'utf8')
      .digest('hex'),
  }
}

function canonicalText(manifest: {
  readonly version: number
  readonly objectCount: number
  readonly totalBytes: number
  readonly entries: readonly ObjectManifestEntry[]
}): string {
  const lines = [
    `object-manifest\t${manifest.version}`,
    `count\t${manifest.objectCount}\tbytes\t${manifest.totalBytes}`,
    ...manifest.entries.map(
      (entry) =>
        `${entry.key}\t${entry.sizeBytes}\t${entry.sha256}\t${entry.contentType}`,
    ),
  ]
  // Trailing newline: every line is terminated, so appending an entry changes
  // exactly one line rather than two.
  return `${lines.join('\n')}\n`
}

/** The artifact an operator diffs. Identical for identical object sets. */
export function serializeObjectManifest(manifest: ObjectManifest): string {
  return canonicalText(manifest)
}

/**
 * Parse a serialized manifest and re-derive its digest.
 *
 * The digest is **recomputed, never read**, and the header's count and total are
 * checked against the entries rather than trusted. A manifest is evidence; a
 * parser that believed the header would let an edited artifact claim to describe
 * a set it does not.
 */
export function parseObjectManifest(text: string): ObjectManifest {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  if (lines.length < 2) {
    throw new ObjectManifestError('A manifest needs its two header lines')
  }

  const [magic, version] = lines[0].split('\t')
  if (magic !== 'object-manifest') {
    throw new ObjectManifestError('Not an object manifest')
  }
  if (Number(version) !== OBJECT_MANIFEST_VERSION) {
    throw new ObjectManifestError(
      `Unsupported manifest version ${JSON.stringify(version)}`,
    )
  }

  const header = lines[1].split('\t')
  if (header[0] !== 'count' || header[2] !== 'bytes') {
    throw new ObjectManifestError('Malformed manifest header')
  }

  const entries = lines.slice(2).map((line) => {
    const fields = line.split('\t')
    if (fields.length !== 4) {
      throw new ObjectManifestError(
        `A manifest entry has four tab-separated fields; got ${fields.length}`,
      )
    }
    return {
      key: fields[0],
      sizeBytes: Number(fields[1]),
      sha256: fields[2],
      contentType: fields[3],
    }
  })

  const manifest = buildObjectManifest(entries)
  if (
    manifest.objectCount !== Number(header[1]) ||
    manifest.totalBytes !== Number(header[3])
  ) {
    throw new ObjectManifestError(
      `Manifest header claims ${header[1]} objects and ${header[3]} bytes; its ` +
        `entries are ${manifest.objectCount} and ${manifest.totalBytes}`,
    )
  }
  return manifest
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * What happened to one key.
 *
 * `checksumUnverified` is the entry that keeps this honest. A destination that
 * reports a size but no checksum — which is what an S3-compatible store answers
 * when it stored the object without one — cannot be *proved* identical, only
 * shown to be the same length. Collapsing that into `matched` would let a
 * reconciliation report green while having compared nothing but integers.
 */
export type ReconciliationStatus =
  | 'matched'
  | 'checksumUnverified'
  | 'checksumMismatch'
  | 'sizeMismatch'
  | 'contentTypeMismatch'
  | 'missing'
  | 'unexpected'

export interface ReconciliationFinding {
  readonly key: string
  readonly status: ReconciliationStatus
  readonly detail?: string
}

/**
 * Three outcomes rather than a boolean.
 *
 * `verified` means every expected object is present and its checksum was
 * compared. `sizeOnly` means nothing is missing, extra or the wrong length, but
 * at least one checksum could not be compared — a real, weaker result that has
 * its own name so a caller cannot accidentally treat it as the strong one.
 * `failed` is anything else.
 */
export type ReconciliationVerdict = 'verified' | 'sizeOnly' | 'failed'

export interface ReconciliationReport {
  readonly verdict: ReconciliationVerdict
  readonly expectedCount: number
  readonly actualCount: number
  readonly expectedBytes: number
  readonly actualBytes: number
  readonly matched: number
  readonly checksumUnverified: number
  readonly findings: readonly ReconciliationFinding[]
}

/**
 * An entry as read back from a destination, where the checksum may be unknown.
 *
 * Deliberately a different type from `ObjectManifestEntry`: a store's answer is
 * not a manifest until its checksums are known, and letting the two share a type
 * is how `sha256: ''` ends up in a digest.
 */
export interface ObservedObject {
  readonly key: string
  readonly sizeBytes: number
  readonly sha256: string | null
  readonly contentType: string | null
}

/**
 * Compare what should be there against what is.
 *
 * Both directions matter and the second is the less obvious one: an object in
 * the destination that no manifest entry claims is reported as `unexpected`
 * rather than ignored. A re-run that wrote a key under an old layout, or a stale
 * object from an abandoned attempt, is invisible to a check that only walks the
 * expected list — and at cutover an unexplained object is exactly the thing
 * somebody needs to see before declaring the copy done.
 */
export function reconcileManifests(input: {
  readonly expected: ObjectManifest
  readonly observed: readonly ObservedObject[]
}): ReconciliationReport {
  const observedByKey = new Map<string, ObservedObject>()
  for (const object of input.observed) {
    if (observedByKey.has(object.key)) {
      throw new ObjectManifestError(
        `The destination listing repeats ${JSON.stringify(object.key)}`,
      )
    }
    observedByKey.set(object.key, object)
  }

  const findings: ReconciliationFinding[] = []
  let matched = 0
  let checksumUnverified = 0

  for (const entry of input.expected.entries) {
    const observed = observedByKey.get(entry.key)
    if (!observed) {
      findings.push({ key: entry.key, status: 'missing' })
      continue
    }
    observedByKey.delete(entry.key)

    if (observed.sizeBytes !== entry.sizeBytes) {
      findings.push({
        key: entry.key,
        status: 'sizeMismatch',
        detail: `expected ${entry.sizeBytes} bytes, found ${observed.sizeBytes}`,
      })
      continue
    }
    if (observed.sha256 !== null && observed.sha256 !== entry.sha256) {
      // No digests in the detail: two 64-character strings in a log line are
      // unreadable, and the keys are what a re-copy needs.
      findings.push({ key: entry.key, status: 'checksumMismatch' })
      continue
    }
    if (observed.contentType !== null && observed.contentType !== entry.contentType) {
      findings.push({
        key: entry.key,
        status: 'contentTypeMismatch',
        detail: `expected ${entry.contentType}, found ${observed.contentType}`,
      })
      continue
    }
    if (observed.sha256 === null) {
      checksumUnverified += 1
      findings.push({ key: entry.key, status: 'checksumUnverified' })
      continue
    }
    matched += 1
  }

  for (const leftover of observedByKey.values()) {
    findings.push({ key: leftover.key, status: 'unexpected' })
  }

  const failed = findings.some((finding) => finding.status !== 'checksumUnverified')
  const verdict: ReconciliationVerdict = failed
    ? 'failed'
    : checksumUnverified > 0
      ? 'sizeOnly'
      : 'verified'

  return {
    verdict,
    expectedCount: input.expected.objectCount,
    actualCount: input.observed.length,
    expectedBytes: input.expected.totalBytes,
    actualBytes: input.observed.reduce((sum, object) => sum + object.sizeBytes, 0),
    matched,
    checksumUnverified,
    findings,
  }
}
