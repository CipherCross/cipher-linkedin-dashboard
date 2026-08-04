/**
 * S12 — the daily-activity slice, end to end against the live Neon project.
 *
 * Everything here goes through the **real handler** (`api/activity-daily.ts`'s
 * exported `GET`), the real operation registry, the real driver and the real
 * baseline RLS policies. The only thing ever stubbed is the identity provider's
 * JWT verification, and only in the tests that say so — the unauthenticated and
 * invalid-token denials run it for real.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  presetRanges,
  weekStart,
  type DateRange,
} from '../src/lib/leads'
import {
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_FIRST_DAY,
  ACTIVITY_LAST_DAY,
  ACTIVITY_SCOPE,
  DAY_COUNT,
  EXPECTED_EVENT_ROWS,
  EXPECTED_VIEW_ROWS,
  countForDay,
  dayAt,
  seedActivityFixture,
} from './support/activitySliceFixture'
import { NeonDataStore, NeonOperationRegistry } from '../api/_lib/data/neon.js'
import {
  NeonFixtureClient,
  requireNeonTestConnection,
} from './support/neonContractHarness'
import { CONTRACT_ACTORS } from './support/dataStoreContract'

/** Fails the file at import if the credential is absent. */
const connection = requireNeonTestConnection()

/**
 * The identity-provider subject the stub presents. `null` means "use the real
 * `requireUser`", which is how the unauthenticated and bad-token cases stay
 * honest.
 */
let stubbedSubject: string | null = null

vi.mock('../api/_lib/auth.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../api/_lib/auth.js')>()
  return {
    ...actual,
    requireUser: async (req: Request) => {
      if (stubbedSubject === null) return actual.requireUser(req)
      return { userId: stubbedSubject, email: null }
    },
  }
})

/** The baseline's own identity fixtures, seeded with `provider = 'fixture'`. */
const SUBJECTS = {
  activeMember: 'subject-one',
  activeAdmin: 'subject-two',
  inactive: 'subject-three',
  unmapped: 'subject-nobody',
} as const

const ACTORS = {
  activeMember: CONTRACT_ACTORS.activeMember.actorId,
  activeAdmin: CONTRACT_ACTORS.activeAdmin.actorId,
  inactive: CONTRACT_ACTORS.inactive.actorId,
} as const

// S17 removed the bridge, and with it the proposal map that used to sit here.
// There is no longer anything to propose: `identity_resolve_actor` answers the
// mapping directly, so the deny matrix below is unchanged in its expectations
// and different in its mechanism. What used to be "the map proposes an actor the
// database then refuses" is now simply "the database resolves nobody".
//
// The mismapped case is worth keeping for exactly that reason: it used to prove
// that a hostile proposal could not escalate, and it now proves the narrower and
// stronger thing that a subject nobody has mapped resolves to nobody at all.
const { createActivityDailyHandler, dayRangeToUtcRange } = await import(
  '../api/activity-daily.js'
)

/**
 * The baseline seeds its identity fixtures under `provider = 'fixture'`, and the
 * transitional bearer path defaults to `provider = 'supabase'`. Injected rather
 * than overridden through the environment.
 */
const GET = createActivityDailyHandler({ legacyProviderName: 'fixture' })
const { resetDataStore, dataStoreExists, getDataStore } = await import(
  '../api/_lib/data/store.js'
)
const { buildApplicationRegistry, APPLICATION_QUERY_OPERATIONS } = await import(
  '../api/_lib/data/operations/index.js'
)

interface ActivityRow {
  day: string
  instance_id: string
  event_type: string
  cnt: number
}

interface ActivityBody {
  activity?: ActivityRow[]
  nextCursor?: string | null
  hasMore?: boolean
  error?: string
}

function request(params: Record<string, string>, token = 'stub-token'): Request {
  const url = new URL('https://dashboard.test/api/activity-daily')
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return new Request(url, {
    method: 'GET',
    headers: token === '' ? {} : { authorization: `Bearer ${token}` },
  })
}

