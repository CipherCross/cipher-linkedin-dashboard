/**
 * `GET /api/activity-daily` — the application API's **dispatching read
 * endpoint** (G2 blocker `B3`).
 *
 * It began as S12's single slice and S13 widened it in place. Two things about
 * that are deliberate and neither is cosmetic.
 *
 * **Why one endpoint.** `frontend/api/` holds exactly 12 top-level function
 * files and the Vercel Hobby cap is 12. There is no free slot — S17 had to fold
 * `reclassify.ts` into `classify.ts` to make room for `identity.ts`. So reads
 * are served from one function keyed by an allowlisted operation name, which is
 * what B3 required. A subdirectory would have kept the count assertion in
 * `spikes/s16-identity/tests/serverlessShape.test.ts` green (its `readdirSync`
 * is non-recursive) while the real cap was breached; S17 recorded that trap and
 * refused it, and so does this.
 *
 * **Why the path still says `activity-daily`.** Owner decision, 2026-08-05:
 * extend this file in place rather than rename it and keep the old path alive
 * through a `vercel.json` rewrite. The rewrite would have read better and could
 * not be verified without a deploy; the path name is cosmetic and the
 * *operation names* are the vocabulary that matters. `#/neon-activity` from S12
 * therefore keeps working with no change at all: with no `op` parameter this
 * endpoint behaves exactly as it did, down to the response key.
 *
 * The names below are product operations, not table reads — G2's architectural
 * direction is explicit that this allowlist is the application API's first
 * vocabulary rather than a shim to be replaced later.
 *
 * **`identity.teamRoster` is here now, and the reason it was absent has
 * inverted.** Until S13's switch, the argument against it was that
 * `DataContext` joins its roster against `leads.assigned_to`, which was a
 * *Supabase* `team_members.id` while this endpoint would answer with a Neon one;
 * the two id spaces name different people (`N-B2.md` has the map), so the join
 * mislabels owners without failing anything. That argument held exactly as long
 * as `leads` came from the other provider. Once `leads.directory` answers the
 * dashboard, both ends of the join arrive from *this* database and the integers
 * agree — so the roster must move on the same flag rather than a separate one,
 * and a dashboard reading Neon leads beside no roster at all is the thing that
 * now misreports (it renders "0 Active teammates").
 *
 * Two properties keep the inversion from being a loosening:
 *
 *   * it is `public.team_roster()`, never `public.team_members`. The baseline's
 *     `team_members_active_actor_select` policy restricts `app_runtime` to the
 *     caller's **own row**, so a direct table read would answer with exactly one
 *     member and the page would state "1 Active teammate" — a different
 *     confident lie, purchased with an RLS widening. The function is
 *     `SECURITY DEFINER`, membership-gated, and already granted;
 *   * every other read on this endpoint still may not so much as mention a
 *     roster relation. `tests/dashboardSlice.test.ts` asserts the permission by
 *     name rather than dropping the invariant.
 *
 * Read-only end to end. Every operation reachable from this file is a registered
 * *query*; the store's `query()` runs inside `BEGIN READ ONLY`, and no command
 * is reachable from here at all.
 */

import { authorizationResponse } from './_lib/auth.js'
import { unavailableResponse } from './_lib/data/availability.js'
import {
  DataStoreContractError,
  DataStoreSchemaError,
  PaginationError,
  asUtcTimestamp,
  type ActorContext,
  type DataStore,
  type DataStoreParams,
  type UtcRange,
} from './_lib/data/contracts.js'
import {
  ACTIVITY_OPERATIONS,
  AI_WRITE_OPERATIONS,
  COACHING_OPERATIONS,
  CONVERSATION_OPERATIONS,
  DASHBOARD_OPERATIONS,
  IDENTITY_OPERATIONS,
  LEADS_OPERATIONS,
  LIBRARY_OPERATIONS,
  MESSAGES_OPERATIONS,
  PIPELINE_OPERATIONS,
  ROUTE_SNAPSHOT_OPERATION,
  ROUTE_SNAPSHOT_ROUTES,
  SEQUENCE_HUB_OPERATION,
} from './_lib/data/operations/index.js'
import {
  REPLY_SENTIMENTS,
  REPLY_ACTIONS,
  REPLY_REASON_IDS,
  type ReplyCapability,
  type ReplyFacets,
} from './_lib/replyReview.js'
import { REPLY_REVIEW_OPERATIONS } from './_lib/data/operations/replyReviews.js'
import { dataStoreConfigured } from './_lib/data/neonConfig.js'
import {
  ProviderPathError,
  resolveProviderPath,
} from './_lib/data/providerPath.js'
import { getDataStore } from './_lib/data/store.js'
import { resolveRequestActor } from './_lib/identity/session.js'
import {
  resolveApplicationActor,
  type ApplicationAuthPath,
} from './_lib/identity/application.js'
import type { IdentityProvider } from './_lib/identity/provider.js'
import {
  objectStorageConfigured,
  readObjectStorageTenantId,
} from './_lib/storage/config.js'
import {
  LEAD_PHOTO_URL_TTL_SECONDS,
  LeadPhotoRequestError,
  MAX_PHOTO_BATCH,
  parseLeadPhotoRequest,
  signLeadPhotoUrls,
  type LeadPhotoRow,
} from './_lib/storage/leadPhotoService.js'
import { getObjectStorageProvider } from './_lib/storage/runtime.js'

export const maxDuration = 10

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

/** Inclusive UTC calendar day, exactly as `frontend/src/lib/leads.ts` spells it. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const MAX_LIMIT = 1_000

/**
 * Convert the client's inclusive `[from, to]` UTC day pair — the shape
 * `presetRanges` in `frontend/src/lib/leads.ts` produces — into the contract's
 * half-open `[fromInclusive, toExclusive)` instant range.
 *
 * The only subtlety is the upper bound, and it is the one place an off-by-one
 * day would hide: `leads.ts` treats `to` as **inclusive**, the contract's
 * `toExclusive` is **exclusive**, so `to` becomes midnight UTC of the *next*
 * day. `2026-03-01 .. 2026-03-03` therefore denotes
 * `[2026-03-01T00:00:00Z, 2026-03-04T00:00:00Z)` — three days, the same three
 * days the client would keep when it compares `day` strings.
 *
 * Exported for the tests that assert this against `leads.ts` itself rather than
 * against a restatement of it.
 */
