/**
 * The lead-photo read: lead ids in, signed GET URLs out.
 *
 * ## Why the client sends lead ids and never an object key or a path
 *
 * The Supabase path hands the browser a `photo_path` in every lead row and lets
 * the browser ask Storage for a URL. That is safe *there* because the request
 * carries the user's own JWT and Storage applies RLS to it — the browser naming
 * the object costs nothing, because naming it is not what authorizes it.
 *
 * On this path the credential is the server's, and it is scoped to the bucket
 * rather than to a row. So if the browser named the object, the *only* thing
 * standing between a signed-in member and any key in the class would be string
 * validation. That inverts where authorization lives, and it does it quietly:
 * `keys.ts` would still refuse a traversal and still refuse another tenant, so
 * the tests would pass and the hole would be inside the tenant.
 *
 * Lead ids therefore go in, the database says which of them the actor may see and
 * what their photo paths are, and the key is *derived* here. A client cannot ask
 * for an object it cannot ask for a lead — which is the property the endpoint's
 * forbidden-key tests pin.
 *
 * ## Why one request carries many ids
 *
 * A page of the Leads Explorer renders dozens of avatars at once. The Supabase
 * path spends one Storage call per avatar, which is a direct call to a
 * purpose-built service; the equivalent here would be one *serverless function
 * invocation* per avatar — the same 200 ms actor resolution repeated fifty times,
 * on a Hobby plan with a concurrency cap. So the operation takes a batch, the
 * browser coalesces (`src/lib/leadPhotos.ts`), and the cap is stated rather than
 * discovered.
 *
 * ## What a lead with no photo answers, and why it is not an error
 *
 * Absent. Not `null`, not an error — the lead simply does not appear in the
 * response. `photo_synced_at` with a NULL `photo_path` is the agent's way of
 * recording "checked, LinkedIn had none", which is true of a large share of every
 * campaign, so it is the ordinary case rather than a fault. The avatar falls back
 * to initials exactly as it does today.
 *
 * A key the derivation *refuses* is also absent from the response, and that one is
 * logged: `photo_path` is service-written and every value in it should map, so a
 * refusal means either a path written by something else or a mapping that has
 * drifted from the agent. It must not fail the batch — one bad row would take out
 * every avatar on the page — and it must not be silent.
 */

import { ObjectKeyError } from './keys.js'
import { leadPhotoObjectKey } from './leadPhotoObjects.js'
import { MAX_GET_TTL_SECONDS } from './policy.js'
import type { ObjectStorageProvider } from './provider.js'

/**
 * How long a photo URL lives.
 *
 * Five minutes, which is what `LEAD_PHOTO_SIGNED_URL_TTL_SECONDS` on the Supabase
 * path already uses — the browser's cache-and-refresh logic is written around that
 * number, and the two paths having different lifetimes would make one of them the
 * untested one. Well inside `MAX_GET_TTL_SECONDS`; asserted against it below so a
 * later change to either cannot leave this silently out of policy.
 */
export const LEAD_PHOTO_URL_TTL_SECONDS = 5 * 60

/**
 * The most leads one request may ask about.
 *
 * Bounded by what a page renders, not by what the store could sign: each id costs
 * a signature and a URL in the response body, and an unbounded batch is a way to
 * make one request do arbitrary work. The Leads Explorer's own page size is 50.
 */
export const MAX_PHOTO_BATCH = 100

if (LEAD_PHOTO_URL_TTL_SECONDS > MAX_GET_TTL_SECONDS) {
  // A module-scope check rather than a test, because the failure mode is a
  // deployment that mints URLs the policy would refuse and only finds out on the
  // first request. This makes the import fail instead.
  throw new Error(
    'LEAD_PHOTO_URL_TTL_SECONDS exceeds the signed-GET policy maximum',
  )
}

/** One row of the photo read: a lead and where its photo lives in the old bucket. */
export interface LeadPhotoRow {
  readonly lead_id: string
  readonly photo_path: string | null
}

export interface LeadPhotoUrl {
  readonly leadId: string
  readonly url: string
  readonly expiresAt: string
}

export interface LeadPhotoBatchResult {
  readonly photos: readonly LeadPhotoUrl[]
  /**
   * Ids whose `photo_path` did not map to a legal object key.
   *
   * Returned rather than only logged so the caller decides what to do with them —
   * the endpoint logs a count, and a test can assert the refusal happened at all
   * rather than inferring it from an absence.
   */
  readonly refused: readonly string[]
}

/**
 * Sign a URL for each row that has a photo.
 *
 * Signing is concurrent: the presigner is CPU-bound HMAC work with no I/O, but
 * the *provider* interface is async and a future adapter may do something over the
 * network. Fifty sequential awaits would then become fifty round trips inside one
 * request, so the concurrency is written in now rather than discovered as a
 * regression later.
 */
