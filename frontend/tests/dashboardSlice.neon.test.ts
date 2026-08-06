/**
 * S13 — the whole dashboard read slice, end to end against the live Neon project.
 *
 * Everything goes through the **real handler** (`api/activity-daily.ts`), the real
 * operation registry, the real driver and the real baseline RLS policies. The only
 * thing ever stubbed is the identity provider's JWT verification, and only in the
 * tests that say so — the unauthenticated and invalid-token denials run it for real.
 *
 * Modelled on `activitySlice.neon.test.ts`, deliberately: S12's five reads and
 * S13's four had only the static guard suite before this file, so the point is one
 * live surface covering all nine rather than a second style beside the first.
 *
 * Seeds its own fixtures. B2's copied tenant data is gone and re-copying is a fresh
 * owner decision, so nothing here assumes a single row of it exists.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ASSIGNED_LEADS,
  ASSIGNEE_IDS,
  CAMPAIGN_IDS,
  DASHBOARD_SCOPE,
  DELTA_SINCE,
  EXPECTED_FUNNEL,
  INBOUND_COUNT,
  LEAD_COUNT,
  OUTBOUND_COUNT,
  OUTBOUND_INSTANTS,
  RECENT_INBOUND,
  RECENT_LEADS,
  SENT_AT_GROUP,
  leadId,
  outboundWindowFrom,
  seedDashboardFixture,
} from './support/dashboardSliceFixture'
import {
  NeonFixtureClient,
  requireNeonTestConnection,
} from './support/neonContractHarness'
import { CONTRACT_ACTORS } from './support/dataStoreContract'

/** Fails the file at import if the credential is absent. */
const connection = requireNeonTestConnection()

let stubbedSubject: string | null = null

vi.mock('../api/_lib/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/_lib/auth.js')>()
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
  mismapped: 'subject-one-mismapped',
} as const

const { createActivityDailyHandler } = await import('../api/activity-daily.js')
const GET = createActivityDailyHandler({ legacyProviderName: 'fixture' })
const { resetDataStore } = await import('../api/_lib/data/store.js')

interface PageBody {
  items?: Record<string, unknown>[]
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
): Promise<{ status: number; body: PageBody }> {
  const response = await GET(request(params, token))
  return { status: response.status, body: (await response.json()) as PageBody }
}

/** Walk every page through the handler, following the opaque cursor. */
async function walk(
  params: Record<string, string>,
): Promise<{
  rows: Record<string, unknown>[]
  pageSizes: number[]
  cursors: string[]
}> {
  const rows: Record<string, unknown>[] = []
  const pageSizes: number[] = []
  const cursors: string[] = []
  let cursor: string | null = null

  for (let guard = 0; guard < 200; guard++) {
    const page = await call(cursor ? { ...params, cursor } : params)
    expect(page.status).toBe(200)
    const items = page.body.items ?? []
    rows.push(...items)
    pageSizes.push(items.length)
    if (!page.body.hasMore) break
    cursor = page.body.nextCursor ?? null
    expect(cursor).toBeTruthy()
    cursors.push(cursor as string)
  }

  return { rows, pageSizes, cursors }
}

const fixtures = new NeonFixtureClient(connection.pooled)

/** Only the fixture's own rows, out of an unscoped read. */
const mine = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
  rows.filter((row) => row.instance_id === DASHBOARD_SCOPE)

beforeAll(async () => {
  stubbedSubject = SUBJECTS.activeMember
  const seeded = await fixtures.asActor(
    CONTRACT_ACTORS.activeMember.actorId,
    (client) => seedDashboardFixture(client),
  )
  expect(seeded.leads).toBe(LEAD_COUNT)
  expect(seeded.inbound).toBe(INBOUND_COUNT)
  expect(seeded.outbound).toBe(OUTBOUND_COUNT)
}, 300_000)

afterAll(async () => {
  await resetDataStore()
  await fixtures.end()
})

// ---------------------------------------------------------------------------
// Part 1's five reads. They had only static guards before this file.
// ---------------------------------------------------------------------------