async function call(
  params: Record<string, string>,
  token?: string,
): Promise<{ status: number; body: ActivityBody }> {
  const response = await GET(request(params, token))
  return {
    status: response.status,
    body: (await response.json()) as ActivityBody,
  }
}

/** Walk every page through the handler, following the opaque cursor. */
async function walk(
  params: Record<string, string>,
): Promise<{ rows: ActivityRow[]; pageSizes: number[] }> {
  const rows: ActivityRow[] = []
  const pageSizes: number[] = []
  let cursor: string | null = null

  for (let guard = 0; guard < 100; guard++) {
    const page = await call(cursor ? { ...params, cursor } : params)
    expect(page.status).toBe(200)
    const items = page.body.activity ?? []
    rows.push(...items)
    pageSizes.push(items.length)
    if (!page.body.hasMore) break
    cursor = page.body.nextCursor ?? null
    expect(cursor).toBeTruthy()
  }

  return { rows, pageSizes }
}

const fixtures = new NeonFixtureClient(connection.pooled)

const FULL_RANGE = { instance_id: ACTIVITY_SCOPE, from: ACTIVITY_FIRST_DAY, to: ACTIVITY_LAST_DAY }

beforeAll(async () => {
  stubbedSubject = SUBJECTS.activeMember
  const seeded = await fixtures.asActor(ACTORS.activeMember, (client) =>
    seedActivityFixture(client),
  )
  expect(seeded.eventRows).toBe(EXPECTED_EVENT_ROWS)
  expect(seeded.viewRows).toBe(EXPECTED_VIEW_ROWS)
}, 180_000)

afterAll(async () => {
  await resetDataStore()
  await fixtures.end()
})

describe('S12 slice — read-only by construction', () => {
  it('registers no command operation at all', () => {
    const registry = buildApplicationRegistry()
    for (const operation of APPLICATION_QUERY_OPERATIONS) {
      expect(() => registry.lookupQuery(operation)).not.toThrow()
      // The same name must not also be reachable as a mutation.
      expect(() => registry.lookupCommand(operation)).toThrow(
        /not allowlisted/,
      )
    }
    for (const candidate of [
      'activity.dailySeries',
      'identity.teamRoster',
      'identity.resolveActor',
      'events.insert',
      'annotations.insert',
    ]) {
      expect(() => registry.lookupCommand(candidate)).toThrow(/not allowlisted/)
    }

    // The actor resolver is reachable *only* through the actorless path: it is
    // not a query and not a command, so no code holding an actor can route a
    // request to it by name and no code lacking one can reach anything else.
    expect(() => registry.lookupQuery('identity.resolveActor')).toThrow(
      /not allowlisted/,
    )
    expect(registry.actorlessOperationNames()).toEqual(['identity.resolveActor'])
  })

  it('refuses an operation that is not allowlisted', () => {
    const registry = buildApplicationRegistry()
    expect(() => registry.lookupQuery('activity.everything')).toThrow(
      /not allowlisted/,
    )
  })

  it('creates the store lazily, then shares one instance across requests', async () => {
    // Importing the handler must not construct a store, so a type-check or a
    // test that never touches a database can still import the API surface.
    expect(dataStoreExists()).toBe(false)

    const first = await call({ ...FULL_RANGE, limit: '1' })
    expect(first.status).toBe(200)
    expect(dataStoreExists()).toBe(true)

    const second = await call({ ...FULL_RANGE, limit: '1' })
    expect(second.status).toBe(200)

    // The identity that matters: a second request reuses the same store, and
    // therefore the same pool, rather than paying a cold connect. This is the
    // 158.9 ms vs 578.8 ms difference S11 measured.
    expect(getDataStore()).toBe(getDataStore())
  })
})