export async function signLeadPhotoUrls(input: {
  readonly rows: readonly LeadPhotoRow[]
  readonly provider: ObjectStorageProvider
  readonly tenantId: string
  readonly ttlSeconds?: number
}): Promise<LeadPhotoBatchResult> {
  const ttlSeconds = input.ttlSeconds ?? LEAD_PHOTO_URL_TTL_SECONDS
  const photos: LeadPhotoUrl[] = []
  const refused: string[] = []

  // Checked once, before any row, for the reason `copyObjects` checks it: a
  // provider bound to another tenant refuses every key, and without this the
  // caller's single mistake would arrive as "every lead's photo_path is
  // malformed" — a per-row refusal that is both wrong and quiet.
  if (input.provider.tenantId !== input.tenantId) {
    throw new ObjectKeyError(
      `The object storage provider is bound to a different tenant than the ` +
        `photo request was made for`,
    )
  }

  type SignOutcome =
    | { readonly kind: 'none' }
    | { readonly kind: 'refused'; readonly leadId: string }
    | { readonly kind: 'signed'; readonly photo: LeadPhotoUrl }

  const signed: readonly SignOutcome[] = await Promise.all(
    input.rows.map(async (row): Promise<SignOutcome> => {
      if (row.photo_path === null || row.photo_path === '') {
        return { kind: 'none' }
      }

      /**
       * The `try` covers the signing as well as the key derivation, and that is a
       * correction rather than a widening.
       *
       * It wrapped only the derivation first, so the `instanceof ObjectKeyError`
       * narrowing below could never be false — `leadPhotoObjectKey` throws nothing
       * else — and a mutation that turned *every* error into a refused row reddened
       * nothing. The narrowing was decorative: it documented an intention the code
       * could not act on.
       *
       * Now both live inside it and the distinction is load-bearing. A key the
       * grammar refuses is a fact about **this row**, so the row is dropped and the
       * rest of the batch is signed. A provider failure — an outage, a missing
       * credential — is a fact about the **request**, and reporting it per row would
       * tell the caller a lead's path is malformed when the store is simply
       * unreachable. So it propagates and the request fails.
       */
      try {
        const key = leadPhotoObjectKey({
          tenantId: input.tenantId,
          photoPath: row.photo_path,
        })
        const url = await input.provider.presignGet({ key, ttlSeconds })
        return {
          kind: 'signed',
          photo: {
            leadId: row.lead_id,
            url: url.url,
            expiresAt: url.expiresAt,
          },
        }
      } catch (error) {
        if (error instanceof ObjectKeyError) {
          return { kind: 'refused', leadId: row.lead_id }
        }
        throw error
      }
    }),
  )

  for (const result of signed) {
    if (result.kind === 'refused') refused.push(result.leadId)
    if (result.kind === 'signed') photos.push(result.photo)
  }

  return { photos, refused }
}

/**
 * Read `lead_ids` off a query string.
 *
 * Comma-separated, deduplicated, order-insensitive: the browser builds this out of
 * whatever is on screen, so two avatars for the same lead — the Leads Explorer and
 * an open drawer — must not become two signatures.
 */
export function parseLeadIdList(raw: string | null): string[] {
  if (raw === null) return []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed !== '') seen.add(trimmed)
  }
  return [...seen]
}

/** A caller's mistake, which the endpoint turns into a 400. */
export class LeadPhotoRequestError extends Error {}

/** Lowercase-canonical RFC 4122, the same shape the endpoint's reads require. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Validate the request's parameters.
 *
 * **Here rather than in the handler**, and the reason is coverage rather than
 * tidiness: nothing in the offline suite can call the endpoint's `handle` — it
 * resolves an actor against the database first — so a rule written inside the
 * handler is checked by the type checker and the live suite and by nothing that
 * runs on every commit. A mutation to the batch cap in that file would be silent.
 * As a function over a `URL`, every rule below is a test.
 *
 * The uuid check is a *status-code* decision, not a safety one: the ids are query
 * parameters and a malformed one would simply match no row. Refusing here keeps a
 * caller's mistake a 400 rather than a 500 from the `::uuid[]` cast.
 */
export function parseLeadPhotoRequest(url: URL): { readonly leadIds: string[] } {
  const leadIds = parseLeadIdList(url.searchParams.get('lead_ids'))
  if (leadIds.length === 0) {
    throw new LeadPhotoRequestError('lead_ids is required')
  }
  if (leadIds.length > MAX_PHOTO_BATCH) {
    throw new LeadPhotoRequestError(
      `lead_ids must name at most ${MAX_PHOTO_BATCH} leads`,
    )
  }
  for (const leadId of leadIds) {
    if (!UUID_PATTERN.test(leadId)) {
      throw new LeadPhotoRequestError('lead_ids must be UUIDs')
    }
  }
  return { leadIds }
}