describe('S13 part 1 — the five small reads, live', () => {
  it('instances.overview returns the fixture notebook with its health fields', async () => {
    const { rows } = await walk({ op: 'instances.overview' })
    const row = rows.find((r) => r.id === DASHBOARD_SCOPE)

    expect(row).toBeDefined()
    expect(row?.label).toBe('S13 dashboard slice fixture')
    // `config` is `jsonb NOT NULL DEFAULT '{}'`, already parsed by `pg` — an
    // object, not the string `"{}"`, which is what the Health page needs.
    expect(row?.config).toEqual({})
    // Selected columns and no more: `created_at` is deliberately not projected.
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'account_avatar',
      'account_name',
      'account_url',
      'agent_version',
      'config',
      'config_updated_at',
      'id',
      'label',
      'last_sync_at',
    ])

    const ids = rows.map((r) => String(r.id))
    expect([...ids]).toEqual([...ids].sort())
  })

  it('campaigns.performance agrees with the view it reads, cell for cell', async () => {
    const { rows } = await walk({ op: 'campaigns.performance' })
    const ours = rows.filter((r) =>
      CAMPAIGN_IDS.includes(r.campaign_id as (typeof CAMPAIGN_IDS)[number]),
    )
    expect(ours).toHaveLength(CAMPAIGN_IDS.length)

    // Read the same view out of band and compare. The operation must not be
    // re-deriving the aggregate — reading the view is what makes B2's
    // cell-for-cell parity evidence still apply to this path.
    const direct = await fixtures.asActor(
      CONTRACT_ACTORS.activeMember.actorId,
      async (client) => {
        const result = await client.query(
          `SELECT campaign_id, total_leads::text AS total_leads,
                  invites_sent::text AS invites_sent, accepted::text AS accepted,
                  replies::text AS replies, acceptance_rate::text AS acceptance_rate,
                  reply_rate::text AS reply_rate
             FROM public.campaign_metrics
            WHERE instance_id = $1
            ORDER BY campaign_id`,
          [DASHBOARD_SCOPE],
        )
        return result.rows
      },
    )

    const byId = new Map(ours.map((r) => [r.campaign_id as string, r]))
    for (const expected of direct) {
      const actual = byId.get(expected.campaign_id as string)
      expect(actual).toBeDefined()
      expect(actual?.total_leads).toBe(Number(expected.total_leads))
      expect(actual?.invites_sent).toBe(Number(expected.invites_sent))
      expect(actual?.accepted).toBe(Number(expected.accepted))
      expect(actual?.replies).toBe(Number(expected.replies))
      // `round(...)` is numeric and `pg` hands numerics over as strings. The
      // browser has always held numbers here, so the coercion has to happen in
      // `mapRow` — if it regressed, this compares a string to a number.
      expect(typeof actual?.acceptance_rate).toBe('number')
      expect(actual?.acceptance_rate).toBeCloseTo(
        Number(expected.acceptance_rate),
        5,
      )
      expect(actual?.reply_rate).toBeCloseTo(Number(expected.reply_rate), 5)
    }

    // The fixture's own funnel, so the numbers are checked against an
    // expectation computed independently of any SQL.
    const totals = ours.reduce<{
      leads: number
      invited: number
      connected: number
      replied: number
    }>(
      (sum, r) => ({
        leads: sum.leads + (r.total_leads as number),
        invited: sum.invited + (r.invites_sent as number),
        connected: sum.connected + (r.accepted as number),
        replied: sum.replied + (r.replies as number),
      }),
      { leads: 0, invited: 0, connected: 0, replied: 0 },
    )
    expect(totals).toEqual({
      leads: EXPECTED_FUNNEL.leads,
      invited: EXPECTED_FUNNEL.invited,
      connected: EXPECTED_FUNNEL.connected,
      replied: EXPECTED_FUNNEL.replied,
    })
  }, 120_000)

  it('campaigns.sequenceSteps and sync.recentRuns and annotations.timeline answer', async () => {
    // The fixture writes none of these three relations, so what is asserted is
    // that each is reachable, ordered and empty-safe rather than erroring — the
    // failure mode a missing GRANT or a bad projection would produce.
    for (const op of [
      'campaigns.sequenceSteps',
      'sync.recentRuns',
      'annotations.timeline',
    ]) {
      const page = await call({ op, limit: '10' })
      expect(page.status).toBe(200)
      expect(Array.isArray(page.body.items)).toBe(true)
      expect(page.body.error).toBeUndefined()
    }
  })

  it('activity.dailySeries still answers under its new op name and its old shape', async () => {
    const named = await call({
      op: 'activity.dailySeries',
      instance_id: DASHBOARD_SCOPE,
      limit: '5',
    })
    expect(named.status).toBe(200)

    // And with no `op` at all — S12's exact request, including its response key,
    // which `#/neon-activity` and `src/lib/neonActivity.ts` still call.
    const legacyResponse = await GET(
      request({ instance_id: DASHBOARD_SCOPE, limit: '5' }),
    )
    const legacy = (await legacyResponse.json()) as PageBody & {
      activity?: unknown[]
    }
    expect(legacyResponse.status).toBe(200)
    expect(Array.isArray(legacy.activity)).toBe(true)
    expect(legacy.activity).toEqual(legacy.items)
  })

  it('serves config.readPath with no token at all, defaulting to supabase', async () => {
    // The one unauthenticated operation. It must answer without a bearer, without
    // a store and without reaching Neon — a dashboard on the Supabase path must
    // never need Neon to be told to stay where it is.
    const response = await GET(
      request({ op: 'config.readPath' }, ''),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ readPath: 'supabase' })
  })
})

