/**
 * The deterministic mapping between a lead photo as Supabase stores it today and
 * the tenant object key it takes in the new bucket.
 *
 * ## Why this is one function and not two conventions
 *
 * `sync-agent/agent.py` writes a lead's avatar to the private `lead-photos`
 * Supabase bucket at `<instance_id>/<sanitized-slug>.jpg`, where the slug is
 * `sanitize_slug()`'s output — percent-decoded, then every character outside
 * `[A-Za-z0-9_-]` replaced with `_`. The path is stored in `leads.photo_path`,
 * and the agent's docstring states the property this module depends on: the
 * derivation is deterministic, so a photo always joins back to its lead.
 *
 * Two consumers need to agree about where that object lives in R2, and if they
 * agree by convention rather than by construction they will eventually disagree:
 *
 * - **the request path** (`leadPhotoService.ts`) reads `photo_path` out of the
 *   database and mints a signed GET URL for the corresponding object;
 * - **the copy tooling** (`copy.ts`) walks an export of the old bucket and writes
 *   each file to the key the request path will later ask for.
 *
 * A mismatch between those two produces a bucket full of objects nobody fetches
 * and a dashboard of initials — with nothing failing anywhere. So the mapping is
 * exported once, in both directions, and the round trip is a test.
 *
 * ## Why the content type is sniffed rather than taken from the name
 *
 * The agent names every object `.jpg` regardless of what LinkedIn served: the
 * path is `f"{sanitized}.jpg"` while the upload's `content-type` comes from the
 * response headers. So a `.jpg` in the old bucket is routinely a PNG or a WebP,
 * and deriving the type from the extension during a copy would relabel it.
 *
 * That is not a cosmetic mislabel. `policy.ts` signs `content-type` precisely
 * because an object stored under an image key and served as something else is a
 * script delivery channel; a copy that writes a confident, wrong type would
 * undermine the mechanism from the inside. `sniffImageContentType` reads the
 * magic bytes instead, and a file it cannot recognise as one of the three
 * allowed image types is **refused** rather than guessed at — which is also how
 * an HTML error page that was saved into the export with a `.jpg` name gets
 * caught.
 */

import {
  buildTenantObjectKey,
  ObjectKeyError,
  parseTenantObjectKey,
  type ObjectClass,
} from './keys.js'

/** The object class every lead photo belongs to. */
export const LEAD_PHOTO_CLASS: ObjectClass = 'lead-photos'

/**
 * `<instance_id>/<file>` — exactly two segments, because that is what the agent
 * writes. A one-segment path would mean an object outside any notebook and a
 * three-segment path a layout nothing produces; both are refused rather than
 * carried across the copy, because an unexplained shape in the old bucket is a
 * thing to look at, not a thing to mirror.
 */
export const LEAD_PHOTO_SOURCE_SEGMENTS = 2

/** The image types `policy.ts` allows for this class, keyed by magic bytes. */
const IMAGE_SIGNATURES: readonly {
  readonly contentType: 'image/jpeg' | 'image/png' | 'image/webp'
  readonly matches: (bytes: Uint8Array) => boolean
}[] = [
  {
    contentType: 'image/jpeg',
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    contentType: 'image/png',
    matches: (b) =>
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    // RIFF....WEBP — the size field between the two markers is skipped.
    contentType: 'image/webp',
    matches: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
]

/** How many leading bytes a decision needs. WebP's marker ends at byte 12. */
export const IMAGE_SNIFF_BYTES = 12

/**
 * The content type of these bytes, or `null` when they are not one of the three
 * allowed image types.
 *
 * `null` rather than a throw: a caller walking an export wants to report the one
 * unrecognised file and carry on with the rest, and "this is not an image we
 * accept" is an expected finding in a bucket a scraper filled.
 */
export function sniffImageContentType(bytes: Uint8Array): string | null {
  if (bytes.length < IMAGE_SNIFF_BYTES) return null
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.matches(bytes)) return signature.contentType
  }
  return null
}

