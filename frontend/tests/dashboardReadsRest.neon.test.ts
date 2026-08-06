/**
 * The browser's read client, driven against the **real** endpoint and the live
 * Neon project.
 *
 * ## Why this exists beside `dashboardReads.test.ts`
 *
 * That file drives the client with an injected transport, so it proves what the
 * client *asks for*. It cannot prove that what it asks for is what the endpoint
 * *parses* — a client that sent `updatedSince` instead of `updated_since` would
 * pass every one of those assertions and silently return the whole relation on
 * every delta refresh. Neither half is worth much alone, which is the same split
 * `N-S13-consolidation.md` used for the PostgREST filter string.
 *
 * So here the injected transport is the handler itself: `fetchNeonDashboard` and
 * the three component readers run against `createActivityDailyHandler` → the
 * real operation registry → the real driver → the real baseline RLS policies,
 * over `s13-rest`'s fixture. Nothing is stubbed but the identity provider's JWT
 * verification, exactly as the sibling live suites stub it.
 *
 * The fixture is seeded by its own module, which is idempotent — the previous
 * sessions' warning stands: `s13-rest` living on the shared project is a
 * mutation of a shared database, not a contract.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  FOLLOW_UP_EVENT_COUNT,
  FOLLOW_UP_PAGE,
  FOLLOW_UP_STATE_COUNT,
  HISTORY_CONVERSATION_INDEX,
  HYPOTHESIS_CAMPAIGN_COUNT,
  HYPOTHESIS_COUNT,
  ICP_COUNT,
  ICP_INDUSTRY_COUNT,
  ICP_PERSONA_COUNT,
  LABELLED_CONVERSATIONS,
  LIBRARY_PREFIX,
  NOTES_LEAD_INDEX,
  PIPELINE_EVENT_COUNT,
  REST_CAMPAIGN_IDS,
  REST_INBOUND_COUNT,
  REST_LEAD_COUNT,
  REST_OUTBOUND_COUNT,
  REST_SCOPE,
  SAVED_SEARCH_COUNT,
  TOTAL_NOTE_COUNT,
  restLeadId,
  restProfileUrl,
  seedRestFixture,
} from './support/dashboardRestFixture'
import {
  NeonFixtureClient,
  requireNeonTestConnection,
} from './support/neonContractHarness'
import { CONTRACT_ACTORS } from './support/dataStoreContract'
import {
  READ_OPS,
  SYNC_RUN_LIMIT,
  fetchNeonDashboard,
  fetchNeonFollowUpHistory,
  fetchNeonLeadNotes,
  fetchNeonThread,
  fetchReadPath,
  readAll,
} from '../src/lib/dashboardReads'
import type { ApiFetch, NeonDashboardFetch } from '../src/lib/dashboardReads'

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

const SUBJECTS = { activeMember: 'subject-one' } as const

const { createActivityDailyHandler } = await import('../api/activity-daily.js')
const GET = createActivityDailyHandler({ legacyProviderName: 'fixture' })
const { resetDataStore } = await import('../api/_lib/data/store.js')

/**
 * The client's transport, wired to the handler.
 *
 * The client emits a site-relative path, which is what a browser sends; a base
 * is supplied here only so `new Request` has an absolute URL. Everything else —
 * the query string, the cursor, the parameter names — is the client's own and is
 * passed through untouched, which is the point of the file.
 */
const handlerFetch: ApiFetch = async (input) => {
  const url = new URL(String(input), 'https://dashboard.test')
  return GET(
    new Request(url, {
      method: 'GET',
      headers: { authorization: 'Bearer stub-token' },
    }),
  )
}

/** The same transport with no credential, for the unauthenticated flag lookup. */
const anonymousFetch: ApiFetch = async (input) => {
  const url = new URL(String(input), 'https://dashboard.test')
  return GET(new Request(url, { method: 'GET' }))
}

const fixtures = new NeonFixtureClient(connection.pooled)

/** Only this fixture's rows, out of an unscoped team-wide read. */
const mine = <T extends { instance_id?: string }>(rows: readonly T[]): T[] =>
  rows.filter((row) => row.instance_id === REST_SCOPE)

const mineByName = <T extends { name?: string }>(rows: readonly T[]): T[] =>
  rows.filter((row) => String(row.name ?? '').startsWith(LIBRARY_PREFIX))

/**
 * Old enough to include every seeded row. The fixture's outbound messages run
 * from 2025-10-02, well outside any 90-day window, so a realistic `since` would
 * make "did the walk return everything" and "did the window bind" the same
 * assertion — and they are different claims.
 */
const ALL_TIME = '2025-01-01'

/** A watermark after every seeded row, so a correct delta returns none of ours. */
const FUTURE = '2099-01-01T00:00:00Z'

