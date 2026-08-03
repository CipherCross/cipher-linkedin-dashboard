/**
 * `GET /api/activity-daily` — the S12 slice: one read-only dashboard read
 * served browser → API → Neon, with the signed-in user resolved to a canonical
 * actor and the baseline's RLS deciding the result.
 *
 * This runs **beside** the existing Supabase path, which is untouched:
 * `DataContext` still fetches `daily_activity` through PostgREST. Nothing here
 * switches a path; S12 adds one so parity can be measured.
 *
 * Read-only end to end. The application registry declares no command, and the
 * store's `query()` runs inside `BEGIN READ ONLY`.
 */

import { authorizationResponse } from './_lib/auth.js'
import {
  DataStoreContractError,
  PaginationError,
  asUtcTimestamp,
  type UtcRange,
} from './_lib/data/contracts.js'
import {
  ACTIVITY_OPERATIONS,
  type DailyActivityRow,
} from './_lib/data/operations/index.js'
import { getDataStore } from './_lib/data/store.js'
import { requireNeonActor } from './_lib/neonActor.js'

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

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405)
  }

  let actor
  try {
    actor = await requireNeonActor(req)
  } catch (error) {
    const denial = authorizationResponse(error)
    if (denial) return denial
    console.error('Neon actor resolution failed:', safeErrorLabel(error))
    return json({ error: 'Could not verify team access' }, 500)
  }

  const url = new URL(req.url)

  let instanceId: string
  let from: string | null
  let to: string | null
  let limit: number
  try {
    instanceId = (url.searchParams.get('instance_id') ?? '').trim()
    if (instanceId === '') throw new BadRequest('instance_id is required')

    from = readDay(url.searchParams.get('from'), 'from')
    to = readDay(url.searchParams.get('to'), 'to')
    if (from !== null && to !== null && from > to) {
      throw new BadRequest('from must not be after to')
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
    const page = await getDataStore().query<DailyActivityRow>(actor, {
      operation: ACTIVITY_OPERATIONS.dailySeries,
      params: { instanceId },
      range: dayRangeToUtcRange(from, to),
      page: { limit, cursor },
    })

    return json({
      activity: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    })
  } catch (error) {
    // A cursor from another scope is the caller's mistake, not a server fault.
    if (error instanceof PaginationError) {
      return json({ error: error.message }, 400)
    }
    if (error instanceof DataStoreContractError) {
      console.error('Daily activity read failed:', safeErrorLabel(error))
      return json({ error: 'Could not load activity' }, 500)
    }
    throw error
  }
}

export const GET = (req: Request) => handle(req)