// ---------------------------------------------------------------------------
// leads.directory
// ---------------------------------------------------------------------------

describe('S13 — leads.directory, keyset-paginated past the cap', () => {
  it('walks every lead as three pages with a twice-chained cursor', async () => {
    const { rows, pageSizes, cursors } = await walk({
      op: 'leads.directory',
      limit: '1000',
    })

    // Three pages, so the cursor chained twice. The last page also carries the
    // handful of pre-existing non-fixture leads, so its size is asserted as a
    // range rather than a constant.
    expect(pageSizes.length).toBeGreaterThanOrEqual(3)
    expect(cursors.length).toBe(pageSizes.length - 1)
    expect(pageSizes.slice(0, -1).every((size) => size === 1000)).toBe(true)

    const ours = mine(rows)
    expect(ours).toHaveLength(LEAD_COUNT)

    // No duplicates and no gaps: the fixture's ids are deterministic, so the set
    // is checked against the exact expected set rather than against its size.
    const ids = ours.map((r) => String(r.id))
    expect(new Set(ids).size).toBe(LEAD_COUNT)
    expect([...ids].sort()).toEqual(
      Array.from({ length: LEAD_COUNT }, (_, i) => leadId(i)).sort(),
    )

    // Ascending by id across page boundaries, over the whole unscoped read.
    const allIds = rows.map((r) => String(r.id))
    expect(allIds).toEqual([...allIds].sort())
  }, 240_000)

  it('returns identical rows at a page size needing many more pages', async () => {
    const big = await walk({ op: 'leads.directory', limit: '1000' })
    const small = await walk({ op: 'leads.directory', limit: '150' })

    expect(small.pageSizes.length).toBeGreaterThan(big.pageSizes.length)
    expect(small.rows).toEqual(big.rows)
  }, 300_000)

  it('carries the whole projection, with assigned_to as a number', async () => {
    const page = await call({ op: 'leads.directory', limit: '1' })
    expect(page.status).toBe(200)
    const row = page.body.items?.[0] as Record<string, unknown>

    // The widest Supabase rung, in full. No ladder, so every column is present
    // on every row and `null` means "not inferred" rather than "not requested".
    expect(Object.keys(row).sort()).toEqual(
      [
        'added_at',
        'age_inferred_at',
        'age_method_version',
        'age_source',
        'assigned_to',
        'birth_year_max',
        'birth_year_min',
        'campaign_id',
        'company',
        'connected_at',
        'demo_inferred_at',
        'demo_model',
        'education_start_year',
        'first_job_start_year',
        'first_message_at',
        'full_name',
        'gender',
        'gender_confidence',
        'gender_inferred_at',
        'gender_model_version',
        'headline',
        'id',
        'instance_id',
        'invited_at',
        'last_action_at',
        'lost_reason',
        'photo_path',
        'photo_synced_at',
        'pipeline_stage',
        'pipeline_stage_changed_at',
        'pipeline_substatus',
        'profile_url',
        'replied_at',
      ].sort(),
    )

    const { rows } = await walk({ op: 'leads.directory', limit: '1000' })
    const ours = mine(rows)

    // `assigned_to` is `bigint`, which `pg` hands over as a string. The browser's
    // `Lead.assigned_to` is a number and every consumer compares it numerically,
    // so a regression here would silently stop matching every owner.
    const assigned = ours.filter((r) => r.assigned_to !== null)
    expect(assigned).toHaveLength(ASSIGNED_LEADS)
    for (const row of assigned) {
      expect(typeof row.assigned_to).toBe('number')
      expect(ASSIGNEE_IDS).toContain(row.assigned_to as number)
    }

    // `gender_confidence` is `real`, `education_start_year` is `int4`. Numbers.
    const withGender = ours.find((r) => r.gender !== null)
    expect(typeof withGender?.gender_confidence).toBe('number')

    // The BEFORE INSERT trigger derived these from `education_start_year`, so
    // they arrive as trigger-computed values and prove the derived columns cross
    // the boundary as numbers and instants rather than as strings.
    const withAge = ours.find((r) => r.education_start_year !== null)
    expect(typeof withAge?.education_start_year).toBe('number')
    expect(typeof withAge?.birth_year_min).toBe('number')
    expect(typeof withAge?.birth_year_max).toBe('number')
    expect(withAge?.age_source).toBe('education')
  }, 240_000)

  it('normalizes every instant to UTC, which tsInRange depends on', async () => {
    // `tsInRange` in `frontend/src/lib/leads.ts` takes the day with
    // `ts.slice(0, 10)` — it does not parse. So a timestamp arriving with a
    // local offset instead of `Z` would put the lead in the wrong day and every
    // ranged metric would drift by up to a day, silently. This is the property
    // that makes the driver's normalization load-bearing for the client
    // recompute, not merely tidy.
    const { rows } = await walk({ op: 'leads.directory', limit: '1000' })
    const instantColumns = [
      'added_at',
      'invited_at',
      'connected_at',
      'first_message_at',
      'replied_at',
      'last_action_at',
    ] as const

    for (const row of mine(rows)) {
      for (const column of instantColumns) {
        const value = row[column]
        if (value === null) continue
        expect(typeof value).toBe('string')
        expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      }
    }
  }, 240_000)

  it('returns exactly the recent cohort for a delta refresh', async () => {
    const { rows } = await walk({
      op: 'leads.directory',
      updated_since: DELTA_SINCE,
      limit: '1000',
    })

    const ours = mine(rows)
    expect(ours).toHaveLength(RECENT_LEADS)
    // Every tenth lead by index, which is exactly what the fixture stamped.
    const expected = Array.from({ length: RECENT_LEADS }, (_, n) =>
      leadId(n * 10),
    ).sort()
    expect(ours.map((r) => String(r.id)).sort()).toEqual(expected)
  }, 120_000)

  it('ignores from/to, because updated_at is a watermark and not a window', async () => {
    // The operation takes no range. Supplying one must not narrow the read — if
    // it silently did, a caller would be filtering `updated_at` by a date they
    // meant as an activity window.
    const bare = await call({ op: 'leads.directory', limit: '5' })
    const ranged = await call({
      op: 'leads.directory',
      from: '2020-01-01',
      to: '2020-01-02',
      limit: '5',
    })

    expect(ranged.status).toBe(200)
    expect(ranged.body.items).toEqual(bare.body.items)
  })
})

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