const HISTORY_PROFILE = restProfileUrl(HISTORY_CONVERSATION_INDEX)
const NOTES_LEAD = restLeadId(NOTES_LEAD_INDEX)
/** `restIntentLevel` cycles p1/p2/p3, so index 2 is a P3 — the conversations
 *  that carry an outbound reply as well as an inbound one. */
const THREAD_PROFILE = restProfileUrl(2)

let dashboard: NeonDashboardFetch

beforeAll(async () => {
  stubbedSubject = SUBJECTS.activeMember
  const seeded = await fixtures.asActor(
    CONTRACT_ACTORS.activeMember.actorId,
    (client) => seedRestFixture(client),
  )
  expect(seeded.leads).toBe(REST_LEAD_COUNT)
  expect(seeded.inbound).toBe(REST_INBOUND_COUNT)
  expect(seeded.outbound).toBe(REST_OUTBOUND_COUNT)

  // One full load, shared by the assertions below. Re-running it per assertion
  // would walk every relation on the project several times over for no new
  // information.
  dashboard = await fetchNeonDashboard({
    since: ALL_TIME,
    updatedSince: null,
    fetchImpl: handlerFetch,
  })
}, 900_000)

afterAll(async () => {
  await resetDataStore()
  await fixtures.end()
})

describe('the flag lookup, through the real endpoint', () => {
  it('answers without a credential and reports the deployment default', async () => {
    // Unauthenticated by design: a dashboard on the Supabase path must not have
    // to reach Neon successfully just to be told to keep using Supabase.
    expect(await fetchReadPath(anonymousFetch)).toBe('supabase')
  })
})