export function dayRangeToUtcRange(
  from: string | null,
  to: string | null,
): UtcRange | undefined {
  if (from === null && to === null) return undefined

  const range: { fromInclusive?: string; toExclusive?: string } = {}
  if (from !== null) range.fromInclusive = `${from}T00:00:00Z`
  if (to !== null) {
    const next = new Date(`${to}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    range.toExclusive = next.toISOString()
  }

  return {
    fromInclusive:
      range.fromInclusive === undefined
        ? undefined
        : asUtcTimestamp(range.fromInclusive),
    toExclusive:
      range.toExclusive === undefined
        ? undefined
        : asUtcTimestamp(range.toExclusive),
  }
}

function readDay(value: string | null, name: string): string | null {
  if (value === null || value === '') return null
  if (!DAY_PATTERN.test(value)) {
    throw new BadRequest(`${name} must be a UTC calendar day (YYYY-MM-DD)`)
  }
  // Reject 2026-02-30 and friends: the round trip has to be lossless.
  const parsed = new Date(`${value}T00:00:00Z`)
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new BadRequest(`${name} is not a real calendar day: ${value}`)
  }
  return value
}

class BadRequest extends Error {}

/**
 * What is safe to put in a log line.
 *
 * The driver wraps a failure as `` `${what}: ${originalMessage}` ``, and for a
 * connection-level failure the original message is the raw driver text — which
 * embeds the database hostname (`getaddrinfo ENOTFOUND <host>`). So neither the
 * error object nor its `message` may be logged. The contract error's `code` and
 * `name` are adapter-owned constants and carry no provider detail, which is
 * enough to classify the failure without leaking where the database lives.
 */
export function safeErrorLabel(error: unknown): string {
  if (error instanceof DataStoreContractError) {
    return `${error.name}/${error.code}`
  }
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

/** SQLSTATE is a five-character PostgreSQL standard code and contains no SQL,
 * values, hostnames or credentials. Keep it separate from the driver message so
 * production can distinguish a timeout from a malformed aggregate safely. */
export function safeSqlState(error: unknown): string | null {
  if (!(error instanceof DataStoreContractError)) return null
  const cause = (error as Error & { cause?: unknown }).cause
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return null
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null
}

// ---------------------------------------------------------------------------
// The read-path flag (`config.readPath`).
// ---------------------------------------------------------------------------

export type ReadPath = 'supabase' | 'neon'

/**
 * The flag lookup's operation name. In the same vocabulary as the reads, so a
 * client asks for it the same way it asks for anything else — but it is
 * dispatched before authentication and never reaches the store.
 */
export const CONFIG_READ_PATH_OPERATION = 'config.readPath'

export const NEON_READS_ENV = 'NEON_READS_DEFAULT'

/**
 * The deployment's default read path, for a browser that has not overridden it.
 *
 * **S27 inverted the default.** It used to be off unless a deployment said
 * exactly `neon` — right while Neon was the thing being proved, wrong now that
 * Supabase is the thing being removed. It is now `neon` wherever the deployment
 * holds `NEON_DATABASE_URL`, `supabase` where it does not, and `supabase` where a
 * deployment says so explicitly. `_lib/data/providerPath.ts` carries the whole
 * argument, including why the default is *derived from the credential* rather
 * than simply flipped: a plain inversion would have taken a deployment with no
 * Neon credential down on the next deploy, since every read would have resolved
 * a store that cannot exist.
 *
 * It shares that resolver with the write and AI flags rather than restating the
 * rule, because the three drifting apart is exactly how a deployment ends up
 * reading one provider and writing another.
 */
export function deploymentReadPath(env = process.env): ReadPath {
  return resolveProviderPath(NEON_READS_ENV, env[NEON_READS_ENV], () =>
    dataStoreConfigured(env),
  )
}

// ---------------------------------------------------------------------------
// The photo-path flag (S20)
// ---------------------------------------------------------------------------

/**
 * `disabled` is a deliberate deployment posture, not a missing configuration.
 * It keeps the existing objects intact while ensuring this application neither
 * signs nor reads them. The UI renders initials for it without issuing a photo
 * request.
 */
export type PhotoPath = 'disabled' | 'supabase' | 'neon'

export const NEON_PHOTOS_ENV = 'NEON_PHOTOS_DEFAULT'

/** The three values the photo flag accepts, for its refusal message. */
const PHOTO_PATH_VALUES = ['neon', 'supabase', 'disabled'] as const

/**
 * Which lead-photo path this deployment serves. Reported beside `readPath` by the
 * same unauthenticated lookup.
 *
 * **Why this one does not simply call the shared resolver.** It has a third legal
 * value and two conditions the other flags have no equivalent of, so it borrows
 * the resolver's *rules* — derive the unset case, refuse an unrecognised value —
 * and keeps its own conditions on top:
 *
 * 1. **`disabled` is answered first and unconditionally.** It is a deployment
 *    posture, not a provider: initials only, no storage call and no application
 *    photo request. Every tenant the control plane onboards binds exactly this
 *    (`s26.application-hosting.v1`), so it must never be reached through a
 *    condition that could downgrade it to a provider.
 * 2. **The read path must already be `neon`.** Not a policy, a *correctness*
 *    requirement, and the subtlest thing in this file. The browser asks for photos
 *    by `lead.id`, and a lead id means different rows in the two providers —
 *    `N-B2.md` records that the id spaces name different people. A dashboard
 *    reading Supabase leads while asking Neon for their photos would therefore
 *    render other people's faces against the wrong names. It would look like a
 *    caching bug and it would be a privacy incident.
 * 3. **Object storage must resolve.** Checked rather than assumed, because the
 *    flag's whole job is to keep a working dashboard working: a deployment that
 *    opts in before the bucket exists reports `supabase` and renders initials,
 *    instead of asking an endpoint that can only 503.
 *
 * Conditions 2 and 3 hold an **explicit** `neon` to the same bar as a derived
 * one, and that is a deliberate difference from the other flags, where a stated
 * `neon` without a credential fails loudly. Photos are cosmetic: degrading to
 * initials is the honest outcome, whereas failing the flag lookup over them would
 * take down a dashboard whose data is fine. What is *not* tolerated is a value
 * nobody recognises — see the resolver on why a typo must not choose a provider.
 */
export function deploymentPhotoPath(env = process.env): PhotoPath {
  const value = (env[NEON_PHOTOS_ENV] ?? '').trim()
  if (value === 'disabled') return 'disabled'
  if (value !== '' && value !== 'neon' && value !== 'supabase') {
    throw new ProviderPathError(NEON_PHOTOS_ENV, PHOTO_PATH_VALUES)
  }
  if (value === 'supabase') return 'supabase'
  if (deploymentReadPath(env) !== 'neon') return 'supabase'
  return objectStorageConfigured(env) ? 'neon' : 'supabase'
}

/**
 * `config.readPath` is the one operation on this endpoint that is **not**
 * authenticated, and that is a decision rather than an oversight.
 *
 * It reads no database, touches no store and returns one enum. Requiring an
 * actor would mean resolving one against Neon — so a dashboard running on the
 * *Supabase* path would have to reach Neon successfully just to be told to keep
 * using Supabase, and a Neon outage or a missing credential would take the
 * working dashboard down. The invariant is that every Supabase read that works
 * today still works, so the flag lookup must not be able to break it.
 *
 * What it discloses is which read path a deployment defaults to. That is not a
 * secret, it is not a capability, and it is inferable from timing anyway.
 */
function readPathResponse(env = process.env): Response {
  try {
    // `photoPath` rides along on the same lookup rather than taking an operation
    // of its own. The browser needs both before it renders anything, they are
    // decided by the same deployment, and a second unauthenticated round trip at
    // startup would buy nothing — the field is additive, so a browser built
    // before S20 ignores it and keeps the Supabase photo path.
    return json({
      readPath: deploymentReadPath(env),
      photoPath: deploymentPhotoPath(env),
    })
  } catch (error) {
    const refusal = providerPathRefusal(error)
    if (refusal) return refusal
    throw error
  }
}

/**
 * A refused path flag, answered instead of thrown.
 *
 * Since S27 an unrecognised flag value is a refusal rather than a guess, and this
 * endpoint is where a browser meets it first. Letting it escape would surface as
 * a body-less platform 500, so the misconfiguration would be diagnosable only
 * from the function log — the exact failure mode step 2 of this migration was
 * spent removing. The message names the variable and the legal values and
 * discloses nothing else; which provider a deployment serves is already this
 * operation's answer.
 */
function providerPathRefusal(error: unknown): Response | null {
  if (!(error instanceof ProviderPathError)) return null
  console.error('Provider path flag refused:', error.variable)
  return json({ error: error.message, variable: error.variable }, 500)
}


/**
 * `leads.photoUrls` — the one operation on this endpoint that is not a plain
 * registered read, and the shape of that exception.
 *
 * It is dispatched separately rather than added to `READ_OPERATIONS` because it
 * does something no entry in that table does: it runs a registered read *and then*
 * calls an object-storage provider, and answers with signed URLs instead of a page
 * of rows. Folding it into the generic path would have meant giving every read a
 * post-processing hook, which is a larger and vaguer change than one branch.
 *
 * What it keeps from the generic path, deliberately: the same resolved actor, the
 * same store, and a registered operation name for its SQL. The only thing it adds
 * is what happens to the rows afterwards.
 */
export const LEAD_PHOTO_URLS_OPERATION = 'leads.photoUrls'

async function leadPhotoUrlsResponse(
  url: URL,
  actor: Awaited<ReturnType<typeof resolveRequestActor>>['actor'],
): Promise<Response> {
  let leadIds: readonly string[]
  try {
    leadIds = parseLeadPhotoRequest(url).leadIds
  } catch (error) {
    if (error instanceof LeadPhotoRequestError) {
      return json({ error: error.message }, 400)
    }
    throw error
  }

  // Resolved before the database is touched: an unconfigured storage layer is a
  // deployment fault, and reading rows we cannot sign a URL for would be work
  // thrown away. 503 rather than 500 — the request is well-formed and the server
  // is not able to serve it yet, which is also what tells the browser's loader to
  // fall back to initials rather than to retry.
  let tenantId: string
  let provider
  try {
    tenantId = readObjectStorageTenantId()
    provider = getObjectStorageProvider(tenantId)
  } catch (error) {
    console.error('Object storage is not configured:', safeErrorLabel(error))
    return json({ error: 'Object storage is not configured' }, 503)
  }

  let rows: readonly LeadPhotoRow[]
  try {
    const page = await getDataStore().query<LeadPhotoRow>(actor, {
      operation: LEADS_OPERATIONS.photoObjects,
      // The array parameter this registry's only non-scalar. See the operation.
      params: { leadIds } as unknown as DataStoreParams,
      page: { limit: MAX_PHOTO_BATCH, cursor: null },
    })
    rows = page.items
  } catch (error) {
    if (error instanceof DataStoreContractError) {
      console.error('Lead photo read failed:', safeErrorLabel(error))
      const unavailable = unavailableResponse(error)
      if (unavailable) return unavailable
      return json({ error: 'Could not load lead photos' }, 500)
    }
    throw error
  }

  try {
    const { photos, refused } = await signLeadPhotoUrls({
      rows,
      provider,
      tenantId,
    })
    if (refused.length > 0) {
      // A count, never the paths: this is a log line and the values came from a
      // column. That some rows are unmappable is the fact worth seeing; which
      // ones is a query somebody runs deliberately.
      console.warn(
        `Lead photo paths refused by the key grammar: ${refused.length}`,
      )
    }
    // `photos`, not `items`: the response is not a page and does not paginate, so
    // borrowing the paged shape would advertise a cursor that will never exist.
    return json({ photos, ttlSeconds: LEAD_PHOTO_URL_TTL_SECONDS })
  } catch (error) {
    console.error('Lead photo signing failed:', safeErrorLabel(error))
    return json({ error: 'Could not sign lead photo URLs' }, 503)
  }
}

// ---------------------------------------------------------------------------
// The operation allowlist.
// ---------------------------------------------------------------------------

interface ReadOperationSpec {
  /** The registered operation name in `frontend/api/_lib/data/operations/`. */
  readonly operation: string
  /**
   * Read this operation's parameters out of the query string, or throw
   * `BadRequest`. Absent means the operation takes none — and an operation with
   * no parameters is refused nothing, because there is nothing to validate.
   */
  readonly params?: (url: URL) => DataStoreParams
  /** Whether `from`/`to` day bounds apply. */
  readonly ranged?: boolean
  /**
   * Answer an *absent relation* with an empty page and `unavailable: true`
   * instead of failing the request.
   *
   * This is the API's half of a behaviour `DataContext` already has: it excludes
   * ten reads from the error it reports and takes `data ?? []`, so a database
   * missing a not-yet-applied table renders a blank Search Library or an
   * unavailable follow-up queue rather than an empty dashboard. Moving those
   * reads behind an endpoint that 500s on the same input would have been a
   * regression against today, on relations no funnel number depends on.
   *
   * Three properties keep it from being a blanket "ignore errors":
   *
   * 1. **It triggers on `DataStoreSchemaError` alone** — the adapter's
   *    translation of SQLSTATE 42P01. A privilege denial, a statement timeout, a
   *    bad cursor or a connection failure is unaffected and still fails.
   * 2. **It is per operation, listed once, and asserted.** The funnel reads are
   *    not tolerant, because for them an empty answer is a *wrong* answer rather
   *    than a blank panel; `tests/dashboardSlice.test.ts` pins which reads carry
   *    this and which do not.
   * 3. **The response says which happened.** `items: []` with no marker means the
   *    relation is there and empty; `unavailable: true` means it is absent. The
   *    follow-up reads need that distinction to survive the move — an empty queue
   *    and a pre-migration database look identical in an array, and today's UI
   *    already distinguishes them (`followUpsAvailable`).
   */
  readonly tolerateMissingRelation?: boolean
}

const REPLY_VIEWS = ['all', 'unreviewed', 'needs_reply', 'deferred', 'completed'] as const
const REPLY_SCOPES = ['new', 'historical', 'all'] as const
const REPLY_DIRECTIONS = ['around', 'older', 'newer'] as const

function readRequiredEnumValue(url: URL, name: string, allowed: readonly string[], fallback: string): string {
  const raw = (url.searchParams.get(name) ?? '').trim()
  const value = raw === '' ? fallback : raw
  if (!allowed.includes(value)) throw new BadRequest(`${name} is not an allowed value`)
  return value
}

function readReplyFlag(url: URL, name: string): boolean {
  const raw = (url.searchParams.get(name) ?? '').trim().toLowerCase()
  if (raw === '') return false
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  throw new BadRequest(`${name} must be a boolean`)
}

function readReplyCursor(url: URL): string | null {
  const raw = (url.searchParams.get('cursor') ?? '').trim()
  if (raw === '') return null
  if (raw.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new BadRequest('cursor must be an opaque token')
  }
  return raw
}

function readReplyMetricScope(url: URL): string | null {
  const raw = (url.searchParams.get('metric_scope') ?? '').trim()
  if (!raw) return null
  const separator = raw.indexOf(':')
  const kind = separator < 0 ? raw : raw.slice(0, separator)
  const value = separator < 0 ? '' : raw.slice(separator + 1)
  const sentimentValues = new Set<string>([
    ...REPLY_SENTIMENTS, 'latest_unreviewed', 'only_auto', 'business_rate', 'negative_objection',
  ])
  const reasonValues = new Set<string>([...REPLY_REASON_IDS, 'missing_reason'])
  const workflowValues = new Set<string>([
    ...REPLY_ACTIONS, 'do_not_contact', 'transfers', 'needs_confirmation', 'overdue', 'follow_up_today', 'follow_up_later',
  ])
  const coverageValues = new Set<string>([
    'dialogues', 'full_dialogues', 'messages', 'unreviewed_dialogues', 'unreviewed_intent',
    'legacy_ai', 'weekly_volume', 'weekly_messages', 'latest_unreviewed', 'only_auto',
  ])
  const allowed = kind === 'sentiment'
    ? sentimentValues.has(value)
    : kind === 'reason'
      ? reasonValues.has(value)
      : kind === 'workflow'
        ? workflowValues.has(value)
        : kind === 'coverage'
          ? coverageValues.has(value)
          : false
  if (!allowed || value.length > MAX_KEY_LENGTH) {
    throw new BadRequest('metric_scope must be kind:value with an allowed kind')
  }
  return `${kind}:${value}`
}

function readReplyOwner(url: URL): number | null {
  const raw = (url.searchParams.get('owner_id') ?? '').trim()
  if (!raw || raw === 'all' || raw === 'unassigned') return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new BadRequest('owner_id must be a positive integer')
  return value
}

function readReplyLimit(url: URL, fallback: number): number {
  const raw = (url.searchParams.get('limit') ?? '').trim()
  const value = raw === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new BadRequest('limit must be an integer between 1 and 100')
  return value
}

function readReplyBounds(url: URL, required: boolean): { from: string | null; to: string | null; range: UtcRange | undefined } {
  const from = readDay(url.searchParams.get('from'), 'from')
  const to = readDay(url.searchParams.get('to'), 'to')
  if (required && (from === null || to === null)) throw new BadRequest('from and to are required')
  if (from !== null && to !== null && from > to) throw new BadRequest('from must not be after to')
  return { from, to, range: dayRangeToUtcRange(from, to) }
}

function readReplyInbox(url: URL): DataStoreParams {
  const bounds = readReplyBounds(url, false)
  return {
    scope: readRequiredEnumValue(url, 'scope', REPLY_SCOPES, 'new'),
    view: readRequiredEnumValue(url, 'view', REPLY_VIEWS, 'unreviewed'),
    captureStartedAt: null,
    instanceId: readOptionalBoundedText(url, 'instance_id'),
    campaignId: readOptionalBoundedText(url, 'campaign_id'),
    ownerId: readReplyOwner(url),
    sentiment: readOptionalEnum(url, 'sentiment', REPLY_SENTIMENTS),
    reasonId: readOptionalEnum(url, 'reason_id', REPLY_REASON_IDS),
    action: readOptionalEnum(url, 'action', REPLY_ACTIONS),
    query: readOptionalSearch(url),
    unacknowledged: readReplyFlag(url, 'unacknowledged'),
    unowned: readReplyFlag(url, 'unowned'),
    overdue: readReplyFlag(url, 'overdue'),
    my: readReplyFlag(url, 'my'),
    currentActorId: null,
    from: bounds.range?.fromInclusive ?? null,
    to: bounds.range?.toExclusive ?? null,
    metricScope: readReplyMetricScope(url),
    cursor: readReplyCursor(url),
    limit: readReplyLimit(url, 50),
  }
}

function readReplyThread(url: URL): DataStoreParams {
  const focusRaw = (url.searchParams.get('focus_message_id') ?? url.searchParams.get('focus') ?? '').trim()
  const focus = focusRaw === '' ? null : Number(focusRaw)
  if (focus !== null && (!Number.isSafeInteger(focus) || focus <= 0)) throw new BadRequest('focus_message_id must be a positive integer')
  const directionRaw = (url.searchParams.get('direction') ?? '').trim()
  if (directionRaw && !REPLY_DIRECTIONS.includes(directionRaw as typeof REPLY_DIRECTIONS[number])) throw new BadRequest('direction is not an allowed value')
  return {
    instanceId: readRequiredText(url, 'instance_id'),
    profileUrl: readRequiredText(url, 'profile_url'),
    focusMessageId: focus,
    direction: directionRaw || (focus === null ? null : 'around'),
    cursor: readReplyCursor(url),
    limit: readReplyLimit(url, 50),
  }
}

function readReplyHistory(url: URL): DataStoreParams {
  const thread = readReplyThread(url)
  const messageRaw = (url.searchParams.get('message_id') ?? '').trim()
  const messageId = messageRaw === '' ? null : Number(messageRaw)
  if (messageId !== null && (!Number.isSafeInteger(messageId) || messageId <= 0)) throw new BadRequest('message_id must be a positive integer')
  return { ...thread, messageId, limit: readReplyLimit(url, 50) }
}

function readReplyAnalytics(url: URL): DataStoreParams {
  const bounds = readReplyBounds(url, true)
  return {
    from: bounds.range?.fromInclusive ?? null,
    to: bounds.range?.toExclusive ?? null,
    instanceId: readOptionalBoundedText(url, 'instance_id'),
    campaignId: readOptionalBoundedText(url, 'campaign_id'),
    ownerId: readReplyOwner(url),
    metricBase: readOptionalEnum(url, 'metric_base', ['dialogues', 'messages', 'manual_dialogues', 'manual_messages']),
    limit: 1,
  }
}

const replyFacets = (owners: readonly { id: number; name?: string }[] = []) => ({
  owners: owners.map((owner) => ({ id: owner.id, name: owner.name ?? String(owner.id), count: 0 })),
  accounts: [], campaigns: [],
  actions: REPLY_ACTIONS.map((value) => ({ value, count: 0 })),
  sentiments: REPLY_SENTIMENTS.map((value) => ({ value, count: 0 })),
  reasons: REPLY_REASON_IDS.map((value) => ({ value, count: 0 })),
})

async function readReplyCapability(store: DataStore, actor: ActorContext) {
  try {
    const page = await store.query<ReplyCapability>(actor, {
      operation: REPLY_REVIEW_OPERATIONS.capabilities,
      params: { probe: null },
      page: { limit: 1 },
    })
    const base = page.items[0] ?? {
      available: false, active: false, manual_ready: false, mode: null,
      schema_version: null, capture_started_at: null, activated_at: null,
      activation_in_progress: false, activation_cursor: 0, activation_processed: 0,
      activation_total: 0, activation_cutoff: null, activation_batch_size: null,
      activation_mutation_id: null, reason: 'schema_unavailable' as const,
    }
    const [roster, instances, campaigns, facetsPage] = await Promise.all([
      store.query<unknown>(actor, { operation: IDENTITY_OPERATIONS.teamRoster, page: { limit: 200 } }),
      store.query<unknown>(actor, { operation: DASHBOARD_OPERATIONS.instancesOverview, page: { limit: 200 } }),
      store.query<unknown>(actor, { operation: DASHBOARD_OPERATIONS.campaignsPerformance, page: { limit: 1_000 } }),
      store.query<ReplyFacets>(actor, {
        operation: REPLY_REVIEW_OPERATIONS.facets,
        params: {
          scope: 'all', view: 'all', captureStartedAt: null,
          instanceId: null, campaignId: null, ownerId: null,
          sentiment: null, reasonId: null, action: null, query: null,
          unacknowledged: false, unowned: false, overdue: false, my: false,
          currentActorId: actor.actorId, from: null, to: null, metricScope: null,
        },
        page: { limit: 1 },
      }),
    ])
    const members = roster.items.map((row) => {
      const value = row as Record<string, unknown>
      return { id: Number(value.id), name: String(value.name ?? value.label ?? value.id), active: value.active !== false }
    })
    const accountRows = instances.items.map((row) => {
      const value = row as Record<string, unknown>
      return { id: String(value.id), label: String(value.label ?? value.account_name ?? value.id) }
    })
    const campaignRows = campaigns.items.map((row) => {
      const value = row as Record<string, unknown>
      return { id: String(value.campaign_id), name: String(value.campaign_name ?? value.campaign_id), instance_id: String(value.instance_id ?? '') }
    })
    return json({
      ...base,
      members,
      instances: accountRows,
      campaigns: campaignRows,
      facets: facetsPage.items[0] ?? replyFacets(members),
    })
  } catch (error) {
    if (error instanceof DataStoreSchemaError) {
      return json({
        available: false,
        active: false,
        manual_ready: false,
        mode: null,
        reason: 'schema_unavailable',
        unavailable_reason: 'Manual reply review is unavailable for this tenant.',
        members: [],
        instances: [],
        campaigns: [],
        facets: replyFacets(),
      })
    }
    throw error
  }
}

function requireReplyManualCapability(capability: ReplyCapability): void {
  if (!capability.available || capability.mode !== 'manual' || !capability.manual_ready || capability.activation_in_progress) {
    throw new DataStoreSchemaError('manual reply review is not active')
  }
}

function nextReplyFocus(items: readonly unknown[], requested: number | null | undefined): number | null {
  if (requested != null) return requested
  const inbound = items
    .map((item) => item as Record<string, unknown>)
    .filter((item) => item.direction === 'in')
  const pending = inbound.find((item) => {
    const review = item.review && typeof item.review === 'object' ? item.review as Record<string, unknown> : null
    return review?.complete !== true
  })
  const candidate = pending ?? inbound[0]
  const id = candidate?.id
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null
}

async function replyReadResponse(
  store: DataStore,
  actor: ActorContext,
  op: string,
  params: DataStoreParams,
): Promise<Response> {
  if (op === REPLY_REVIEW_OPERATIONS.capabilities) return readReplyCapability(store, actor)
  const capabilityPage = await store.query<ReplyCapability>(actor, {
    operation: REPLY_REVIEW_OPERATIONS.capabilities,
    params: { probe: null }, page: { limit: 1 },
  })
  const capability = capabilityPage.items[0]
  if (!capability) throw new DataStoreSchemaError('manual reply review settings are unavailable')
  requireReplyManualCapability(capability)

  if (op === REPLY_REVIEW_OPERATIONS.inbox) {
    const { cursor, limit, ...operationParams } = params as DataStoreParams & { cursor?: string | null; limit?: number }
    const page = await store.query<unknown>(actor, {
      operation: op, params: { ...operationParams, captureStartedAt: capability.capture_started_at, currentActorId: actor.actorId },
      page: { limit: Number(limit ?? 50), cursor: cursor ?? null },
    })
    const facetsPage = await store.query<ReplyFacets>(actor, {
      operation: REPLY_REVIEW_OPERATIONS.facets,
      params: { ...operationParams, captureStartedAt: capability.capture_started_at, currentActorId: actor.actorId, cursor: null, limit: 1 },
      page: { limit: 1, cursor: null },
    })
    const facets = facetsPage.items[0] ?? replyFacets()
    return json({ items: page.items, next_cursor: page.nextCursor, facets, scope: operationParams.scope ?? 'new' })
  }

  if (op === REPLY_REVIEW_OPERATIONS.thread) {
    const threadParams = params as DataStoreParams & { cursor?: string | null; limit?: number; focusMessageId?: number | null }
    const exists = await store.query<{ exists: boolean }>(actor, { operation: REPLY_REVIEW_OPERATIONS.threadExists, params: { instanceId: threadParams.instanceId, profileUrl: threadParams.profileUrl }, page: { limit: 1 } })
    if (!exists.items[0]?.exists) return json({ error: 'The requested thread was not found', code: 'REPLY_REVIEW_NOT_FOUND' }, 404)
    if (threadParams.focusMessageId != null) {
      const focus = await store.query(actor, { operation: REPLY_REVIEW_OPERATIONS.messageForReview, params: { instanceId: threadParams.instanceId, profileUrl: threadParams.profileUrl, messageId: threadParams.focusMessageId }, page: { limit: 1 } })
      if (!focus.items[0]) return json({ error: 'The requested focus message was not found', code: 'REPLY_REVIEW_NOT_FOUND' }, 404)
    }
    const [workflowPage, revisionPage] = await Promise.all([
      store.query<unknown>(actor, {
        operation: REPLY_REVIEW_OPERATIONS.workflowForThread,
        params: { instanceId: threadParams.instanceId, profileUrl: threadParams.profileUrl },
        page: { limit: 1 },
      }),
      store.query<{ inbound_revision: number }>(actor, {
        operation: REPLY_REVIEW_OPERATIONS.inboundRevision,
        params: { instanceId: threadParams.instanceId, profileUrl: threadParams.profileUrl },
        page: { limit: 1 },
      }),
    ])
    const workflow = workflowPage.items[0] ?? null
    const inboundRevision = Number(revisionPage.items[0]?.inbound_revision ?? 0)
    const { cursor, limit, direction, focusMessageId, ...baseParams } = threadParams
    const requestedLimit = Number(limit ?? 50)
    const hasFocus = focusMessageId !== null && focusMessageId !== undefined
    const hasCursor = cursor !== null && cursor !== undefined

    // The first focused response is a bounded window around the focus.  The
    // thread operation's directional queries are deliberately separate: one
    // cursor must never be minted from an ASC page and then reused as the
    // opposite direction.  Older rows arrive newest-first, so reverse them
    // before combining with the newer side and the focus row.
    if (hasFocus && !hasCursor && (!direction || direction === 'around')) {
      const half = Math.max(1, Math.floor(requestedLimit / 2))
      const [olderPage, newerPage] = await Promise.all([
        store.query<unknown>(actor, {
          operation: op,
          params: { ...baseParams, focusMessageId: focusMessageId ?? null, direction: 'older' },
          page: { limit: half, cursor: null },
        }),
        store.query<unknown>(actor, {
          operation: op,
          params: { ...baseParams, focusMessageId: focusMessageId ?? null, direction: 'newer' },
          page: { limit: Math.max(1, requestedLimit - half), cursor: null },
        }),
      ])
      const olderItems = [...olderPage.items].reverse()
      const combined = [...olderItems, ...newerPage.items]
      const deduped = [...new Map(combined.map((item) => [String((item as Record<string, unknown>).id), item])).values()]
      const first = deduped[0] as Record<string, unknown> | undefined
      const last = deduped[deduped.length - 1] as Record<string, unknown> | undefined
      return json({
        instance_id: threadParams.instanceId,
        profile_url: threadParams.profileUrl,
        messages: deduped,
        older_cursor: olderPage.nextCursor,
        newer_cursor: newerPage.nextCursor,
        focus_message_id: focusMessageId,
        next_focus_message_id: nextReplyFocus(deduped, focusMessageId),
        workflow,
        inbound_revision: inboundRevision,
        has_older: olderPage.hasMore || first?.has_older === true,
        has_newer: newerPage.hasMore || last?.has_newer === true,
      })
    }

    const page = await store.query<unknown>(actor, {
      operation: op,
      params: { ...baseParams, focusMessageId: focusMessageId ?? null, direction: direction ?? 'older' },
      page: { limit: requestedLimit, cursor: cursor ?? null },
    })
    const items = direction === 'older' || (!direction && !hasFocus) ? [...page.items].reverse() : page.items
    const first = items[0] as Record<string, unknown> | undefined
    const last = items[items.length - 1] as Record<string, unknown> | undefined
    const older = direction === 'newer' ? null : page.nextCursor
    const newer = direction === 'newer' ? page.nextCursor : null
    return json({
      instance_id: threadParams.instanceId,
      profile_url: threadParams.profileUrl,
      messages: items,
      older_cursor: older,
      newer_cursor: newer,
      focus_message_id: focusMessageId ?? null,
      next_focus_message_id: nextReplyFocus(items, focusMessageId),
      workflow,
      inbound_revision: inboundRevision,
      has_older: direction === 'newer' ? first?.has_older === true : page.hasMore || first?.has_older === true,
      has_newer: direction === 'older' ? last?.has_newer === true : page.hasMore || last?.has_newer === true,
    })
  }

  if (op === REPLY_REVIEW_OPERATIONS.reviewHistory) {
    const { cursor, limit, ...operationParams } = params as DataStoreParams & { cursor?: string | null; limit?: number }
    const page = await store.query<unknown>(actor, { operation: op, params: operationParams, page: { limit: Number(limit ?? 50), cursor: cursor ?? null } })
    return json({ items: page.items, next_cursor: page.nextCursor })
  }

  const page = await store.query<unknown>(actor, { operation: op, params, page: { limit: 1 } })
  return json({ items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore })
}

/**
 * Every read this endpoint offers, and the only names it will accept.
 *
 * An allowlist keyed by name rather than a pass-through to the registry: the
 * registry also holds the identity operations and the three admin *commands*,
 * and a dispatcher that forwarded any registered name would expose them the
 * moment one was added. This list is the endpoint's own surface.
 */
const READ_OPERATIONS: Readonly<Record<string, ReadOperationSpec>> = {
  [DASHBOARD_OPERATIONS.bootstrap]: {
    operation: DASHBOARD_OPERATIONS.bootstrap,
  },
  [DASHBOARD_OPERATIONS.overviewSystemTotals]: {
    operation: DASHBOARD_OPERATIONS.overviewSystemTotals,
    ranged: true,
  },
  [DASHBOARD_OPERATIONS.overviewSummary]: {
    operation: DASHBOARD_OPERATIONS.overviewSummary,
    ranged: true,
  },
  [ROUTE_SNAPSHOT_OPERATION]: {
    operation: ROUTE_SNAPSHOT_OPERATION,
    params: (url) => {
      const route = readOptionalEnum(url, 'route', ROUTE_SNAPSHOT_ROUTES)
      if (route === null) throw new BadRequest('route is required')
      const routeId = readOptionalBoundedText(url, 'route_id')
      if ((route === 'account' || route === 'campaign') && routeId === null) {
        throw new BadRequest('route_id is required for detail routes')
      }
      const compareValue = route === 'campaign'
        ? readOptionalBoundedText(url, 'compare_ids')
        : null
      const compareParts = [...new Set((compareValue ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value && value !== routeId))]
      if (compareParts.length > 8) throw new BadRequest('compare_ids accepts at most 8 campaigns')
      const compareIds = compareParts.join(',') || null
      return { route, routeId, compareIds }
    },
  },
  [SEQUENCE_HUB_OPERATION]: {
    operation: SEQUENCE_HUB_OPERATION,
  },
  [ACTIVITY_OPERATIONS.dailySeries]: {
    operation: ACTIVITY_OPERATIONS.dailySeries,
    ranged: true,
    // Optional here, unlike on the legacy path below: `DataContext` reads the
    // whole team's activity at once, and one request per notebook would pay the
    // request cost N times for a filter the caller does not want.
    params: (url) => ({ instanceId: readOptionalInstance(url) }),
  },
  [DASHBOARD_OPERATIONS.instancesOverview]: {
    operation: DASHBOARD_OPERATIONS.instancesOverview,
  },
  [DASHBOARD_OPERATIONS.campaignsPerformance]: {
    operation: DASHBOARD_OPERATIONS.campaignsPerformance,
  },
  [DASHBOARD_OPERATIONS.campaignsSequenceSteps]: {
    operation: DASHBOARD_OPERATIONS.campaignsSequenceSteps,
  },
  [DASHBOARD_OPERATIONS.syncRecentRuns]: {
    operation: DASHBOARD_OPERATIONS.syncRecentRuns,
  },
  [DASHBOARD_OPERATIONS.annotationsTimeline]: {
    operation: DASHBOARD_OPERATIONS.annotationsTimeline,
  },
  [LEADS_OPERATIONS.directory]: {
    operation: LEADS_OPERATIONS.directory,
    // Not `ranged`. The operation ignores the request's range on purpose — it
    // filters on `updated_at`, a replication watermark rather than a window, and
    // takes it as an explicit parameter. See `LeadsDirectoryParams`.
    params: (url) => ({ updatedSince: readOptionalInstant(url) }),
  },
  [LEADS_OPERATIONS.searchPage]: {
    operation: LEADS_OPERATIONS.searchPage,
    params: readLeadsSearch,
  },
  [MESSAGES_OPERATIONS.inboundHistory]: {
    operation: MESSAGES_OPERATIONS.inboundHistory,
    // Deliberately not `ranged`, and this one is an invariant rather than a
    // detail: the inbound history is all-time because sentiment and durable P3
    // counts are rendered beside all-time lead totals. Accepting `from`/`to` here
    // would let a caller undercount them silently.
    params: (url) => ({ updatedSince: readOptionalInstant(url) }),
  },
  [MESSAGES_OPERATIONS.outboundRecent]: {
    operation: MESSAGES_OPERATIONS.outboundRecent,
    ranged: true,
    params: (url) => ({ updatedSince: readOptionalInstant(url) }),
  },

  /**
   * The roster, and the only read on this endpoint that can name a person.
   *
   * **Not tolerant, and that is the decision this operation exists to make.**
   * `public.team_members` is in the baseline's first artifact — it cannot be
   * "not yet migrated" on a database that answered any other read here — so an
   * absent relation would mean something is deeply wrong, and answering it with
   * an empty roster would restore precisely the "0 Active teammates" the move
   * fixes. It fails, loudly, like the funnel reads.
   *
   * No parameters. The function projects the same seven columns for every
   * caller and refuses a non-member by returning zero rows, so there is nothing
   * for this endpoint to filter, scope or validate; adding a parameter here
   * would only create a way to ask for less than the page needs.
   */
  [IDENTITY_OPERATIONS.teamRoster]: {
    operation: IDENTITY_OPERATIONS.teamRoster,
  },

  // --- the medium relations ------------------------------------------------
  [PIPELINE_OPERATIONS.eventLog]: {
    operation: PIPELINE_OPERATIONS.eventLog,
    // `occurred_since`, not `updated_since`: this relation is append-only and has
    // no `updated_at` at all, so its insertion time is its watermark. A distinct
    // name is what keeps the two from being confused where they coincide.
    params: (url) => ({
      occurredSince: readOptionalInstant(url, 'occurred_since'),
    }),
    tolerateMissingRelation: true,
  },
  [CONVERSATION_OPERATIONS.followUpState]: {
    operation: CONVERSATION_OPERATIONS.followUpState,
    tolerateMissingRelation: true,
  },
  [CONVERSATION_OPERATIONS.latestMessage]: {
    operation: CONVERSATION_OPERATIONS.latestMessage,
    tolerateMissingRelation: true,
  },
  [CONVERSATION_OPERATIONS.replyIntent]: {
    operation: CONVERSATION_OPERATIONS.replyIntent,
    tolerateMissingRelation: true,
  },

  // --- the component-local reads -------------------------------------------
  [CONVERSATION_OPERATIONS.followUpHistory]: {
    operation: CONVERSATION_OPERATIONS.followUpHistory,
    // Not tolerant: the panel that asks for this has its own error state and
    // shows it, so a swallowed failure would replace a visible message with an
    // empty history.
    params: (url) => readConversation(url),
  },
  [MESSAGES_OPERATIONS.thread]: {
    operation: MESSAGES_OPERATIONS.thread,
    params: (url) => readConversation(url),
  },
  [LEADS_OPERATIONS.notes]: {
    operation: LEADS_OPERATIONS.notes,
    params: (url) => ({ leadId: readRequiredUuid(url, 'lead_id') }),
  },

  // Manual reply review is a dedicated, bounded read surface. These operations
  // intentionally share this endpoint with the dashboard slices so the Vercel
  // function count does not grow.
  [REPLY_REVIEW_OPERATIONS.capabilities]: { operation: REPLY_REVIEW_OPERATIONS.capabilities },
  [REPLY_REVIEW_OPERATIONS.inbox]: {
    operation: REPLY_REVIEW_OPERATIONS.inbox,
    params: readReplyInbox,
  },
  [REPLY_REVIEW_OPERATIONS.thread]: {
    operation: REPLY_REVIEW_OPERATIONS.thread,
    params: readReplyThread,
  },
  [REPLY_REVIEW_OPERATIONS.analytics]: {
    operation: REPLY_REVIEW_OPERATIONS.analytics,
    params: readReplyAnalytics,
  },
  [REPLY_REVIEW_OPERATIONS.reviewHistory]: {
    operation: REPLY_REVIEW_OPERATIONS.reviewHistory,
    params: readReplyHistory,
  },

  /**
   * The coaching pair — the last two reads the dashboard still took straight
   * from Supabase on both paths, and the reason `NEON_READS_DEFAULT=neon` did
   * not yet mean what it says.
   *
   * **`coach.playbook` is an existing operation, borrowed rather than
   * duplicated.** `/api/coach` already reads the singleton to ground its
   * analysis; the Playbook page renders the same row plus its `updated_at`. One
   * SQL, one place the projection is decided. Allowlisting a name that lives in
   * the AI module is exactly what this list is for — the registry is not a
   * pass-through, so being registered somewhere never made an operation
   * reachable from here.
   *
   * **Neither tolerates an absent relation**, and the playbook is the sharper of
   * the two: its editor unlocks on a successful load, so an empty document
   * standing in for a missing table would invite an admin to type into a blank
   * box and Save it over the real playbook. Both tables are in the baseline's
   * first artifact, so absence is a broken deployment either way. No parameters:
   * the playbook is a singleton and the digest relation is one row per notebook,
   * which the page renders in full.
   */
  [AI_WRITE_OPERATIONS.coachPlaybook]: {
    operation: AI_WRITE_OPERATIONS.coachPlaybook,
  },
  [COACHING_OPERATIONS.digests]: {
    operation: COACHING_OPERATIONS.digests,
  },

  // --- the sourcing library, all tolerant ----------------------------------
  [LIBRARY_OPERATIONS.savedSearches]: {
    operation: LIBRARY_OPERATIONS.savedSearches,
    tolerateMissingRelation: true,
  },
  [LIBRARY_OPERATIONS.icpProfiles]: {
    operation: LIBRARY_OPERATIONS.icpProfiles,
    tolerateMissingRelation: true,
  },
  [LIBRARY_OPERATIONS.icpPersonas]: {
    operation: LIBRARY_OPERATIONS.icpPersonas,
    tolerateMissingRelation: true,
  },
  [LIBRARY_OPERATIONS.icpIndustries]: {
    operation: LIBRARY_OPERATIONS.icpIndustries,
    tolerateMissingRelation: true,
  },
  [LIBRARY_OPERATIONS.hypotheses]: {
    operation: LIBRARY_OPERATIONS.hypotheses,
    tolerateMissingRelation: true,
  },
  [LIBRARY_OPERATIONS.hypothesisCampaigns]: {
    operation: LIBRARY_OPERATIONS.hypothesisCampaigns,
    tolerateMissingRelation: true,
  },
}

/**
 * The allowlist's keys, for the guard suite. Exported as names only: what a test
 * needs to assert is *which* reads this endpoint offers, not how each parses its
 * parameters, and a handler-shaped export would invite a caller to dispatch
 * through it.
 */
export const READ_OPERATION_NAMES: readonly string[] = Object.freeze(
  Object.keys(READ_OPERATIONS),
)

/**
 * The reads that answer an absent relation with an empty page rather than a
 * failure. Exported so the guard suite pins the set instead of the mechanism —
 * making a funnel read tolerant is the mistake worth catching, and it is one
 * word.
 */
export const TOLERANT_OPERATION_NAMES: readonly string[] = Object.freeze(
  Object.entries(READ_OPERATIONS)
    .filter(([, spec]) => spec.tolerateMissingRelation === true)
    .map(([name]) => name),
)

function readOptionalInstance(url: URL): string | null {
  const raw = (url.searchParams.get('instance_id') ?? '').trim()
  return raw === '' ? null : raw
}

/**
 * Read `updated_since` — the delta-refresh watermark — as a UTC instant.
 *
 * Instant-granular, unlike `from`/`to`, and for a substantive reason rather than
 * for convenience: the watermark's whole job is to be finer than a day. The
 * Supabase path sets it to the load's start time minus a two-minute overlap
 * (`REFRESH_OVERLAP_MS`), so rounding it to a day would either re-fetch the day so
 * far on every five-minute tick or skip commits, depending on which way it rounded.
 *
 * `asUtcTimestamp` accepts an explicit offset and normalizes it, so a client that
 * sends `+02:00` gets the instant it meant. A bare local time has no instant and is
 * refused.
 */
function readOptionalInstant(url: URL, name = 'updated_since'): string | null {
  const raw = (url.searchParams.get(name) ?? '').trim()
  if (raw === '') return null
  try {
    return asUtcTimestamp(raw)
  } catch {
    throw new BadRequest(
      `${name} must be an ISO-8601 instant with Z or an explicit UTC offset`,
    )
  }
}

/**
 * Longer than any LinkedIn profile URL or notebook id, short enough that a
 * request cannot make the database compare megabytes. The cap refuses absurd
 * input at the edge; it is not a validity check — the value is a parameter, never
 * interpolated, and a wrong-but-plausible one simply matches nothing.
 */
const MAX_KEY_LENGTH = 500

function readRequiredText(url: URL, name: string): string {
  const raw = (url.searchParams.get(name) ?? '').trim()
  if (raw === '') throw new BadRequest(`${name} is required`)
  if (raw.length > MAX_KEY_LENGTH) {
    throw new BadRequest(`${name} must be at most ${MAX_KEY_LENGTH} characters`)
  }
  return raw
}

/**
 * A conversation's thread key: `(instance_id, profile_url)`.
 *
 * Both halves are required, and the instance half is the substantive one.
 * `CLAUDE.md` states the rule the schema encodes — the same person can be reached
 * from two LinkedIn accounts, so a `profile_url` alone names two different
 * conversations. Accepting a bare profile URL and letting the query match
 * whichever rows it found would merge two people's threads into one panel.
 */
function readConversation(url: URL): DataStoreParams {
  return {
    instanceId: readRequiredText(url, 'instance_id'),
    profileUrl: readRequiredText(url, 'profile_url'),
  }
}

/** Lowercase-canonical RFC 4122 form, which is how PostgreSQL renders a `uuid`. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A `uuid`-typed key, refused here rather than at the `::uuid` cast.
 *
 * The cast would raise SQLSTATE 22P02 for a malformed value, which the driver
 * turns into a transaction error and the endpoint reports as a 500 — a server
 * fault for what is plainly a caller's mistake. Validating first keeps the status
 * honest and costs no round trip.
 */
function readRequiredUuid(url: URL, name: string): string {
  const raw = readRequiredText(url, name)
  if (!UUID_PATTERN.test(raw)) {
    throw new BadRequest(`${name} must be a UUID`)
  }
  return raw
}

function readOptionalEnum(
  url: URL,
  name: string,
  allowed: readonly string[],
): string | null {
  const value = (url.searchParams.get(name) ?? '').trim()
  if (value === '' || value === 'all') return null
  if (!allowed.includes(value)) {
    throw new BadRequest(`${name} is not an allowed value`)
  }
  return value
}

function readOptionalSearch(url: URL): string | null {
  const value = (url.searchParams.get('q') ?? '').trim()
  if (value === '') return null
  if (value.length > 200) throw new BadRequest('q must be at most 200 characters')
  return value
}

function readOptionalBoundedText(url: URL, name: string): string | null {
  const value = (url.searchParams.get(name) ?? '').trim()
  if (value === '' || value === 'all') return null
  if (value.length > MAX_KEY_LENGTH) {
    throw new BadRequest(`${name} must be at most ${MAX_KEY_LENGTH} characters`)
  }
  return value
}

function readPageInteger(url: URL, name: string, fallback: number, max: number): string {
  const raw = (url.searchParams.get(name) ?? '').trim()
  const value = raw === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new BadRequest(`${name} must be an integer between 0 and ${max}`)
  }
  return String(value)
}

function readLeadsSearch(url: URL): DataStoreParams {
  const today = readDay(url.searchParams.get('today'), 'today')
  if (today === null) throw new BadRequest('today is required')
  const ownerRaw = (url.searchParams.get('who') ?? '').trim()
  const owner = ownerRaw === '' || ownerRaw === 'all' ? null : ownerRaw
  if (owner !== null && owner !== 'unassigned' && !/^\d+$/.test(owner)) {
    throw new BadRequest('who must be unassigned or a member id')
  }
  return {
    instanceId: readOptionalInstance(url),
    campaignId: readOptionalBoundedText(url, 'camp'),
    stage: readOptionalEnum(url, 'stage', ['queued', 'invited', 'accepted', 'replied']),
    risk: readOptionalEnum(url, 'risk', ['pending_2w', 'no_reply_2w']),
    pipeline: readOptionalEnum(url, 'pipe', [
      'untriaged', 'first_contact', 'interested', 'neutral', 'negative',
      'following_up', 'negotiations_call', 'call_booked', 'call_done',
      'proposal_in_progress', 'proposal_presented', 'client', 'lost',
    ]),
    owner,
    gender: readOptionalEnum(url, 'gender', ['male', 'female', 'unknown', 'pending']),
    ageBucket: readOptionalEnum(url, 'agebucket', [
      'under_25', '25_34', '35_44', '45_54', '55_plus',
    ]),
    followUp: readOptionalEnum(url, 'follow', ['overdue', 'today', 'upcoming', 'unscheduled']),
    repliedSince: readOptionalInstant(url, 'replied_since'),
    sentiment: readOptionalEnum(url, 'sentiment', [
      'any', 'unclassified', 'positive', 'neutral', 'negative', 'objection',
      'referral', 'auto',
    ]),
    intent: readOptionalEnum(url, 'intent', ['p1', 'p2', 'p3', 'none']),
    query: readOptionalSearch(url),
    sort: readOptionalEnum(url, 'sort', [
      'full_name', 'added_at', 'invited_at', 'connected_at', 'replied_at',
      'last_action_at', 'next_follow_up_date',
    ]) ?? 'last_action_at',
    direction: readOptionalEnum(url, 'dir', ['asc', 'desc']) ?? 'desc',
    today,
    pageSize: readPageInteger(url, 'page_size', 50, 1_000),
    page: readPageInteger(url, 'page', 0, 100_000),
  }
}

export interface ActivityDailyDeps {
  /**
   * Explicit deployment configuration for the handler contract tests. The
   * production entrypoint uses `process.env`; this seam prevents a disabled
   * photo request from reaching either the actor or object-storage layers.
   */
  readonly env?: NodeJS.ProcessEnv
  readonly authPath?: ApplicationAuthPath
  readonly identity?: IdentityProvider
  /**
   * Which `user_identities.provider` the transitional bearer resolves under.
   *
   * Injectable rather than read from the environment, which is a deliberate
   * change from the bridge this replaced: that carried a
   * `NEON_ACTOR_BRIDGE_PROVIDER` override so the contract suite could match the
   * baseline's `provider = 'fixture'` fixtures. An environment variable that
   * only exists for tests is indistinguishable at a glance from one a deployment
   * is supposed to set, so the seam is now an argument.
   */
  readonly legacyProviderName?: string
}

async function handle(
  req: Request,
  deps: ActivityDailyDeps = {},
): Promise<Response> {
  const requestStartedAt = performance.now()
  const requestId = globalThis.crypto?.randomUUID?.() ??
    `read-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  if (req.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405)
  }

  const url = new URL(req.url)
  const op = (url.searchParams.get('op') ?? '').trim()

  // Before any authentication and before any store construction. See
  // `readPathResponse` for why this one operation is unauthenticated.
  if (op === CONFIG_READ_PATH_OPERATION) return readPathResponse(deps.env)

  /**
   * No `op` is S12's request, and it is answered exactly as S12 answered it:
   * `instance_id` required, response keyed `activity`. `#/neon-activity` and
   * `frontend/src/lib/neonActivity.ts` both still call this shape, and S18 —
   * not S13 — is what rewires the browser.
   */
  const legacy = op === ''
  const spec = legacy ? READ_OPERATIONS[ACTIVITY_OPERATIONS.dailySeries] : READ_OPERATIONS[op]
  if (!spec && op !== LEAD_PHOTO_URLS_OPERATION) {
    // Names the refusal without enumerating the vocabulary.
    return json({ error: `operation is not allowlisted: ${op}` }, 400)
  }

  // The disposable S26 drill is initials-only. Refuse this operation before
  // actor resolution, database reads, or object-storage construction so no
  // request can accidentally exercise a preserved photo path. Existing photo
  // rows and objects are intentionally not read, changed, or deleted.
  if (op === LEAD_PHOTO_URLS_OPERATION) {
    let photoPath: PhotoPath
    try {
      photoPath = deploymentPhotoPath(deps.env)
    } catch (error) {
      const refusal = providerPathRefusal(error)
      if (refusal) return refusal
      throw error
    }
    if (photoPath !== 'neon') {
      return json({ error: 'Lead photo operations are disabled for this deployment' }, 503)
    }
  }

  // The deployed SPA and this endpoint use the same explicit auth selector.
  // Legacy mode verifies the transitional bearer. Identity mode reads the
  // self-hosted Better Auth cookie and disables bearer fallback. In both cases
  // the provider supplies only a subject; `identity_resolve_actor` in the tenant
  // database decides active membership and role.
  //
  // **Resolved once per request** (G2's B5), then passed down. S12 measured this
  // at 196 ms of a 525 ms request, so a slice that resolved per read would pay it
  // once per relation.
  let actor
  const actorStartedAt = performance.now()
  try {
    const resolved = await resolveApplicationActor(req, {
      store: getDataStore(),
      authPath: deps.authPath,
      identity: deps.identity,
      legacyProviderName: deps.legacyProviderName,
    })
    actor = resolved.actor
  } catch (error) {
    const denial = authorizationResponse(error)
    if (denial) return denial
    // The database was not reached, so no membership decision was taken and
    // the answer below would be a claim about one. Named cause, honest status.
    const unavailable = unavailableResponse(error)
    if (unavailable) return unavailable
    console.error('Neon actor resolution failed:', safeErrorLabel(error))
    return json({ error: 'Could not verify team access' }, 500)
  }
  const actorMs = performance.now() - actorStartedAt

  // After authentication, before the generic read machinery — this operation
  // parses its own parameters and does not page.
  if (op === LEAD_PHOTO_URLS_OPERATION) {
    return leadPhotoUrlsResponse(url, actor)
  }

  // Unreachable: the allowlist check above already refused everything except an
  // allowlisted read and the photo operation, and the photo operation returned on
  // the line above. Written as a check rather than a non-null assertion so the
  // narrowing comes from the fact itself.
  if (!spec) return json({ error: `operation is not allowlisted: ${op}` }, 400)

  let params: DataStoreParams | undefined
  let range: UtcRange | undefined
  let limit: number
  try {
    if (legacy) {
      const instanceId = (url.searchParams.get('instance_id') ?? '').trim()
      if (instanceId === '') throw new BadRequest('instance_id is required')
      params = { instanceId }
    } else {
      params = spec.params?.(url)
    }

    if (legacy || spec.ranged) {
      const from = readDay(url.searchParams.get('from'), 'from')
      const to = readDay(url.searchParams.get('to'), 'to')
      if (from !== null && to !== null && from > to) {
        throw new BadRequest('from must not be after to')
      }
      range = dayRangeToUtcRange(from, to)
    }

    const rawLimit = url.searchParams.get('limit')
    limit = rawLimit === null ? MAX_LIMIT : Number(rawLimit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`)
    }
  } catch (error) {
    if (error instanceof BadRequest) return json({ error: error.message }, 400)
    throw error
  }

  const cursor = url.searchParams.get('cursor')

  if (op.startsWith('replies.')) {
    try {
      return await replyReadResponse(getDataStore(), actor, op, params ?? {})
    } catch (error) {
      if (error instanceof PaginationError) return json({ error: error.message }, 400)
      if (error instanceof DataStoreSchemaError) {
        return json({ error: 'Manual reply review is unavailable for this tenant', code: 'REPLY_REVIEW_UNAVAILABLE' }, 503)
      }
      if (error instanceof DataStoreContractError) {
        const unavailable = unavailableResponse(error)
        if (unavailable) return unavailable
        console.error(`Read ${op} failed:`, safeErrorLabel(error), safeSqlState(error) ?? 'sqlstate=none')
        return json({ error: 'Could not load reply review data' }, 500)
      }
      throw error
    }
  }

  try {
    // `unknown` rather than a row type: the rows are serialized straight to JSON
    // and each operation owns its own shape, so naming one of them here would be
    // a claim the dispatcher cannot keep. The operation's `mapRow` is where the
    // shape is enforced.
    const queryStartedAt = performance.now()
    const page = await getDataStore().query<unknown>(actor, {
      operation: spec.operation,
      params,
      range,
      page: { limit, cursor },
    })
    const queryMs = performance.now() - queryStartedAt

    const body = {
      items: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
    // The legacy response keeps its own key. Two names for one array is worth
    // less than S12's page continuing to work untouched.
    const responseBody = legacy ? { activity: page.items, ...body } : body
    const responseBytes = new TextEncoder().encode(JSON.stringify(responseBody)).byteLength
    const totalMs = performance.now() - requestStartedAt
    console.info('dashboard_read', JSON.stringify({
      request_id: requestId,
      operation: spec.operation,
      status: 200,
      rows: page.items.length,
      bytes: responseBytes,
      actor_ms: Math.round(actorMs * 10) / 10,
      query_ms: Math.round(queryMs * 10) / 10,
      total_ms: Math.round(totalMs * 10) / 10,
      has_more: page.hasMore,
      limit,
    }))
    return json(responseBody, 200, {
      'server-timing': `actor;dur=${actorMs.toFixed(1)}, db;dur=${queryMs.toFixed(1)}, total;dur=${totalMs.toFixed(1)}`,
      'x-request-id': requestId,
      'x-result-rows': String(page.items.length),
      'x-response-bytes': String(responseBytes),
    })
  } catch (error) {
    // A cursor from another scope is the caller's mistake, not a server fault.
    if (error instanceof PaginationError) {
      return json({ error: error.message }, 400)
    }
    // An absent relation, on a read whose spec says an absent relation is an
    // acceptable answer. Checked before the general contract-error branch so the
    // ordering states the precedence, and logged at `warn` rather than swallowed:
    // on this provider every one of these relations exists, so reaching here at
    // all is a fact about a deployment that somebody should see.
    if (error instanceof DataStoreSchemaError && spec.tolerateMissingRelation) {
      console.warn(
        `Read ${spec.operation} found no such relation:`,
        safeErrorLabel(error),
      )
      return json({
        items: [],
        nextCursor: null,
        hasMore: false,
        unavailable: true,
      })
    }
    if (error instanceof DataStoreContractError) {
      // The operation name is adapter-owned constant text, so it is loggable —
      // unlike the error's message, which embeds the database hostname.
      console.error(
        `Read ${spec.operation} failed:`,
        safeErrorLabel(error),
        safeSqlState(error) ?? 'sqlstate=none',
      )
      // A read that could not reach the database is a different answer from one
      // the database refused, and `readAll` prefixes whichever it gets with the
      // operation name — so this is the sentence that lands in the banner.
      const unavailable = unavailableResponse(error)
      if (unavailable) return unavailable
      return json({ error: 'Could not load dashboard data' }, 500)
    }
    throw error
  }
}

/** Build the handler with explicit dependencies. For the contract suite. */
export const createActivityDailyHandler =
  (deps: ActivityDailyDeps) =>
  (req: Request): Promise<Response> =>
    handle(req, deps)

export const GET = (req: Request) => handle(req)