describe('S13 — messages.inboundHistory, all-time and keyset-paginated', () => {
  it('walks every inbound reply newest-first across three pages', async () => {
    const { rows, pageSizes } = await walk({
      op: 'messages.inboundHistory',
      limit: '1000',
    })

    expect(pageSizes.length).toBeGreaterThanOrEqual(3)

    const ours = mine(rows)
    expect(ours).toHaveLength(INBOUND_COUNT)
    for (const row of ours) expect(row.direction).toBe('in')

    // Unique ids: the property a broken keyset predicate destroys first.
    const ids = rows.map((r) => Number(r.id))
    expect(new Set(ids).size).toBe(ids.length)

    // Descending by (sent_at, id) across every page boundary. Asserted pairwise
    // rather than by sorting a copy, so the failure names the boundary.
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]
      const curr = rows[i]
      const prevSent = String(prev.sent_at)
      const currSent = String(curr.sent_at)
      if (prevSent === currSent) {
        expect(Number(prev.id)).toBeGreaterThan(Number(curr.id))
      } else {
        expect(prevSent > currSent).toBe(true)
      }
    }
  }, 240_000)

  it('keeps a duplicate-timestamp group intact across a page boundary', async () => {
    // The case the `id` tiebreaker exists for, and the reason `SENT_AT_GROUP` is
    // coprime with 1,000: a group of 7 rows sharing one instant straddles the
    // boundary, so a keyset predicate on `sent_at` alone would either re-emit the
    // whole group or skip its tail. Both show up as a wrong group size.
    const { rows } = await walk({ op: 'messages.inboundHistory', limit: '1000' })
    const ours = mine(rows)

    const byInstant = new Map<string, number>()
    for (const row of ours) {
      const key = String(row.sent_at)
      byInstant.set(key, (byInstant.get(key) ?? 0) + 1)
    }

    // Every instant carries exactly the group size the fixture wrote.
    expect(byInstant.size).toBe(INBOUND_COUNT / SENT_AT_GROUP)
    for (const [, count] of byInstant) expect(count).toBe(SENT_AT_GROUP)

    // And a page boundary really does fall inside a group, so the assertion
    // above is testing what it claims to test rather than passing vacuously.
    const boundaryInstant = String(ours[999]?.sent_at)
    const boundaryNext = String(ours[1000]?.sent_at)
    expect(boundaryInstant).toBe(boundaryNext)
  }, 240_000)

  it('is not windowed — a range cannot shrink the inbound history', async () => {
    // The CLAUDE.md invariant: sentiment and durable P3 counts are rendered
    // beside all-time lead totals, so a window here undercounts them silently.
    const bare = await call({ op: 'messages.inboundHistory', limit: '10' })
    const windowed = await call({
      op: 'messages.inboundHistory',
      from: '2026-01-01',
      to: '2026-01-02',
      limit: '10',
    })

    expect(windowed.status).toBe(200)
    expect(windowed.body.items).toEqual(bare.body.items)
  })

  it('carries sentiment and the full intent set', async () => {
    const { rows } = await walk({ op: 'messages.inboundHistory', limit: '1000' })
    const ours = mine(rows)

    const p3 = ours.filter((r) => r.intent_level === 'p3')
    expect(p3.length).toBeGreaterThan(0)
    for (const row of p3) {
      expect(row.intent_taxonomy_version).toBe('p123-v1')
      expect(row.intent_classified_at).toMatch(/Z$/)
    }

    const positive = ours.filter((r) => r.sentiment === 'positive')
    expect(positive.length).toBeGreaterThan(0)

    // `id` is `bigint`; `Message.id` is a number and `mergeById` keys on it.
    for (const row of ours.slice(0, 50)) expect(typeof row.id).toBe('number')
  }, 240_000)

  it('returns exactly the recent cohort for a delta refresh', async () => {
    const { rows } = await walk({
      op: 'messages.inboundHistory',
      updated_since: DELTA_SINCE,
      limit: '1000',
    })
    expect(mine(rows)).toHaveLength(RECENT_INBOUND)
  }, 120_000)
})

