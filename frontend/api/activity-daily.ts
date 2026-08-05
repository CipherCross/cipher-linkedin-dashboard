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
 * `team.roster` is **not** here on purpose, and the reason is stronger than
 * tidiness. It is served by `/api/identity?op=` where the rest of the identity
 * surface lives — but it is also kept off the *dashboard* read path because
 * `DataContext` joins its roster against `leads.assigned_to`, which is still a
 * Supabase `team_members.id`. The two id spaces name different people, so that
 * join mislabels owners without failing. See the header of
 * `_lib/data/operations/dashboard.ts`; `tests/dashboardSlice.test.ts` asserts it.
 *
 * Read-only end to end. Every operation reachable from this file is a registered
 * *query*; the store's `query()` runs inside `BEGIN READ ONLY`, and no command
 * is reachable from here at all.
 */

import { authorizationResponse } from './_lib/auth.js'
import {
  DataStoreContractError,
  PaginationError,
  asUtcTimestamp,
  type DataStoreParams,
  type UtcRange,
} from './_lib/data/contracts.js'
import {
  ACTIVITY_OPERATIONS,
  DASHBOARD_OPERATIONS,
  LEADS_OPERATIONS,
  MESSAGES_OPERATIONS,
} from './_lib/data/operations/index.js'
import { getDataStore } from './_lib/data/store.js'
import { resolveRequestActor } from './_lib/identity/session.js'

export const maxDuration = 10

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
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

/**
 * The deployment's default read path, for a browser that has not overridden it.
 *
 * **Off unless a deployment says otherwise.** Only the exact string `neon`
 * enables it; anything else — unset, empty, `true`, `1`, a typo — resolves to
 * `supabase`, so no accident switches the running dashboard onto a path it was
 * not deployed to use. Flipping it is an owner decision and S13 does not take it.
 */
export function deploymentReadPath(env = process.env): ReadPath {
  return (env.NEON_READS_DEFAULT ?? '').trim() === 'neon' ? 'neon' : 'supabase'
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
function readPathResponse(): Response {
  return json({ readPath: deploymentReadPath() })
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
function readOptionalInstant(url: URL): string | null {
  const raw = (url.searchParams.get('updated_since') ?? '').trim()
  if (raw === '') return null
  try {
    return asUtcTimestamp(raw)
  } catch {
    throw new BadRequest(
      'updated_since must be an ISO-8601 instant with Z or an explicit UTC offset',
    )
  }
}

export interface ActivityDailyDeps {
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
  if (req.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405)
  }

  const url = new URL(req.url)
  const op = (url.searchParams.get('op') ?? '').trim()

  // Before any authentication and before any store construction. See
  // `readPathResponse` for why this one operation is unauthenticated.
  if (op === CONFIG_READ_PATH_OPERATION) return readPathResponse()

  /**
   * No `op` is S12's request, and it is answered exactly as S12 answered it:
   * `instance_id` required, response keyed `activity`. `#/neon-activity` and
   * `frontend/src/lib/neonActivity.ts` both still call this shape, and S18 —
   * not S13 — is what rewires the browser.
   */
  const legacy = op === ''
  const spec = legacy ? READ_OPERATIONS[ACTIVITY_OPERATIONS.dailySeries] : READ_OPERATIONS[op]
  if (!spec) {
    // Names the refusal without enumerating the vocabulary.
    return json({ error: `operation is not allowlisted: ${op}` }, 400)
  }

  // S17 replaced S12's actor bridge. The change here is small and the reason it
  // is small is the point: the bridge's *shape* — verify a subject, then let the
  // database decide who that is — was always right; only the environment-held
  // map in the middle was temporary, and `identity_resolve_actor` removed it.
  //
  // No identity provider is passed, so this endpoint reads no session cookie and
  // needs no identity credential: it authenticates the same signed-in browser it
  // always did, through the transitional bearer, and resolves it through the real
  // resolver instead of a redeploy-per-member map. S18 rewires the browser.
  //
  // **Resolved once per request** (G2's B5), then passed down. S12 measured this
  // at 196 ms of a 525 ms request, so a slice that resolved per read would pay it
  // once per relation.
  let actor
  try {
    const resolved = await resolveRequestActor(req, {
      store: getDataStore(),
      acceptLegacyBearer: true,
      legacyProviderName: deps.legacyProviderName,
    })
    actor = resolved.actor
  } catch (error) {
    const denial = authorizationResponse(error)
    if (denial) return denial
    console.error('Neon actor resolution failed:', safeErrorLabel(error))
    return json({ error: 'Could not verify team access' }, 500)
  }

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
    const page = await getDataStore().query<unknown>(actor, {
      operation: spec.operation,
      params,
      range,
      page: { limit, cursor },
    })

    const body = {
      items: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
    // The legacy response keeps its own key. Two names for one array is worth
    // less than S12's page continuing to work untouched.
    return json(legacy ? { activity: page.items, ...body } : body)
  } catch (error) {
    // A cursor from another scope is the caller's mistake, not a server fault.
    if (error instanceof PaginationError) {
      return json({ error: error.message }, 400)
    }
    if (error instanceof DataStoreContractError) {
      // The operation name is adapter-owned constant text, so it is loggable —
      // unlike the error's message, which embeds the database hostname.
      console.error(`Read ${spec.operation} failed:`, safeErrorLabel(error))
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
