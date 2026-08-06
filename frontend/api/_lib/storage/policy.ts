/**
 * The signed-operation policy: which operations may be handed to a browser, how
 * long a URL stays valid, and what a client is permitted to upload.
 *
 * ## A signed URL is a bearer token, and that shapes all three limits
 *
 * G0's security note puts it plainly: "a URL is a bearer token until expiry".
 * Whoever holds it has the access it encodes, with no session, no cookie and no
 * further check. Everything in this file follows from that one sentence.
 *
 * ### Which operations are signable — `get` and `put`, not `head` and `delete`
 *
 * R2 can presign GET, PUT, HEAD and DELETE alike, so this is a product decision
 * rather than a provider limit. The test is *who has to perform the request*:
 *
 * - **`get` and `put` must be signable.** The browser fetches the image bytes
 *   and uploads replacements directly. Proxying them through a serverless
 *   function would put every photo byte through a Vercel function's execution
 *   time and memory for no security gain.
 * - **`head` and `delete` must not be.** Nothing in a browser needs to stat or
 *   destroy an object; the server does both while handling a request it has
 *   already authorized. Signing them would mint a durable capability to delete
 *   a tenant's data and hand it to the least trusted party in the system, in
 *   exchange for nothing. `ObjectStorageProvider` therefore exposes `statObject`
 *   and `deleteObject` as *server-performed* operations — see `r2Provider.ts`,
 *   which signs them with a few seconds of validity and consumes the URL itself
 *   without ever returning it.
 *
 * ### Why expiry is bounded at *both* ends
 *
 * A maximum is the obvious half: a long-lived URL that leaks into a log, a
 * `Referer` header or a screenshot stays usable. The maximum here is minutes,
 * because that is all an `<img>` tag needs.
 *
 * A **minimum** is the less obvious half, and it is not a security limit — it
 * is a correctness one. A URL that expires in two seconds is indistinguishable
 * in production from a permissions bug: images fail intermittently, on slow
 * connections first, and the failure looks like anything but a TTL. R2's own
 * floor is one second, which is not a floor worth inheriting.
 *
 * ### Why a size limit needs a *signed* `content-length`
 *
 * This is the non-obvious mechanism in the file. A presigned PUT URL constrains
 * only what its signature covers. If the size is merely checked in application
 * code before the URL is minted, the client receives a URL that will accept a
 * body of *any* length — the check happened on a number the client supplied and
 * can now ignore. There is no `X-Amz-Max-Length` parameter for query signing;
 * the browser-POST form policy has a `content-length-range` condition, but that
 * is a different upload mechanism.
 *
 * So the limit is enforced by signing `content-length` as a required header
 * with an exact value. The upload must then arrive carrying exactly that many
 * bytes or the signature does not verify. That converts "at most N bytes" into
 * "exactly the M bytes you declared, and M ≤ N was checked here" — a strictly
 * stronger guarantee, and the reason `presignPut` demands a byte count instead
 * of treating one as optional.
 *
 * `content-type` is signed for the same reason and against a specific attack:
 * an object stored under an image key but served as `text/html` is a
 * same-origin script if it is ever fetched without a forced disposition. The
 * allowlist is per class and the type is pinned into the signature, so a client
 * cannot declare `image/jpeg` to pass a check and then upload HTML.
 */

import { DataStoreContractError } from '../data/contracts.js'
import type { ObjectClass } from './keys.js'

export class ObjectStoragePolicyError extends DataStoreContractError {
  constructor(message: string) {
    super('OBJECT_STORAGE_POLICY_DENIED', message)
    this.name = 'ObjectStoragePolicyError'
  }
}

/** Operations a client may be handed a URL for. */
export const SIGNABLE_OPERATIONS = ['get', 'put'] as const
export type SignableOperation = (typeof SIGNABLE_OPERATIONS)[number]

/**
 * Operations the server performs itself. Named here so the split is a value
 * the tests can assert on rather than a convention someone has to notice.
 */
export const SERVER_ONLY_OPERATIONS = ['head', 'delete'] as const

/** Below this a URL fails for reasons that will be misdiagnosed. */
export const MIN_SIGNED_URL_TTL_SECONDS = 15