describe('S13 — messages.outboundRecent, windowed', () => {
  it('honours the caller window and reads only outbound', async () => {
    // The window `DataContext` computes as 90 days, supplied explicitly so the
    // expectation is reproducible instead of drifting with the wall clock.
    const fromGroup = OUTBOUND_INSTANTS / 2 // 100
    const { rows } = await walk({
      op: 'messages.outboundRecent',
      from: outboundWindowFrom(fromGroup),
      limit: '1000',
    })

    const ours = mine(rows)
    // Groups `fromGroup`..end, `SENT_AT_GROUP` rows each.
    expect(ours).toHaveLength((OUTBOUND_INSTANTS - fromGroup) * SENT_AT_GROUP)
    for (const row of ours) {
      expect(row.direction).toBe('out')
      expect(String(row.sent_at) >= `${outboundWindowFrom(fromGroup)}T00:00:00.000Z`).toBe(true)
    }

    // Unwindowed reads the whole set, so the window is genuinely narrowing.
    const all = await walk({ op: 'messages.outboundRecent', limit: '1000' })
    expect(mine(all.rows)).toHaveLength(OUTBOUND_COUNT)
  }, 240_000)

  it('never returns an inbound row, and inbound never returns an outbound one', async () => {
    const outbound = await walk({ op: 'messages.outboundRecent', limit: '1000' })
    const inbound = await walk({ op: 'messages.inboundHistory', limit: '1000' })

    const outboundIds = new Set(outbound.rows.map((r) => Number(r.id)))
    const inboundIds = new Set(inbound.rows.map((r) => Number(r.id)))

    // The two operations partition the relation — no row is in both, which is
    // what lets the client concatenate them without deduplicating.
    for (const id of outboundIds) expect(inboundIds.has(id)).toBe(false)
  }, 240_000)
})

