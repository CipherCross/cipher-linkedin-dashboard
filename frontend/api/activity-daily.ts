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
} from './_lib/data/operations/index.js'
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
  [DASHBOARD_OPERATIONS.overviewSummary]: {
    operation: DASHBOARD_OPERATIONS.overviewSummary,
    ranged: true,
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
      console.error(`Read ${spec.operation} failed:`, safeErrorLabel(error))
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