/** Long enough to render a page of avatars, short enough to be worthless later. */
export const MAX_GET_TTL_SECONDS = 15 * 60

/** An upload is a single request the user is waiting on. */
export const MAX_PUT_TTL_SECONDS = 5 * 60

/**
 * How long the adapter's own internally-consumed URLs live. Seconds, because
 * the URL is signed and fetched within one function invocation and never
 * leaves the process.
 */
export const INTERNAL_OPERATION_TTL_SECONDS = 30

export interface ObjectClassPolicy {
  readonly contentTypes: readonly string[]
  readonly maxBytes: number
}

/**
 * Per-class upload rules.
 *
 * `image/webp` is included because LinkedIn serves it; `image/svg+xml` is
 * deliberately absent and must stay absent — SVG is a script container, and an
 * avatar is the one place a stored script would be rendered against every team
 * member's session.
 */
export const OBJECT_CLASS_POLICIES: Readonly<
  Record<ObjectClass, ObjectClassPolicy>
> = {
  'lead-photos': {
    contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 5 * 1024 * 1024,
  },
}

export function maxTtlFor(operation: SignableOperation): number {
  return operation === 'get' ? MAX_GET_TTL_SECONDS : MAX_PUT_TTL_SECONDS
}

/**
 * Refuse a TTL outside the bounds for its operation.
 *
 * Note what this does *not* do: clamp. Silently shortening a caller's 24-hour
 * request to 15 minutes would produce URLs that expire long before the caller
 * believes, which is the same intermittent failure the minimum exists to
 * prevent — arrived at by being helpful.
 */
export function assertSignedUrlTtl(
  operation: SignableOperation,
  ttlSeconds: number,
): number {
  if (!Number.isInteger(ttlSeconds)) {
    throw new ObjectStoragePolicyError(
      `A signed-URL lifetime must be a whole number of seconds, not ` +
        `${JSON.stringify(ttlSeconds)}`,
    )
  }

  const maximum = maxTtlFor(operation)
  if (ttlSeconds < MIN_SIGNED_URL_TTL_SECONDS || ttlSeconds > maximum) {
    throw new ObjectStoragePolicyError(
      `A signed ${operation} URL must live between ` +
        `${MIN_SIGNED_URL_TTL_SECONDS} and ${maximum} seconds; ${ttlSeconds} ` +
        `was requested. The bound is not clamped, because a URL that expires ` +
        `earlier than its caller expects fails intermittently and is ` +
        `diagnosed as anything but a TTL.`,
    )
  }

  return ttlSeconds
}

export function assertUploadContentType(
  objectClass: ObjectClass,
  contentType: unknown,
): string {
  const policy = OBJECT_CLASS_POLICIES[objectClass]

  // Compared exactly, not by prefix: `image/png; charset=x` and
  // `image/png-evil` both start with an allowed value, and the signed header
  // has to be the exact string anyway.
  if (
    typeof contentType !== 'string' ||
    !policy.contentTypes.includes(contentType)
  ) {
    throw new ObjectStoragePolicyError(
      `Content type ${JSON.stringify(contentType)} is not permitted for ` +
        `${objectClass}; allowed: ${policy.contentTypes.join(', ')}`,
    )
  }

  return contentType
}

export function assertUploadSize(
  objectClass: ObjectClass,
  contentLength: unknown,
): number {
  const policy = OBJECT_CLASS_POLICIES[objectClass]

  if (typeof contentLength !== 'number' || !Number.isInteger(contentLength)) {
    throw new ObjectStoragePolicyError(
      `An upload must declare its exact byte count, which is signed into the ` +
        `URL and therefore enforced by the store; received ` +
        `${JSON.stringify(contentLength)}`,
    )
  }
  if (contentLength <= 0) {
    throw new ObjectStoragePolicyError(
      `An upload must declare a positive byte count; ${contentLength} was given`,
    )
  }
  if (contentLength > policy.maxBytes) {
    throw new ObjectStoragePolicyError(
      `An upload of ${contentLength} bytes exceeds the ${policy.maxBytes}-byte ` +
        `limit for ${objectClass}`,
    )
  }

  return contentLength
}