describe('S12 slice — pagination past the 1000-row cap through the real handler', () => {
  it('walks 2,700 view rows as three pages with a chaining cursor', async () => {
    const { rows, pageSizes } = await walk({ ...FULL_RANGE, limit: '1000' })

    expect(pageSizes).toEqual([1000, 1000, 700])
    expect(rows).toHaveLength(EXPECTED_VIEW_ROWS)

    const keys = rows.map((row) => `${row.day}|${row.event_type}`)
    expect(new Set(keys).size).toBe(EXPECTED_VIEW_ROWS)

    const sorted = [...keys].sort()
    expect(keys).toEqual(sorted)

    for (const row of rows) expect(row.instance_id).toBe(ACTIVITY_SCOPE)
  }, 120_000)

  it('returns the same rows at a page size that needs many more pages', async () => {
    const big = await walk({ ...FULL_RANGE, limit: '1000' })
    const small = await walk({ ...FULL_RANGE, limit: '250' })

    expect(small.pageSizes.length).toBe(11)
    expect(small.rows).toEqual(big.rows)
  }, 180_000)

  it('rejects a limit above the shared cap and a cursor from another scope', async () => {
    const tooBig = await call({ ...FULL_RANGE, limit: '1001' })
    expect(tooBig.status).toBe(400)

    const first = await call({ ...FULL_RANGE, limit: '10' })
    const cursor = first.body.nextCursor
    expect(cursor).toBeTruthy()

    // Same cursor, different range: the digest must refuse it.
    const reused = await call({
      instance_id: ACTIVITY_SCOPE,
      from: dayAt(10),
      to: ACTIVITY_LAST_DAY,
      limit: '10',
      cursor: cursor as string,
    })
    expect(reused.status).toBe(400)
  })
})

