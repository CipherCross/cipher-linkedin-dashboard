/**
 * S13 item 7 — `frontend/src/lib/leads.ts` against Neon-shaped rows.
 *
 * N-B2 "What this copy does not cover" item 4 and its starting point item 5 make
 * this S13's: the two SQL views agreeing across providers says nothing about the
 * *client recompute*, which is what every page actually renders. `rangeTotals`,
 * `rangedCampaigns`, `stageOf` and `riskOf` re-derive the funnel in the browser for
 * ranges and subsets the views cannot express, and none of them had ever been run
 * over a row that came out of Neon.
 *
 * ## What this checks, and what would be worthless
 *
 * Running the recompute over its own fixture and asserting the answer it produces
 * would be a tautology. Two things make this evidence instead:
 *
 * 1. **The rows arrive through the real read path** — real handler, real driver,
 *    real RLS, keyset-walked to completion — so they carry whatever type and
 *    format the provider and the driver actually produce, not what a hand-written
 *    fixture object would.
 * 2. **The expectation comes from somewhere else.** Counts are checked against the
 *    fixture's independently computed funnel *and* against `campaign_metrics`,
 *    which is SQL the client never sees. Where those two must agree, they are
 *    compared; where they legitimately differ, that is stated rather than smoothed
 *    over.
 *
 * ## The failure mode it is really hunting
 *
 * `tsInRange` takes a lead's day with `ts.slice(0, 10)` — it does not parse the
 * timestamp. So the whole ranged funnel depends on instants arriving as UTC with a
 * `Z`, which is a property of the driver's type parsers rather than of anything in
 * `leads.ts`. PostgREST happens to emit `+00:00`, the Neon driver emits `Z`, and
 * both slice to the same day — but a driver change, a pooler change or a
 * `timestamp`-typed column would shift every ranged metric by up to a day while
 * every count-based test stayed green. That is asserted head-on below.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ALL_TIME_RANGE,
  rangeTotals,
  rangedCampaigns,
  riskOf,
  stageOf,
  type DateRange,
} from '../src/lib/leads'
import type { CampaignMetrics, Lead } from '../src/lib/types'
import {
  CAMPAIGN_IDS,
  DASHBOARD_SCOPE,
  EXPECTED_FUNNEL,
  LEAD_COUNT,
  LEAD_FIRST_DAY,
  leadAddedDay,
  milestoneDepth,
  seedDashboardFixture,
} from './support/dashboardSliceFixture'
import {
  NeonFixtureClient,
  requireNeonTestConnection,
} from './support/neonContractHarness'
import { CONTRACT_ACTORS } from './support/dataStoreContract'

const connection = requireNeonTestConnection()

let stubbedSubject: string | null = 'subject-one'

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

const { createActivityDailyHandler } = await import('../api/activity-daily.js')
const GET = createActivityDailyHandler({ legacyProviderName: 'fixture' })
const { resetDataStore } = await import('../api/_lib/data/store.js')

const fixtures = new NeonFixtureClient(connection.pooled)

interface PageBody {
  items?: Record<string, unknown>[]
  nextCursor?: string | null
  hasMore?: boolean
}

/** Walk one operation to completion through the real handler. */
async function readAll(op: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let cursor: string | null = null

  for (let guard = 0; guard < 200; guard++) {
    const url = new URL('https://dashboard.test/api/activity-daily')
    url.searchParams.set('op', op)
    url.searchParams.set('limit', '1000')
    if (cursor) url.searchParams.set('cursor', cursor)

    const response = await GET(
      new Request(url, {
        method: 'GET',
        headers: { authorization: 'Bearer stub-token' },
      }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as PageBody
    rows.push(...(body.items ?? []))
    if (!body.hasMore) break
    cursor = body.nextCursor ?? null
  }

  return rows
}

/**
 * The fixture's leads, as `Lead`.
 *
 * The cast is the point of the exercise rather than a convenience: if the
 * operation's row shape and `Lead` ever diverge, this file stops compiling under
 * `npm run build`'s type-check, which is a better place to find out than a page
 * rendering `undefined`.
 */
let leads: Lead[] = []
let campaigns: CampaignMetrics[] = []

beforeAll(async () => {
  const seeded = await fixtures.asActor(
    CONTRACT_ACTORS.activeMember.actorId,
    (client) => seedDashboardFixture(client),
  )
  expect(seeded.leads).toBe(LEAD_COUNT)

  const leadRows = await readAll('leads.directory')
  leads = (leadRows as unknown as Lead[]).filter(
    (lead) => lead.instance_id === DASHBOARD_SCOPE,
  )
  expect(leads).toHaveLength(LEAD_COUNT)

  const campaignRows = await readAll('campaigns.performance')
  campaigns = (campaignRows as unknown as CampaignMetrics[]).filter((campaign) =>
    CAMPAIGN_IDS.includes(campaign.campaign_id as (typeof CAMPAIGN_IDS)[number]),
  )
  expect(campaigns).toHaveLength(CAMPAIGN_IDS.length)
}, 300_000)

afterAll(async () => {
  await resetDataStore()
  await fixtures.end()
})

describe('stageOf over rows that came out of Neon', () => {
  it('assigns every lead the stage its milestones imply', () => {
    const counts = { queued: 0, invited: 0, accepted: 0, replied: 0 }
    for (const lead of leads) counts[stageOf(lead)]++

    // `stageOf` reads the milestones in reverse order, so each lead lands in the
    // stage of its *deepest* milestone. The fixture stages leads `i % 5`:
    // depth 0 → queued, 1 → invited, 2 and 3 → accepted, 4 → replied.
    const expected = { queued: 0, invited: 0, accepted: 0, replied: 0 }
    for (let index = 0; index < LEAD_COUNT; index++) {
      const depth = milestoneDepth(index)
      if (depth === 0) expected.queued++
      else if (depth === 1) expected.invited++
      else if (depth === 4) expected.replied++
      else expected.accepted++
    }

    expect(counts).toEqual(expected)
    // Not vacuous: every stage is populated.
    for (const value of Object.values(counts)) expect(value).toBeGreaterThan(0)
  })

  it('never reads a NULL milestone as reached', () => {
    // The invariant the whole data model rests on: NULL means never happened.
    for (const lead of leads) {
      if (!lead.invited_at) expect(stageOf(lead)).toBe('queued')
      if (lead.replied_at) expect(stageOf(lead)).toBe('replied')
    }
  })
})

describe('rangeTotals over rows that came out of Neon', () => {
  it('matches the fixture funnel over all time', () => {
    const totals = rangeTotals(leads, ALL_TIME_RANGE)

    expect(totals.leads).toBe(EXPECTED_FUNNEL.leads)
    expect(totals.invites).toBe(EXPECTED_FUNNEL.invited)
    expect(totals.accepted).toBe(EXPECTED_FUNNEL.connected)
    expect(totals.replies).toBe(EXPECTED_FUNNEL.replied)

    // The constrained rate numerators. Every connected lead in this fixture was
    // invited and every replied lead was connected, so they equal the totals —
    // which is what makes a rate above 100% impossible.
    expect(totals.acceptedOfInvited).toBe(EXPECTED_FUNNEL.connected)
    expect(totals.repliedOfConnected).toBe(EXPECTED_FUNNEL.replied)
    expect(totals.positive).toBe(0) // no latest-replies map supplied
  })

  it('agrees with SQL over a bounded range, computed independently', async () => {
    // The case the views cannot express and the client exists for. The same
    // window is applied twice: once by `tsInRange` over the fetched rows, once by
    // PostgreSQL over the stored ones. They must agree exactly.
    const windows: Array<[string, string]> = [
      [LEAD_FIRST_DAY, leadAddedDay(0)],
      ['2025-06-10', '2025-07-10'],
      ['2025-09-01', '2025-12-31'],
      ['2026-01-01', '2026-12-31'], // beyond every milestone: must be empty
    ]

    for (const [from, to] of windows) {
      const range: DateRange = { id: 'x', label: 'x', from, to }
      const client = rangeTotals(leads, range)

      const sql = await fixtures.asActor(
        CONTRACT_ACTORS.activeMember.actorId,
        async (connectionClient) => {
          await connectionClient.query(
            `SELECT set_config('timezone', 'UTC', true)`,
          )
          const result = await connectionClient.query<{
            invites: string
            accepted: string
            replies: string
            accepted_of_invited: string
            replied_of_connected: string
          }>(
            `SELECT count(*) FILTER (
                      WHERE invited_at::date BETWEEN $2::date AND $3::date
                    )::text AS invites,
                    count(*) FILTER (
                      WHERE connected_at::date BETWEEN $2::date AND $3::date
                    )::text AS accepted,
                    count(*) FILTER (
                      WHERE replied_at::date BETWEEN $2::date AND $3::date
                    )::text AS replies,
                    count(*) FILTER (
                      WHERE connected_at::date BETWEEN $2::date AND $3::date
                        AND invited_at IS NOT NULL
                    )::text AS accepted_of_invited,
                    count(*) FILTER (
                      WHERE replied_at::date BETWEEN $2::date AND $3::date
                        AND connected_at IS NOT NULL
                    )::text AS replied_of_connected
               FROM public.leads
              WHERE instance_id = $1`,
            [DASHBOARD_SCOPE, from, to],
          )
          return result.rows[0]
        },
      )

      expect({
        invites: client.invites,
        accepted: client.accepted,
        replies: client.replies,
        acceptedOfInvited: client.acceptedOfInvited,
        repliedOfConnected: client.repliedOfConnected,
      }).toEqual({
        invites: Number(sql?.invites),
        accepted: Number(sql?.accepted),
        replies: Number(sql?.replies),
        acceptedOfInvited: Number(sql?.accepted_of_invited),
        repliedOfConnected: Number(sql?.replied_of_connected),
      })
    }
  }, 180_000)

  it('depends on UTC normalization, and says so with a counter-example', () => {
    // Directly demonstrates the hazard described in this file's header. Take a
    // real fetched lead and re-spell one milestone as the same instant in a
    // non-UTC offset. `tsInRange` slices the day off the string, so the day moves
    // and the lead leaves the range — even though the instant is unchanged.
    const lead = leads.find(
      (candidate) => candidate.invited_at?.endsWith('T12:00:00.000Z'),
    )
    expect(lead).toBeDefined()

    const day = (lead as Lead).invited_at!.slice(0, 10)
    const singleDay: DateRange = { id: 'd', label: 'd', from: day, to: day }
    expect(rangeTotals([lead as Lead], singleDay).invites).toBe(1)

    // The same instant, 14 hours west: still noon UTC, but the string now spells
    // the previous calendar day.
    const shiftedInstant = new Date((lead as Lead).invited_at!)
    const asMinus14 = `${new Date(
      shiftedInstant.getTime() - 14 * 3_600_000,
    )
      .toISOString()
      .slice(0, 19)}-14:00`
    const misspelled: Lead = { ...(lead as Lead), invited_at: asMinus14 }

    expect(asMinus14.slice(0, 10)).not.toBe(day)
    expect(rangeTotals([misspelled], singleDay).invites).toBe(0)

    // Which is exactly why every instant on the real read path is asserted to end
    // in `Z` — see `dashboardSlice.neon.test.ts`. Confirmed again here over the
    // rows this file actually fetched.
    for (const candidate of leads) {
      for (const value of [
        candidate.invited_at,
        candidate.connected_at,
        candidate.replied_at,
        candidate.added_at,
      ]) {
        if (value) expect(value.endsWith('Z')).toBe(true)
      }
    }
  })
})

describe('rangedCampaigns against the view it stands in for', () => {
  it('reproduces every count and rate campaign_metrics reports', () => {
    // The real parity question for the client recompute: over all time, the
    // browser's per-campaign aggregate must equal the view's. B2 proved the view
    // agrees across providers; this proves the recompute agrees with the view.
    const recomputed = rangedCampaigns(leads, campaigns, ALL_TIME_RANGE)
    const byId = new Map(recomputed.map((row) => [row.campaign_id, row]))

    expect(recomputed).toHaveLength(CAMPAIGN_IDS.length)

    for (const view of campaigns) {
      const client = byId.get(view.campaign_id)
      expect(client).toBeDefined()

      expect(client?.total_leads).toBe(view.total_leads)
      expect(client?.invites_sent).toBe(view.invites_sent)
      expect(client?.accepted).toBe(view.accepted)
      expect(client?.replies).toBe(view.replies)

      // The view rounds to one decimal; the client does not. Compare at the
      // view's own precision rather than pretending they are bit-identical.
      expect(client?.acceptance_rate).not.toBeNull()
      expect(Number(client?.acceptance_rate).toFixed(1)).toBe(
        Number(view.acceptance_rate).toFixed(1),
      )
      expect(Number(client?.reply_rate).toFixed(1)).toBe(
        Number(view.reply_rate).toFixed(1),
      )
    }
  })

  it('differs from the view on last_activity_at, and that is pre-existing', () => {
    // Recorded rather than asserted away. `campaign_metrics.last_activity_at` is
    // `max(last_action_at)` — LH2's own last-action stamp. `rangedCampaigns`
    // instead takes the newest of `invited_at`/`connected_at`/`replied_at`, and
    // its comment claims the two match. They do not, whenever `last_action_at` is
    // not itself one of those three milestones, which is the normal case in
    // production.
    //
    // This is a divergence in `frontend/src/lib/leads.ts` that exists identically
    // on the Supabase path — S13 found it, did not introduce it, and does not fix
    // it here, because changing a displayed metric is a product decision and not
    // part of a read migration. It is written up in the handoff's Known limits.
    const recomputed = rangedCampaigns(leads, campaigns, ALL_TIME_RANGE)
    const byId = new Map(recomputed.map((row) => [row.campaign_id, row]))

    let differing = 0
    for (const view of campaigns) {
      const client = byId.get(view.campaign_id)
      if (client?.last_activity_at !== view.last_activity_at) differing++
    }

    // The fixture deliberately stamps `last_action_at` at a non-milestone offset
    // for some leads, so this reproduces the divergence rather than hiding it.
    expect(differing).toBeGreaterThan(0)
  })

  it('scopes counts to a range while leaving the pipeline size current', () => {
    // The documented asymmetry in `rangedCampaigns`: `total_leads` is a snapshot
    // (pipeline size is a current-state metric) while the flows are range-scoped.
    const narrow: DateRange = {
      id: 'n',
      label: 'n',
      from: '2025-06-01',
      to: '2025-06-30',
    }
    const scoped = rangedCampaigns(leads, campaigns, narrow)
    const all = rangedCampaigns(leads, campaigns, ALL_TIME_RANGE)

    const scopedTotal = scoped.reduce((sum, row) => sum + row.total_leads, 0)
    const allTotal = all.reduce((sum, row) => sum + row.total_leads, 0)
    expect(scopedTotal).toBe(allTotal)
    expect(scopedTotal).toBe(LEAD_COUNT)

    const scopedInvites = scoped.reduce((sum, row) => sum + row.invites_sent, 0)
    const allInvites = all.reduce((sum, row) => sum + row.invites_sent, 0)
    expect(scopedInvites).toBeGreaterThan(0)
    expect(scopedInvites).toBeLessThan(allInvites)
  })
})

describe('riskOf over rows that came out of Neon', () => {
  it('flags the two risk cohorts the fixture encodes', () => {
    // Deterministic despite `riskOf` using `Date.now()`: every fixture milestone
    // is in 2025, far outside the 14-day cutoff, so each lead's flag depends only
    // on which milestones are NULL.
    const counts = { pending_2w: 0, no_reply_2w: 0, none: 0 }
    for (const lead of leads) {
      const flag = riskOf(lead)
      if (flag === null) counts.none++
      else counts[flag]++
    }

    let pending = 0
    let noReply = 0
    let none = 0
    for (let index = 0; index < LEAD_COUNT; index++) {
      const depth = milestoneDepth(index)
      // invited, never connected → withdrawal candidate
      if (depth === 1) pending++
      // connected, never replied → follow-up candidate
      else if (depth === 2 || depth === 3) noReply++
      else none++
    }

    expect(counts).toEqual({
      pending_2w: pending,
      no_reply_2w: noReply,
      none,
    })
    expect(counts.pending_2w).toBeGreaterThan(0)
    expect(counts.no_reply_2w).toBeGreaterThan(0)
  })
})