describe('the dashboard load, end to end', () => {
  it('walks every lead past the page cap', async () => {
    // 2,140 rows at a 1,000-row page: three pages, chained twice. A walk that
    // resent its first query or stopped on the first full page returns 1,000.
    expect(mine(dashboard.leads)).toHaveLength(REST_LEAD_COUNT)
    const ids = mine(dashboard.leads).map((lead) => lead.id)
    expect(new Set(ids).size).toBe(REST_LEAD_COUNT)
  })

  it('walks both message directions and merges them newest first', async () => {
    const ours = mine(dashboard.messages)
    expect(ours).toHaveLength(REST_INBOUND_COUNT + REST_OUTBOUND_COUNT)
    expect(ours.filter((m) => m.direction === 'in')).toHaveLength(REST_INBOUND_COUNT)
    expect(ours.filter((m) => m.direction === 'out')).toHaveLength(REST_OUTBOUND_COUNT)
    for (let i = 1; i < ours.length; i++) {
      expect(ours[i - 1].sent_at >= ours[i].sent_at).toBe(true)
    }
  })

  it('walks the conversation views and keeps their differing row counts', async () => {
    // 2,100 against 2,140 by construction: forty conversations have an
    // unlabelled reply, so they have a latest message and no intent milestones.
    // A client that read the wrong view could not satisfy both.
    expect(mine(dashboard.conversationReplyIntents)).toHaveLength(LABELLED_CONVERSATIONS)
    expect(mine(dashboard.latestConversationMessages)).toHaveLength(REST_LEAD_COUNT)
    expect(mine(dashboard.followUpStates)).toHaveLength(FOLLOW_UP_STATE_COUNT)
    expect(dashboard.followUpsAvailable).toBe(true)
  })

  it('walks the append-only pipeline log', async () => {
    const ours = dashboard.pipelineEvents.filter((e) => e.actor === REST_SCOPE)
    expect(ours).toHaveLength(PIPELINE_EVENT_COUNT)
  })

  it('reads the sourcing library, each relation present and shaped', async () => {
    expect(mineByName(dashboard.savedSearches)).toHaveLength(SAVED_SEARCH_COUNT)
    expect(mineByName(dashboard.icps)).toHaveLength(ICP_COUNT)
    expect(mineByName(dashboard.hypotheses)).toHaveLength(HYPOTHESIS_COUNT)
    const icpIds = new Set(mineByName(dashboard.icps).map((icp) => icp.id))
    // `icp_personas` and `icp_industries` carry no name this fixture controls,
    // so they are proved by parent id — narrower, and recorded as such in
    // `N-S13-part3.md` Known limit 11.
    expect(dashboard.icpPersonas.filter((p) => icpIds.has(p.icp_id))).toHaveLength(
      ICP_PERSONA_COUNT,
    )
    expect(dashboard.icpIndustries.filter((x) => icpIds.has(x.icp_id))).toHaveLength(
      ICP_INDUSTRY_COUNT,
    )
    expect(
      dashboard.hypothesisCampaigns.filter((hc) =>
        (REST_CAMPAIGN_IDS as readonly string[]).includes(hc.campaign_id),
      ),
    ).toHaveLength(HYPOTHESIS_CAMPAIGN_COUNT)
    // `text[]` and `jsonb` survive the JSON round trip as an array and an object.
    const search = mineByName(dashboard.savedSearches)[0]
    expect(Array.isArray(search.include_keywords)).toBe(true)
    expect(typeof search.filters).toBe('object')
  })

  it('takes the newest sync runs as a single bounded page', async () => {
    expect(dashboard.syncRuns.length).toBeLessThanOrEqual(SYNC_RUN_LIMIT)
  })

  /**
   * The roster, through `public.team_roster()` and the real RLS policies.
   *
   * Asserted on the **three S06 identity fixtures**, which are immutable and
   * whose ids, names and canonical uuids are already committed in
   * `postgres/tests/portable_identity_roles_rls_fixture_seed.sql`. The project
   * also holds S17's real admin; nothing here asserts, prints or counts that
   * row — a count would make this test fail the day a real teammate is added,
   * and printing a real person's name into a repository test is exactly what B2
   * refused to do.
   */
  describe('the roster', () => {
    const FIXTURE_IDS = {
      activeOne: '00000000-0000-0000-0000-000000000001',
      activeTwo: '00000000-0000-0000-0000-000000000002',
      inactiveThree: '00000000-0000-0000-0000-000000000003',
    } as const

    it('returns the whole team to an ordinary member, not just the caller', async () => {
      // The point of the function. `team_members_active_actor_select` restricts
      // `app_runtime` to the caller's own row, so a direct table read here would
      // answer with **one** member — and the Team page would state "1 Active
      // teammate". Three distinct fixtures coming back is what proves the read
      // goes through the `SECURITY DEFINER` function instead.
      const names = dashboard.teamMembers.map((member) => member.name)
      expect(names).toContain('Active One')
      expect(names).toContain('Active Two')
      expect(names).toContain('Inactive Three')
    })

    it('includes inactive members, so the directory can say so', async () => {
      const inactive = dashboard.teamMembers.find((m) => m.name === 'Inactive Three')
      expect(inactive?.active).toBe(false)
      const active = dashboard.teamMembers.find((m) => m.name === 'Active One')
      expect(active?.active).toBe(true)
    })

    it('carries the role the fixtures declare', async () => {
      // "Active Two" is the admin, and `portable_identity_atomic_invite_assertions`
      // asserts fixture 1 is *not* one. A roster that mislabelled either would
      // put a shield on the wrong row.
      expect(dashboard.teamMembers.find((m) => m.name === 'Active Two')?.role).toBe('admin')
      expect(dashboard.teamMembers.find((m) => m.name === 'Active One')?.role).toBe('member')
    })

    it('hands the browser the bigint and never the uuid', async () => {
      // The silent-mistake guard. A roster row carries `team_members.id`
      // (bigint) and `users.id` (uuid), the admin functions take the uuid and
      // the Supabase-shaped `TeamMember` keys on the bigint; crossing them
      // type-checks. `toTeamMember` drops the uuid, and this is what proves the
      // real payload does too.
      const serialized = JSON.stringify(dashboard.teamMembers)
      for (const uuid of Object.values(FIXTURE_IDS)) {
        expect(serialized).not.toContain(uuid)
      }
      for (const row of dashboard.teamMembers) {
        expect(Number.isInteger(row.id)).toBe(true)
        // Null on this path by construction: there is no Supabase Auth user
        // behind a `team_roster()` row, and the Team page reads "is a login"
        // from the baseline's `user_id NOT NULL` instead.
        expect(row.auth_user_id).toBeNull()
      }
    })

    it('is ordered totally, which is what makes an offset walk safe', async () => {
      // No keyset, so the driver pages it with LIMIT/OFFSET — correct only over
      // a total order. `name` alone is not unique; the tiebreak is `id`.
      const rows = dashboard.teamMembers
      for (let i = 1; i < rows.length; i++) {
        const previous = rows[i - 1]
        const current = rows[i]
        expect(
          previous.name < current.name ||
            (previous.name === current.name && previous.id < current.id),
        ).toBe(true)
      }
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
    })

    it('refuses the roster to a caller with no credential', async () => {
      // The flag lookup is the *only* unauthenticated operation on this
      // endpoint, and the roster is the read where that mattering is easiest to
      // see: it returns people.
      const denied = await anonymousFetch(
        `/api/activity-daily?op=${encodeURIComponent(READ_OPS.teamRoster)}`,
      )
      expect(denied.status).toBe(401)
    })
  })
})