describe('S12 slice — UTC day semantics', () => {
  it('buckets every boundary instant into its UTC calendar day', async () => {
    const { rows } = await walk({ ...FULL_RANGE, limit: '1000' })

    const byKey = new Map(rows.map((row) => [`${row.day}|${row.event_type}`, row.cnt]))
    expect(byKey.size).toBe(EXPECTED_VIEW_ROWS)

    // Every day carries exactly the counts the fixture wrote — which is only
    // true if 00:00:00Z, 23:00:00Z and 23:59:59Z all land on the same UTC day.
    for (let dayIndex = 0; dayIndex < DAY_COUNT; dayIndex++) {
      const day = dayAt(dayIndex)
      for (const eventType of ACTIVITY_EVENT_TYPES) {
        expect(byKey.get(`${day}|${eventType}`)).toBe(countForDay(dayIndex))
      }
    }

    // `day` is a calendar day, not an instant: no time part, no offset.
    for (const row of rows) expect(row.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }, 120_000)

  it('shows the view is timezone-sensitive, so pinning the session matters', async () => {
    // The view is `date_trunc('day', occurred_at)::date`, which resolves in the
    // session's `TimeZone`. This test establishes that the day buckets really do
    // depend on it, which is what makes the driver's `SET LOCAL timezone='UTC'`
    // a guarantee rather than decoration.
    //
    // Stated precisely, because the distinction is easy to overclaim: this
    // project's *default* session timezone is currently `GMT`, so the days come
    // out UTC-correct even without the preamble today. The preamble's value is
    // that the result stops depending on that default — a server-side or
    // pooler-side change, or a different provider, would otherwise silently
    // shift every day boundary in the dashboard.
    const shifted = await fixtures.asActor(ACTORS.activeMember, async (client) => {
      await client.query(`SELECT set_config('timezone', 'Asia/Tokyo', true)`)
      const result = await client.query<{ day: string; cnt: string }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, cnt::text AS cnt
           FROM public.daily_activity
          WHERE instance_id = $1 AND event_type = $2
          ORDER BY day
          LIMIT 3`,
        [ACTIVITY_SCOPE, 'invite_sent'],
      )
      return result.rows
    })

    const utc = await fixtures.asActor(ACTORS.activeMember, async (client) => {
      await client.query(`SELECT set_config('timezone', 'UTC', true)`)
      const result = await client.query<{ day: string; cnt: string }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, cnt::text AS cnt
           FROM public.daily_activity
          WHERE instance_id = $1 AND event_type = $2
          ORDER BY day
          LIMIT 3`,
        [ACTIVITY_SCOPE, 'invite_sent'],
      )
      return result.rows
    })

    expect(utc[0]?.day).toBe(ACTIVITY_FIRST_DAY)
    // Tokyo is UTC+9, so the 23:00Z events move to the following day and the
    // first day's count changes. The two readings must differ.
    expect(shifted).not.toEqual(utc)
  })

  it('agrees with leads.ts on the inclusive/exclusive boundary', () => {
    // `leads.ts` ranges are inclusive [from, to] UTC day strings; the contract's
    // range is half-open. Three days must stay three days.
    const range = dayRangeToUtcRange('2026-03-01', '2026-03-03')
    expect(range?.fromInclusive).toBe('2026-03-01T00:00:00.000Z')
    expect(range?.toExclusive).toBe('2026-03-04T00:00:00.000Z')

    // A single day is a 24-hour half-open window, not an empty one.
    const oneDay = dayRangeToUtcRange('2026-03-01', '2026-03-01')
    expect(oneDay?.fromInclusive).toBe('2026-03-01T00:00:00.000Z')
    expect(oneDay?.toExclusive).toBe('2026-03-02T00:00:00.000Z')

    // Open ends stay open.
    expect(dayRangeToUtcRange(null, null)).toBeUndefined()
    expect(dayRangeToUtcRange('2026-03-01', null)?.toExclusive).toBeUndefined()
    expect(dayRangeToUtcRange(null, '2026-03-01')?.fromInclusive).toBeUndefined()

    // Every preset `leads.ts` can produce converts without loss, and the
    // exclusive end is always exactly one day past the inclusive one.
    for (const preset of presetRanges(new Date('2026-03-15T12:34:56Z'))) {
      const converted = dayRangeToUtcRange(preset.from, preset.to)
      if (preset.from === null) {
        expect(converted).toBeUndefined()
        continue
      }
      expect(converted?.fromInclusive).toBe(`${preset.from}T00:00:00.000Z`)
      const expectedEnd = new Date(`${preset.to}T00:00:00Z`)
      expectedEnd.setUTCDate(expectedEnd.getUTCDate() + 1)
      expect(converted?.toExclusive).toBe(expectedEnd.toISOString())
    }
  })

  it('slices a leads.ts week exactly, in UTC', async () => {
    // Pick a day well inside the fixture and take its UTC ISO week, Monday to
    // Sunday, the way `weekStart` defines it.
    const anchor = dayAt(400)
    const monday = weekStart(`${anchor}T12:00:00Z`)
    const sunday = new Date(`${monday}T00:00:00Z`)
    sunday.setUTCDate(sunday.getUTCDate() + 6)

    const week: DateRange = {
      id: 'week',
      label: 'week',
      from: monday,
      to: sunday.toISOString().slice(0, 10),
    }

    const { rows } = await walk({
      instance_id: ACTIVITY_SCOPE,
      from: week.from as string,
      to: week.to as string,
      limit: '1000',
    })

    // Seven days × three event types, and not one row outside the week.
    expect(new Set(rows.map((r) => r.day)).size).toBe(7)
    expect(rows).toHaveLength(7 * ACTIVITY_EVENT_TYPES.length)
    for (const row of rows) {
      expect(row.day >= (week.from as string)).toBe(true)
      expect(row.day <= (week.to as string)).toBe(true)
    }
    expect(new Date(`${monday}T00:00:00Z`).getUTCDay()).toBe(1)
  })
})