/**
 * The object key for a `leads.photo_path` value.
 *
 * Every component goes through `buildTenantObjectKey`, so the segment grammar,
 * the class allowlist and the length limit all apply here without being restated
 * — which is the point: this function decides *layout*, and `keys.ts` remains
 * the only place that decides what a legal key looks like.
 */
export function leadPhotoObjectKey(input: {
  readonly tenantId: string
  readonly photoPath: string
}): string {
  const segments = splitSourcePath(input.photoPath)
  return buildTenantObjectKey({
    tenantId: input.tenantId,
    objectClass: LEAD_PHOTO_CLASS,
    segments,
  })
}

/**
 * The inverse: the `photo_path` an object key came from.
 *
 * Needed by the reconciliation direction — given a bucket listing, say which
 * database rows those objects belong to — and by the round-trip test that keeps
 * the two directions from drifting.
 */
export function leadPhotoSourcePath(key: string): string {
  const parsed = parseTenantObjectKey(key)
  if (parsed.objectClass !== LEAD_PHOTO_CLASS) {
    throw new ObjectKeyError(
      `Object key is not a ${LEAD_PHOTO_CLASS} key, so it has no photo_path`,
    )
  }
  if (parsed.segments.length !== LEAD_PHOTO_SOURCE_SEGMENTS) {
    throw new ObjectKeyError(
      `A ${LEAD_PHOTO_CLASS} key has ${LEAD_PHOTO_SOURCE_SEGMENTS} segments ` +
        `after its class; this one has ${parsed.segments.length}`,
    )
  }
  return parsed.segments.join('/')
}

/**
 * True when a value would map to a legal object key.
 *
 * Implemented by attempting the mapping against a placeholder tenant rather than
 * by restating the rules, and that is the whole design of it. The first version
 * checked only the *arity* — two segments — and answered `true` for
 * `notebook-1/%2e%2e%2falice.jpg` and for a path containing a NUL, both of which
 * `leadPhotoObjectKey` refuses. A predicate weaker than the operation it screens
 * for is worse than no predicate: a caller uses it to decide something is safe.
 *
 * The alternative was to re-run the segment grammar here. Rejected: it would have
 * been a second copy of a rule `keys.ts` owns, and a copy that the builder's own
 * check makes unreachable — so a mutation deleting it would redden nothing. One
 * code path cannot disagree with itself.
 */
export function isLeadPhotoSourcePath(value: unknown): boolean {
  try {
    leadPhotoObjectKey({
      // A tenant id that is valid by construction, so the only thing that can
      // fail is the path. It never leaves this function.
      tenantId: 'probe',
      photoPath: value as string,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Split a `photo_path` into key segments, refusing anything the agent would not
 * have written.
 *
 * The arity check is deliberately *here* rather than left to the key builder:
 * the builder accepts any number of segments, so `notebook-1/a/b.jpg` would
 * produce a perfectly legal key for an object no lead points at. Refusing it at
 * the mapping keeps the two directions genuinely inverse.
 */
function splitSourcePath(value: unknown): readonly string[] {
  // No trim check here, and its absence was measured rather than assumed. An
  // earlier version also refused `value.trim() !== value`; the mutation pass
  // showed that deleting it reddened nothing, because leading or trailing
  // whitespace always lands *inside* the first or last segment and the segment
  // grammar refuses it there. A guard that cannot fire is worse than no guard —
  // the next person to loosen the grammar would have no way to learn that their
  // safety net had never been load-bearing.
  if (typeof value !== 'string' || value === '') {
    throw new ObjectKeyError(
      `A lead photo path must be a non-empty string, not ${JSON.stringify(value)}`,
    )
  }
  const segments = value.split('/')
  if (segments.length !== LEAD_PHOTO_SOURCE_SEGMENTS) {
    throw new ObjectKeyError(
      `A lead photo path is <instance_id>/<file>; ${JSON.stringify(value)} has ` +
        `${segments.length} segment(s). Anything else is a layout the sync ` +
        `agent does not produce.`,
    )
  }
  return segments
}