// ---------------------------------------------------------------------------
// The cursor itself.
// ---------------------------------------------------------------------------

describe('S13 — the keyset cursor', () => {
  it('refuses a cursor from another scope', async () => {
    const first = await call({ op: 'leads.directory', limit: '10' })
    const cursor = first.body.nextCursor
    expect(cursor).toBeTruthy()

    // Same cursor, different operation: the digest pins the operation name.
    const wrongOp = await call({
      op: 'messages.inboundHistory',
      limit: '10',
      cursor: cursor as string,
    })
    expect(wrongOp.status).toBe(400)

    // Same operation, different params: the digest pins those too.
    const wrongParams = await call({
      op: 'leads.directory',
      updated_since: DELTA_SINCE,
      limit: '10',
      cursor: cursor as string,
    })
    expect(wrongParams.status).toBe(400)
  })

  it('refuses a key of the wrong width', async () => {
    // A two-column key spliced into a one-column operation would shift every
    // later placeholder and produce a valid query about something else. Forged
    // here by re-encoding the digest with a wider payload — the digest is
    // genuine, so this isolates the arity check from the scope check.
    const first = await call({ op: 'leads.directory', limit: '10' })
    const token = first.body.nextCursor as string
    const decoded = Buffer.from(token, 'base64url').toString('utf8')
    const digest = decoded.slice(0, decoded.indexOf('.'))

    const forge = (payload: string) =>
      Buffer.from(`${digest}.${payload}`, 'utf8').toString('base64url')

    for (const payload of [
      JSON.stringify([leadId(5), 'extra']), // too wide
      JSON.stringify([]), // too narrow
      JSON.stringify({ id: leadId(5) }), // not an array
      JSON.stringify([{ nested: true }]), // right width, wrong element type
      'not-json-at-all',
    ]) {
      const denied = await call({
        op: 'leads.directory',
        limit: '10',
        cursor: forge(payload),
      })
      expect(denied.status).toBe(400)
    }
  })

  it('survives an ISO instant with milliseconds in the payload', async () => {
    // The reason the codec splits on the *first* separator. A sha256 digest in
    // base64url contains no `.`, but `2025-03-01T09:00:00.000Z` does — and
    // `lastIndexOf` would have found that one and rejected every page after the
    // first. This is the regression that mattered most in the driver change.
    const first = await call({ op: 'messages.inboundHistory', limit: '10' })
    expect(first.status).toBe(200)
    const cursor = first.body.nextCursor as string
    expect(Buffer.from(cursor, 'base64url').toString('utf8')).toContain('.000Z')

    const second = await call({
      op: 'messages.inboundHistory',
      limit: '10',
      cursor,
    })
    expect(second.status).toBe(200)
    expect(second.body.items).toHaveLength(10)
    // And it is genuinely the next page, not the first one again.
    expect(second.body.items?.[0]).not.toEqual(first.body.items?.[0])
  })

  it('records the cost of the deepest page against the first', async () => {
    // Deliberately *not* named "is faster than offset", because at this scale it
    // is not: server-side `EXPLAIN ANALYZE` puts the keyset seek to row 2000 at
    // 6.93 ms against 7.57 ms for `OFFSET 2000` and 8.23 ms for `OFFSET 0` — all
    // inside the noise, because both plans are a `Seq Scan` feeding a `top-N
    // heapsort` while the sort key has no index behind it. See the header of
    // `api/_lib/data/operations/messages.ts`.
    //
    // What this test is for is the thing that would actually regress: reaching
    // the tail must stay bounded rather than blowing up. It records the numbers
    // and fails only if something is pathologically wrong.
    const timeFirst = async (op: string) => {
      await call({ op, limit: '1000' })
      const started = performance.now()
      const page = await call({ op, limit: '1000' })
      return { ms: performance.now() - started, cursor: page.body.nextCursor }
    }

    const { ms: firstMs, cursor } = await timeFirst('messages.inboundHistory')
    let deep = cursor as string
    // Walk to the last page, then time re-reading it.
    for (;;) {
      const page = await call({
        op: 'messages.inboundHistory',
        limit: '1000',
        cursor: deep,
      })
      if (!page.body.hasMore) break
      deep = page.body.nextCursor as string
    }
    const deepStart = performance.now()
    const deepPage = await call({
      op: 'messages.inboundHistory',
      limit: '1000',
      cursor: deep,
    })
    const deepMs = performance.now() - deepStart

    expect(deepPage.status).toBe(200)
    console.log(
      `[S13 keyset] inbound first page ${Math.round(firstMs)} ms; ` +
        `deepest page ${Math.round(deepMs)} ms`,
    )
    expect(deepMs).toBeLessThan(20_000)
  }, 240_000)
})