describe('S12 — the driver defect the first real slice exposed', () => {
  it('hands a bare PostgreSQL date across the boundary as a calendar day', async () => {
    // Found by reading `daily_activity.day`. `pg` parses OID 1082 into a `Date`
    // at *local* midnight, so on this host the day 2026-01-01 arrived as
    // 2025-12-31T23:00:00.000Z — a different day, shifted by an amount that
    // follows the host's DST rather than by a constant.
    //
    // The slice's own SQL casts `day` to text and so was never exposed, but the
    // hazard is generic and S13 will select dates. Asserted here against the
    // driver directly, on its own store and its own registry, because the
    // application registry must not grow an operation that exists only for a
    // test.
    const registry = new NeonOperationRegistry()
    registry.registerQuery('test.rawDate', {
      build: () => ({
        text: `SELECT DATE '2026-01-01' AS plain_date,
                      timestamptz '2026-01-01 00:00:00+00' AS instant`,
        values: [],
      }),
      mapRow: (row) => ({
        plainDate: row.plain_date,
        instant: row.instant,
      }),
    })

    const store = new NeonDataStore({
      connectionString: connection.pooled,
      operations: registry,
      applicationName: 'lh2-s12-date-regression',
      maxConnections: 1,
    })

    try {
      const page = await store.query<{ plainDate: unknown; instant: unknown }>(
        CONTRACT_ACTORS.activeMember,
        { operation: 'test.rawDate' },
      )
      const [row] = page.items

      // A calendar day, spelled the way PostgreSQL spelled it.
      expect(row?.plainDate).toBe('2026-01-01')
      expect(typeof row?.plainDate).toBe('string')
      // An instant is still normalized to ISO-8601 UTC, unchanged from S11.
      expect(row?.instant).toBe('2026-01-01T00:00:00.000Z')

      // The host is genuinely not UTC, so the old behaviour really would have
      // shifted the day. If this ever fails, the regression is untestable here
      // and needs TZ pinned in the runner instead.
      expect(new Date('2026-01-01T00:00:00Z').getTimezoneOffset()).not.toBe(0)
    } finally {
      await store.close()
    }
  })
})