describe('the parameters the endpoint actually parses', () => {
  it('binds the outbound window while leaving the inbound history all-time', async () => {
    // The asymmetry, proved against real rows rather than against a recorded
    // query string. The fixture's outbound messages start 2025-10-02, so a
    // window opening in 2026 must exclude some of them and none of the inbound.
    const bounded = await readAll<{ instance_id: string }>(
      READ_OPS.outboundMessages,
      { from: '2026-05-01' },
      handlerFetch,
    )
    const boundedOurs = mine(bounded.items)
    expect(boundedOurs.length).toBeGreaterThan(0)
    expect(boundedOurs.length).toBeLessThan(REST_OUTBOUND_COUNT)

    const inbound = await readAll<{ instance_id: string }>(
      READ_OPS.inboundMessages,
      {},
      handlerFetch,
    )
    expect(mine(inbound.items)).toHaveLength(REST_INBOUND_COUNT)
  })

  it('binds the delta watermark the endpoint reads, not one it ignores', async () => {
    // The failure this catches is silent by nature: an unparsed watermark simply
    // returns the whole relation, and every row the caller expected is present.
    // Only a watermark that excludes everything makes it visible.
    //
    // Driven through `fetchNeonDashboard` rather than through `readAll` with the
    // parameter written out here, and that is the whole point of the test: a
    // hand-written `updated_since` would prove the *endpoint* parses it while
    // leaving the client free to send `updatedSince` and refetch the world on
    // every five-minute tick. The mutation pass confirms this reddens for that.
    const nothingNew = await fetchNeonDashboard({
      since: ALL_TIME,
      updatedSince: FUTURE,
      fetchImpl: handlerFetch,
    })
    expect(mine(nothingNew.leads)).toHaveLength(0)
    expect(mine(nothingNew.messages)).toHaveLength(0)
    expect(
      nothingNew.pipelineEvents.filter((e) => e.actor === REST_SCOPE),
    ).toHaveLength(0)

    // And the relations that carry no watermark are re-read whole, exactly as
    // the Supabase path re-reads them on every cycle.
    expect(mine(nothingNew.followUpStates)).toHaveLength(FOLLOW_UP_STATE_COUNT)
  })
})

describe('the three component reads, end to end', () => {
  it('returns one conversation’s whole thread, oldest first, both directions', async () => {
    const thread = await fetchNeonThread(REST_SCOPE, THREAD_PROFILE, handlerFetch)
    expect(thread.length).toBeGreaterThanOrEqual(2)
    expect(new Set(thread.map((m) => m.direction))).toEqual(new Set(['in', 'out']))
    for (let i = 1; i < thread.length; i++) {
      expect(thread[i - 1].sent_at <= thread[i].sent_at).toBe(true)
    }
    // The intent columns the Supabase path's middle ladder rung silently drops.
    expect(thread.some((m) => m.intent_level !== null)).toBe(true)
  })

  it('refuses to merge two accounts’ threads for the same profile', async () => {
    // The rule `CLAUDE.md` states and the schema encodes: the same person can be
    // reached from two LinkedIn accounts.
    const wrongNotebook = await fetchNeonThread('s13-nobody', THREAD_PROFILE, handlerFetch)
    expect(wrongNotebook).toEqual([])
  })

  it('returns one lead’s notes newest first, with the null timestamp first', async () => {
    const notes = await fetchNeonLeadNotes(NOTES_LEAD, handlerFetch)
    expect(notes).toHaveLength(TOTAL_NOTE_COUNT)
    expect(notes[0].created_at).toBeNull()
    for (let i = 2; i < notes.length; i++) {
      expect(String(notes[i - 1].created_at) > String(notes[i].created_at)).toBe(true)
    }
  })

  it('pages a follow-up history on the server’s cursor without skipping the planted inversion', async () => {
    const collected: { id: number; occurred_at: string }[] = []
    const sizes: number[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard++) {
      const page = await fetchNeonFollowUpHistory(
        REST_SCOPE,
        HISTORY_PROFILE,
        FOLLOW_UP_PAGE,
        cursor,
        handlerFetch,
      )
      collected.push(...page.events)
      sizes.push(page.events.length)
      if (!page.hasMore || page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(collected).toHaveLength(FOLLOW_UP_EVENT_COUNT)
    expect(sizes).toEqual([FOLLOW_UP_PAGE, FOLLOW_UP_PAGE, 20])
    expect(new Set(collected.map((e) => e.id)).size).toBe(FOLLOW_UP_EVENT_COUNT)
    // Strictly descending on the whole sort key, across the boundary the
    // fixture's `(occurred_at, id)` inversion is planted at — the row an
    // `id`-only seek skips.
    for (let i = 1; i < collected.length; i++) {
      const previous = collected[i - 1]
      const current = collected[i]
      const ordered =
        previous.occurred_at > current.occurred_at ||
        (previous.occurred_at === current.occurred_at && previous.id > current.id)
      expect(ordered, `row ${i} is out of order`).toBe(true)
    }
  })
})