// ---------------------------------------------------------------------------
// Authorization and malformed input, across the new operations.
// ---------------------------------------------------------------------------

describe('S13 — the auth deny matrix over every new read', () => {
  const OPS = [
    'leads.directory',
    'messages.inboundHistory',
    'messages.outboundRecent',
    'instances.overview',
    'campaigns.performance',
    // The roster joined this list with the roster slice. It is the one read here
    // that returns people rather than work, so it is the one where a credential
    // check quietly not running would matter most.
    'identity.teamRoster',
  ] as const

  it('fails unauthenticated requests closed, with the real verifier', async () => {
    stubbedSubject = null
    try {
      for (const op of OPS) {
        const denied = await call({ op }, '')
        expect(denied.status).toBe(401)
        expect(denied.body.items).toBeUndefined()
      }
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }
  })

  it('fails an invalid or expired token closed, with the real verifier', async () => {
    // Assembled at runtime: a JWT-shaped literal in a committed file trips the
    // repository's own secret sweep and would be a permanent false positive.
    const segment = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    const expiredToken = [
      segment({ alg: 'HS256', typ: 'JWT' }),
      segment({ sub: 'nobody', exp: 1 }),
      'not-a-signature',
    ].join('.')

    stubbedSubject = null
    try {
      for (const op of OPS) {
        const denied = await call({ op }, expiredToken)
        expect(denied.status).toBe(401)
      }
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }
  })

  it('fails a verified user with no canonical mapping closed', async () => {
    stubbedSubject = SUBJECTS.unmapped
    try {
      for (const op of OPS) {
        const denied = await call({ op })
        expect(denied.status).toBe(403)
        expect(denied.body.items).toBeUndefined()
      }
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }
  })

  it('fails an inactive member closed — and RLS is what refuses', async () => {
    stubbedSubject = SUBJECTS.inactive
    try {
      for (const op of OPS) {
        const denied = await call({ op })
        expect(denied.status).toBe(403)
      }
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }

    // Corroborated out of band: the same actor, published the same way, sees no
    // leads and no messages at all, while an active actor sees the fixture.
    const [inactiveView, activeView] = await Promise.all(
      [CONTRACT_ACTORS.inactive.actorId, CONTRACT_ACTORS.activeMember.actorId].map(
        (actorId) =>
          fixtures.asActor(actorId, async (client) => {
            const result = await client.query<{ leads: string; messages: string }>(
              `SELECT (SELECT count(*) FROM public.leads
                        WHERE instance_id = $1) AS leads,
                      (SELECT count(*) FROM public.messages
                        WHERE instance_id = $1) AS messages`,
              [DASHBOARD_SCOPE],
            )
            return {
              leads: Number(result.rows[0]?.leads ?? 0),
              messages: Number(result.rows[0]?.messages ?? 0),
            }
          }),
      ),
    )

    expect(inactiveView).toEqual({ leads: 0, messages: 0 })
    expect(activeView).toEqual({
      leads: LEAD_COUNT,
      messages: INBOUND_COUNT + OUTBOUND_COUNT,
    })
  }, 120_000)

  it('refuses a subject nobody has mapped to this actor — also RLS', async () => {
    stubbedSubject = SUBJECTS.mismapped
    try {
      for (const op of OPS) {
        expect((await call({ op })).status).toBe(403)
      }
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }
  })

  it('lets an active member and an active admin both read every operation', async () => {
    for (const subject of [SUBJECTS.activeMember, SUBJECTS.activeAdmin]) {
      stubbedSubject = subject
      for (const op of OPS) {
        const allowed = await call({ op, limit: '3' })
        expect(allowed.status).toBe(200)
        expect(Array.isArray(allowed.body.items)).toBe(true)
      }
    }
    stubbedSubject = SUBJECTS.activeMember
  }, 120_000)

  it('rejects malformed input before it reaches the database', async () => {
    // An operation that is not allowlisted, whatever the registry holds.
    expect((await call({ op: 'leads.everything' })).status).toBe(400)
    // `identity.teamRoster` used to be here, as the proof that the roster could
    // not be reached from the dashboard endpoint. It is allowlisted now — see
    // `dashboardSlice.test.ts`'s header for why the premise inverted — so what
    // remains asserted is that widening it to one *read* widened it to nothing
    // else: the actor resolver and the three admin commands are still refused,
    // and they are registered operations, so this is the dispatcher's allowlist
    // refusing rather than the registry.
    expect((await call({ op: 'identity.resolveActor' })).status).toBe(400)
    expect((await call({ op: 'identity.admin.invite' })).status).toBe(400)
    expect((await call({ op: 'identity.admin.setActive' })).status).toBe(400)
    expect((await call({ op: 'identity.admin.setRole' })).status).toBe(400)

    // Limits outside the shared cap.
    expect((await call({ op: 'leads.directory', limit: '1001' })).status).toBe(400)
    expect((await call({ op: 'leads.directory', limit: '0' })).status).toBe(400)
    expect((await call({ op: 'leads.directory', limit: 'ten' })).status).toBe(400)

    // The delta watermark is an instant, and a value without one is refused
    // rather than silently reinterpreted.
    for (const bad of ['2026-07-01', 'yesterday', '2026-07-01 00:00:00']) {
      const denied = await call({ op: 'leads.directory', updated_since: bad })
      expect(denied.status).toBe(400)
    }

    // An offset-shaped payload on a keyset operation.
    expect(
      (await call({ op: 'leads.directory', cursor: 'not-a-cursor' })).status,
    ).toBe(400)

    // The windowed operation still validates its days.
    expect(
      (await call({ op: 'messages.outboundRecent', from: '2026-02-30' })).status,
    ).toBe(400)
    expect(
      (await call({ op: 'messages.outboundRecent', from: '2026-3-1' })).status,
    ).toBe(400)
    expect(
      (await call({
        op: 'messages.outboundRecent',
        from: '2026-03-05',
        to: '2026-03-01',
      })).status,
    ).toBe(400)
  })

  it('accepts an offset-bearing instant and normalizes it', async () => {
    // `asUtcTimestamp` converts rather than refusing, so a client sending
    // `+02:00` gets the instant it meant. Both spellings of the same instant must
    // return the same rows.
    const zulu = await call({
      op: 'leads.directory',
      updated_since: '2026-07-01T00:00:00Z',
      limit: '5',
    })
    const offset = await call({
      op: 'leads.directory',
      updated_since: '2026-07-01T02:00:00+02:00',
      limit: '5',
    })

    expect(zulu.status).toBe(200)
    expect(offset.status).toBe(200)
    expect(offset.body.items).toEqual(zulu.body.items)
  })

  it('refuses a non-GET method', async () => {
    const response = await GET(
      new Request('https://dashboard.test/api/activity-daily?op=leads.directory', {
        method: 'POST',
        headers: { authorization: 'Bearer stub-token' },
      }),
    )
    expect(response.status).toBe(405)
  })
})