describe('S12 slice — old/new parity over one shared dataset', () => {
  it('matches the formulation the Supabase path uses, row for row', async () => {
    // The existing path is PostgREST:
    //   .from('daily_activity').select('*').gte('day', since)
    // i.e. an inclusive lower bound compared against the `date` column, with no
    // instant arithmetic. The new path takes UTC instants and converts. If those
    // two formulations ever disagree at an edge, this is where it shows.
    const windows: Array<[string, string]> = [
      [ACTIVITY_FIRST_DAY, ACTIVITY_LAST_DAY],
      [ACTIVITY_FIRST_DAY, ACTIVITY_FIRST_DAY],
      [dayAt(1), dayAt(1)],
      [dayAt(120), dayAt(150)],
      [dayAt(DAY_COUNT - 1), ACTIVITY_LAST_DAY],
    ]

    for (const [from, to] of windows) {
      const neon = await walk({
        instance_id: ACTIVITY_SCOPE,
        from,
        to,
        limit: '1000',
      })

      const legacy = await fixtures.asActor(ACTORS.activeMember, async (client) => {
        await client.query(`SELECT set_config('timezone', 'UTC', true)`)
        const result = await client.query<{
          day: string
          instance_id: string
          event_type: string
          cnt: string
        }>(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day, instance_id, event_type, cnt::text AS cnt
             FROM public.daily_activity
            WHERE instance_id = $1
              AND day >= $2::date
              AND day <= $3::date
            ORDER BY day, instance_id, event_type`,
          [ACTIVITY_SCOPE, from, to],
        )
        return result.rows.map((row) => ({
          day: row.day,
          instance_id: row.instance_id,
          event_type: row.event_type,
          cnt: Number(row.cnt),
        }))
      })

      expect(neon.rows).toEqual(legacy)
      expect(
        neon.rows.reduce((sum, row) => sum + row.cnt, 0),
      ).toBe(legacy.reduce((sum, row) => sum + row.cnt, 0))
    }
  }, 180_000)

  it('totals the same number of events as the underlying table', async () => {
    const { rows } = await walk({ ...FULL_RANGE, limit: '1000' })
    const viaView = rows.reduce((sum, row) => sum + row.cnt, 0)

    const viaTable = await fixtures.asActor(ACTORS.activeMember, async (client) => {
      const result = await client.query<{ count: string }>(
        'SELECT count(*) AS count FROM public.events WHERE instance_id = $1',
        [ACTIVITY_SCOPE],
      )
      return Number(result.rows[0]?.count ?? 0)
    })

    expect(viaView).toBe(viaTable)
    expect(viaView).toBe(EXPECTED_EVENT_ROWS)
  }, 120_000)
})

describe('S12 slice — the auth deny matrix', () => {
  it('fails an unauthenticated request closed, with the real verifier', async () => {
    stubbedSubject = null
    try {
      const denied = await call(FULL_RANGE, '')
      expect(denied.status).toBe(401)
      expect(denied.body.activity).toBeUndefined()
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }
  })

  it('fails an invalid or expired token closed, with the real verifier', async () => {
    // Assembled at runtime, never written out as a literal: a JWT-shaped string
    // in a committed file trips the repository's own secret sweep and would be a
    // permanent false positive. Same reason S11 builds URI shapes from fragments.
    const segment = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    const expiredToken = [
      segment({ alg: 'HS256', typ: 'JWT' }),
      segment({ sub: 'nobody', exp: 1 }),
      'not-a-signature',
    ].join('.')

    stubbedSubject = null
    try {
      const forged = await call(FULL_RANGE, expiredToken)
      expect(forged.status).toBe(401)
      expect(forged.body.activity).toBeUndefined()
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }
  })

  it('fails a verified user with no canonical mapping closed', async () => {
    stubbedSubject = SUBJECTS.unmapped
    try {
      const denied = await call(FULL_RANGE)
      expect(denied.status).toBe(403)
      expect(denied.body.activity).toBeUndefined()
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }
  })

  it('fails an inactive user closed — and the refusal comes from RLS', async () => {
    stubbedSubject = SUBJECTS.inactive
    try {
      const denied = await call(FULL_RANGE)
      expect(denied.status).toBe(403)
      expect(denied.body.activity).toBeUndefined()
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }

    // The handler denied because the confirming read returned nothing, and it
    // returned nothing because the policy requires `users.active` and
    // `team_members.active`. Asserted directly against the database: the same
    // actor, published the same way, sees zero identity rows and zero events —
    // while an active actor sees all of them.
    const [inactiveVisibility, activeVisibility] = await Promise.all([
      fixtures.asActor(ACTORS.inactive, async (client) => {
        const identities = await client.query(
          'SELECT 1 FROM public.user_identities WHERE provider = $1',
          ['fixture'],
        )
        const events = await client.query<{ count: string }>(
          'SELECT count(*) AS count FROM public.events WHERE instance_id = $1',
          [ACTIVITY_SCOPE],
        )
        return {
          identities: identities.rowCount ?? 0,
          events: Number(events.rows[0]?.count ?? 0),
        }
      }),
      fixtures.asActor(ACTORS.activeMember, async (client) => {
        const identities = await client.query(
          'SELECT 1 FROM public.user_identities WHERE provider = $1',
          ['fixture'],
        )
        const events = await client.query<{ count: string }>(
          'SELECT count(*) AS count FROM public.events WHERE instance_id = $1',
          [ACTIVITY_SCOPE],
        )
        return {
          identities: identities.rowCount ?? 0,
          events: Number(events.rows[0]?.count ?? 0),
        }
      }),
    ])

    expect(inactiveVisibility).toEqual({ identities: 0, events: 0 })
    expect(activeVisibility.identities).toBe(1)
    expect(activeVisibility.events).toBe(EXPECTED_EVENT_ROWS)
  }, 60_000)

  it('refuses a proposal that does not match the presented subject — also RLS', async () => {
    // The bridge is willing to propose this pairing; the policy is not, because
    // `user_identities.user_id` must equal the published actor *and* carry the
    // presented subject. A stale or tampered map cannot escalate.
    stubbedSubject = 'subject-one-mismapped'
    try {
      const denied = await call(FULL_RANGE)
      expect(denied.status).toBe(403)
      expect(denied.body.activity).toBeUndefined()
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }
  })

  it('lets an active member and an active admin both read the slice', async () => {
    for (const subject of [SUBJECTS.activeMember, SUBJECTS.activeAdmin]) {
      stubbedSubject = subject
      const allowed = await call({ ...FULL_RANGE, limit: '5' })
      expect(allowed.status).toBe(200)
      expect(allowed.body.activity).toHaveLength(5)
    }
    stubbedSubject = SUBJECTS.activeMember
  })

  it('rejects a malformed request before it reaches the database', async () => {
    expect((await call({ from: ACTIVITY_FIRST_DAY, to: ACTIVITY_LAST_DAY })).status).toBe(400)
    expect((await call({ instance_id: ACTIVITY_SCOPE, from: '2026-3-1' })).status).toBe(400)
    expect((await call({ instance_id: ACTIVITY_SCOPE, from: '2026-02-30' })).status).toBe(400)
    expect(
      (await call({ instance_id: ACTIVITY_SCOPE, from: ACTIVITY_LAST_DAY, to: ACTIVITY_FIRST_DAY }))
        .status,
    ).toBe(400)
  })

  it('reads nothing for an instance the fixture does not own', async () => {
    const empty = await call({ instance_id: 's12-does-not-exist' })
    expect(empty.status).toBe(200)
    expect(empty.body.activity).toEqual([])
    expect(empty.body.hasMore).toBe(false)
  })
})

describe('S12 slice — measured latency end to end', () => {
  it('records warm handler latency for the G2 artifact', async () => {
    // Warm the pool first; a cold connect is measured separately in S11.
    await call({ ...FULL_RANGE, limit: '1000' })

    const samples: number[] = []
    for (let i = 0; i < 10; i++) {
      const started = performance.now()
      const page = await call({ ...FULL_RANGE, limit: '1000' })
      samples.push(performance.now() - started)
      expect(page.status).toBe(200)
    }
    samples.sort((a, b) => a - b)
    const p50 = Math.round(samples[Math.floor(samples.length / 2)])
    const min = Math.round(samples[0])

    // Offset pagination is O(offset). If the last page were dramatically slower
    // than the first, offset would be the wrong default for this slice.
    const firstPage = await call({ ...FULL_RANGE, limit: '1000' })
    const lastCursor = (await call({ ...FULL_RANGE, limit: '1000' })).body.nextCursor
    const secondStart = performance.now()
    await call({ ...FULL_RANGE, limit: '1000', cursor: lastCursor as string })
    const deepPageMs = Math.round(performance.now() - secondStart)

    expect(firstPage.status).toBe(200)

    // Split the request into its two transactions, because the actor bridge is
    // a whole extra round-trip group that S13 will pay on every read.
    const store = getDataStore()
    const measure = async (label: string, run: () => Promise<unknown>) => {
      await run()
      const timings: number[] = []
      for (let i = 0; i < 10; i++) {
        const started = performance.now()
        await run()
        timings.push(performance.now() - started)
      }
      timings.sort((a, b) => a - b)
      const median = timings[Math.floor(timings.length / 2)]
      console.log(`[S12 latency] ${label}: p50 ${Math.round(median)} ms`)
      return median
    }

    // One round trip now, and no actor published: S12 measured the confirming
    // read at 196 ms of a 525 ms request, and this is the same measurement
    // against the resolver that replaced it.
    const bridgeMs = await measure('identity resolution alone', () =>
      store.resolveActor({
        provider: 'fixture',
        subject: SUBJECTS.activeMember,
      }),
    )
    const readMs = await measure('activity page of 1000 alone', () =>
      store.query(CONTRACT_ACTORS.activeMember, {
        operation: 'activity.dailySeries',
        params: { instanceId: ACTIVITY_SCOPE },
        page: { limit: 1000 },
      }),
    )

    console.log(
      `[S12 latency] warm one-page read: min ${min} ms, p50 ${p50} ms; ` +
        `page at offset 1000: ${deepPageMs} ms; ` +
        `bridge is ${Math.round((100 * bridgeMs) / (bridgeMs + readMs))}% of a ` +
        `1000-row request`,
    )

    // Loose: this is a measurement, not a performance gate. It only fails if
    // something is pathologically wrong.
    expect(p50).toBeLessThan(10_000)
  }, 120_000)
})
