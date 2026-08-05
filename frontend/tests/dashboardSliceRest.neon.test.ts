/**
 * S13 part 3 — the rest of the read slice, end to end against the live Neon
 * project.
 *
 * Same shape as `dashboardSlice.neon.test.ts` and deliberately so: the **real
 * handler** (`api/activity-daily.ts`), the real operation registry, the real
 * driver and the real baseline RLS policies. The only thing ever stubbed is the
 * identity provider's JWT verification, and only where a test says so — the
 * unauthenticated and invalid-token denials run it for real.
 *
 * Thirteen operations are covered here: the four medium relations, the six
 * tolerated library reads and the three reads that used to live inside a
 * component. It seeds its own fixtures under `s13-rest` and assumes no row of any
 * other session's.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ARCHIVED_FOLLOW_UPS,
  FOLLOW_UP_EVENT_COUNT,
  FOLLOW_UP_PAGE,
  FOLLOW_UP_STATE_COUNT,
  HISTORY_CONVERSATION_INDEX,
  HYPOTHESIS_CAMPAIGN_COUNT,
  HYPOTHESIS_COUNT,
  ICP_COUNT,
  ICP_INDUSTRY_COUNT,
  ICP_PERSONA_COUNT,
  INVERTED_INDICES,
  LABELLED_CONVERSATIONS,
  LIBRARY_PREFIX,
  NOTES_LEAD_INDEX,
  OWNED_FOLLOW_UPS,
  OWNER_IDS,
  P3_CONVERSATIONS,
  PIPELINE_EVENT_COUNT,
  PIPELINE_GROUP,
  REST_CAMPAIGN_IDS,
  REST_INBOUND_COUNT,
  REST_LEAD_COUNT,
  REST_OUTBOUND_COUNT,
  REST_SCOPE,
  SAVED_SEARCH_COUNT,
  TOTAL_NOTE_COUNT,
  pipelineOccurredAt,
  restIntentLevel,
  restLeadId,
  restProfileUrl,
  seedRestFixture,
} from './support/dashboardRestFixture'
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
const { NeonDataStore, NeonOperationRegistry } = await import(
  '../api/_lib/data/neon.js'
)
const { DataStoreSchemaError, DataStoreTransactionError } = await import(
  '../api/_lib/data/contracts.js'
)

interface PageBody {
  items?: Record<string, unknown>[]
  nextCursor?: string | null
  hasMore?: boolean
  unavailable?: boolean
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

  for (let guard = 0; guard < 500; guard++) {
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

/** Only this fixture's own rows, out of an unscoped, team-wide read. */
const mine = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
  rows.filter((row) => row.instance_id === REST_SCOPE)

/** Only this fixture's own library rows, which the schema does not scope. */
const mineByName = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
  rows.filter((row) => String(row.name ?? '').startsWith(LIBRARY_PREFIX))

const HISTORY_PROFILE = restProfileUrl(HISTORY_CONVERSATION_INDEX)
const NOTES_LEAD = restLeadId(NOTES_LEAD_INDEX)

beforeAll(async () => {
  stubbedSubject = SUBJECTS.activeMember
  const seeded = await fixtures.asActor(
    CONTRACT_ACTORS.activeMember.actorId,
    (client) => seedRestFixture(client),
  )

  // Every count asserted, so a partially-applied fixture fails here rather than
  // producing a plausible-looking number in a later assertion.
  expect(seeded.leads).toBe(REST_LEAD_COUNT)
  expect(seeded.inbound).toBe(REST_INBOUND_COUNT)
  expect(seeded.outbound).toBe(REST_OUTBOUND_COUNT)
  expect(seeded.followUpStates).toBe(FOLLOW_UP_STATE_COUNT)
  expect(seeded.followUpEvents).toBe(FOLLOW_UP_EVENT_COUNT)
  expect(seeded.pipelineEvents).toBe(PIPELINE_EVENT_COUNT)
  expect(seeded.notes).toBe(TOTAL_NOTE_COUNT)

  // The two views' row counts differ *by construction* — 40 conversations have an
  // unlabelled reply, so they have a latest message and no intent milestones. A
  // test that read the wrong view could not pass both of these.
  expect(seeded.replyIntentRows).toBe(LABELLED_CONVERSATIONS)
  expect(seeded.latestMessageRows).toBe(REST_LEAD_COUNT)
}, 600_000)

afterAll(async () => {
  await resetDataStore()
  await fixtures.end()
})

// ---------------------------------------------------------------------------
// pipeline.eventLog
// ---------------------------------------------------------------------------

describe('S13 — pipeline.eventLog, the append-only audit log', () => {
  it('walks the whole log in ascending order across three pages', async () => {
    const { rows, pageSizes, cursors } = await walk({
      op: 'pipeline.eventLog',
      limit: '1000',
    })
    const ours = rows.filter((row) => row.actor === REST_SCOPE)

    expect(ours).toHaveLength(PIPELINE_EVENT_COUNT)
    expect(pageSizes.length).toBeGreaterThanOrEqual(3)
    expect(cursors.length).toBeGreaterThanOrEqual(2)

    // No row twice, which is the failure an off-by-one in the seek produces.
    const ids = ours.map((row) => Number(row.id))
    expect(new Set(ids).size).toBe(PIPELINE_EVENT_COUNT)

    // Strictly ascending on `(occurred_at, id)`, pairwise, across page boundaries.
    for (let index = 1; index < ours.length; index++) {
      const previous = ours[index - 1]
      const current = ours[index]
      const before =
        String(previous.occurred_at) < String(current.occurred_at) ||
        (previous.occurred_at === current.occurred_at &&
          Number(previous.id) < Number(current.id))
      expect(before).toBe(true)
    }
  }, 300_000)

  it('keeps a duplicate-occurred_at group intact across a page boundary', async () => {
    // The property the fixture is shaped for. `PIPELINE_GROUP` is 7, which is
    // coprime with the 1,000-row page size, so a group of rows sharing one instant
    // *must* straddle a boundary — and that is exactly the case that breaks when
    // `id` leaves the sort key or the seek predicate.
    const { rows, pageSizes } = await walk({
      op: 'pipeline.eventLog',
      limit: '1000',
    })
    const ours = rows.filter((row) => row.actor === REST_SCOPE)

    const groups = new Map<string, number>()
    for (const row of ours) {
      const key = String(row.occurred_at)
      groups.set(key, (groups.get(key) ?? 0) + 1)
    }
    // Every group complete, none split or duplicated.
    for (const [, size] of groups) expect(size).toBe(PIPELINE_GROUP)

    // And the boundary genuinely falls inside a group, so the test above cannot
    // pass vacuously. Positions are relative to this fixture's own rows, so the
    // boundary is located by walking the page sizes.
    const firstPage = pageSizes[0]
    const boundaryIndex = ours.findIndex(
      (row) => rows.indexOf(row) >= firstPage,
    )
    expect(boundaryIndex).toBeGreaterThan(0)
    expect(String(ours[boundaryIndex - 1].occurred_at)).toBe(
      String(ours[boundaryIndex].occurred_at),
    )
  }, 300_000)

  it('carries the projection the browser expects, ids as numbers', async () => {
    const { body } = await call({ op: 'pipeline.eventLog', limit: '1000' })
    const row = (body.items ?? []).find((item) => item.actor === REST_SCOPE)

    expect(row).toBeDefined()
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'actor',
      'from_assignee',
      'from_stage',
      'from_substatus',
      'id',
      'kind',
      'lead_id',
      'lost_reason',
      'occurred_at',
      'to_assignee',
      'to_stage',
      'to_substatus',
    ])
    // `bigint` arrives from `pg` as a string; `mergeById` in the browser keys on a
    // number, so the coercion has to happen in `mapRow`.
    expect(typeof row?.id).toBe('number')
    expect(typeof row?.lead_id).toBe('string')
    // The assignment events snapshot a member *name*, never an id.
    const assignment = (body.items ?? []).find(
      (item) => item.actor === REST_SCOPE && item.kind === 'assignment',
    )
    expect(typeof assignment?.to_assignee).toBe('string')
    expect(assignment?.to_assignee).toMatch(/^S13R Owner /)
  })

  it('filters a delta on occurred_since, and ignores from/to', async () => {
    // Half the log, by instant: groups 150..299 of 300.
    const half = pipelineOccurredAt(150 * PIPELINE_GROUP)
    const delta = await walk({
      op: 'pipeline.eventLog',
      limit: '1000',
      occurred_since: half,
    })
    const ours = delta.rows.filter((row) => row.actor === REST_SCOPE)
    expect(ours).toHaveLength(PIPELINE_EVENT_COUNT / 2)
    for (const row of ours) {
      expect(String(row.occurred_at) >= half).toBe(true)
    }

    // `from`/`to` are not this operation's vocabulary. Supplying them must not
    // change the rows — a caller that passed the dashboard's 90-day display window
    // here would otherwise shrink "ever reached stage X" for the whole team.
    const windowed = await call({
      op: 'pipeline.eventLog',
      limit: '5',
      from: '2025-11-01',
      to: '2025-11-02',
    })
    const unwindowed = await call({ op: 'pipeline.eventLog', limit: '5' })
    expect(windowed.status).toBe(200)
    expect(windowed.body.items).toEqual(unwindowed.body.items)
  }, 300_000)
})

// ---------------------------------------------------------------------------
// conversations.replyIntent — the read that is truncating today
// ---------------------------------------------------------------------------

describe('S13 — conversations.replyIntent, paginated past the cap', () => {
  it('returns every labelled conversation, well past PostgREST 1,000-row cap', async () => {
    // This is the assertion the whole part exists for. `DataContext.tsx:636`
    // fetches this view unpaginated, so on the running dashboard it stops at
    // 1,000 rows and every conversation past the thousandth silently loses its P3
    // milestone. Here the walk is complete.
    const { rows, pageSizes, cursors } = await walk({
      op: 'conversations.replyIntent',
      limit: '1000',
    })
    const ours = mine(rows)

    expect(ours).toHaveLength(LABELLED_CONVERSATIONS)
    expect(LABELLED_CONVERSATIONS).toBeGreaterThan(1_000)
    expect(pageSizes.length).toBeGreaterThanOrEqual(3)
    expect(cursors.length).toBeGreaterThanOrEqual(2)

    // The sort key is the view's grouping key. No constraint declares it unique,
    // so it is proved over the walk rather than read off the schema.
    const keys = ours.map((row) => `${row.instance_id}|${row.profile_url}`)
    expect(new Set(keys).size).toBe(LABELLED_CONVERSATIONS)

    // Strictly ascending on `(instance_id, profile_url)` across boundaries.
    for (let index = 1; index < keys.length; index++) {
      expect(keys[index - 1] < keys[index]).toBe(true)
    }
  }, 300_000)

  it('returns identical rows at a page size needing many more pages', async () => {
    const wide = await walk({ op: 'conversations.replyIntent', limit: '1000' })
    const narrow = await walk({ op: 'conversations.replyIntent', limit: '150' })
    expect(mine(narrow.rows)).toEqual(mine(wide.rows))
    expect(narrow.pageSizes.length).toBeGreaterThan(wide.pageSizes.length)
  }, 300_000)

  it('carries the intent milestones, including the post-P3 chronology', async () => {
    const { rows } = await walk({ op: 'conversations.replyIntent', limit: '1000' })
    const ours = mine(rows)

    const byIntent = new Map<string, number>()
    for (const row of ours) {
      const level = String(row.highest_intent)
      byIntent.set(level, (byIntent.get(level) ?? 0) + 1)
    }
    // A third each, from the fixture's `index % 3`.
    expect(byIntent.get('p1')).toBe(LABELLED_CONVERSATIONS / 3)
    expect(byIntent.get('p2')).toBe(LABELLED_CONVERSATIONS / 3)
    expect(byIntent.get('p3')).toBe(P3_CONVERSATIONS)

    const p3 = ours.filter((row) => row.highest_intent === 'p3')
    expect(p3).toHaveLength(P3_CONVERSATIONS)
    for (const row of p3) {
      expect(row.first_p3_at).not.toBeNull()
      expect(row.first_p1_at).toBeNull()
      // The fixture gives every P3 conversation one outbound message a day later,
      // so the view's `LEFT JOIN` branch is exercised rather than assumed.
      expect(row.last_out_after_p3_at).not.toBeNull()
      expect(String(row.last_out_after_p3_at) > String(row.first_p3_at)).toBe(true)
      expect(row.last_in_after_p3_at).toBeNull()
      expect(REST_CAMPAIGN_IDS).toContain(row.first_p3_campaign_id)
    }

    // Every instant is UTC with a `Z` and milliseconds — the property
    // `leads.ts`'s `tsInRange` depends on, since it slices rather than parses.
    for (const row of p3.slice(0, 50)) {
      expect(String(row.first_p3_at)).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      )
    }

    const unlabelled = restProfileUrl(REST_LEAD_COUNT - 1)
    expect(restIntentLevel(REST_LEAD_COUNT - 1)).toBeNull()
    // A conversation with an unlabelled reply has no row in this view at all.
    expect(ours.some((row) => row.profile_url === unlabelled)).toBe(false)
  }, 300_000)
})

// ---------------------------------------------------------------------------
// conversations.latestMessage and conversations.followUpState
// ---------------------------------------------------------------------------

describe('S13 — the other two conversation-keyed reads', () => {
  it('latestMessage returns one row per conversation, with the newest message', async () => {
    const { rows, cursors } = await walk({
      op: 'conversations.latestMessage',
      limit: '1000',
    })
    const ours = mine(rows)

    // More rows than `replyIntent` has, by exactly the unlabelled conversations.
    expect(ours).toHaveLength(REST_LEAD_COUNT)
    expect(ours.length).toBeGreaterThan(LABELLED_CONVERSATIONS)
    expect(cursors.length).toBeGreaterThanOrEqual(2)

    const keys = ours.map((row) => `${row.instance_id}|${row.profile_url}`)
    expect(new Set(keys).size).toBe(REST_LEAD_COUNT)

    expect(Object.keys(ours[0]).sort()).toEqual([
      'body',
      'direction',
      'instance_id',
      'message_id',
      'profile_url',
      'sent_at',
      'source',
    ])
    expect(typeof ours[0].message_id).toBe('number')

    // The P3 conversations received an outbound reply a day after the inbound one,
    // so for exactly those the newest message is outbound. That is a property of
    // the view's `DISTINCT ON … ORDER BY sent_at DESC`, and it is the cheapest
    // available proof that the read is answering from the view rather than from a
    // re-derived guess.
    const outbound = ours.filter((row) => row.direction === 'out')
    expect(outbound).toHaveLength(P3_CONVERSATIONS)
    for (const row of outbound.slice(0, 20)) {
      const index = Number(String(row.profile_url).split('/').pop())
      expect(restIntentLevel(index)).toBe('p3')
      expect(String(row.body)).toMatch(/^S13R outbound /)
    }
  }, 300_000)

  it('followUpState carries owner_id as an unresolved number and the due date as a day', async () => {
    const { rows, cursors } = await walk({
      op: 'conversations.followUpState',
      limit: '1000',
    })
    const ours = mine(rows)

    expect(ours).toHaveLength(FOLLOW_UP_STATE_COUNT)
    expect(cursors.length).toBeGreaterThanOrEqual(2)

    expect(Object.keys(ours[0]).sort()).toEqual([
      'archived_at',
      'created_at',
      'instance_id',
      'last_event_id',
      'last_mutation_id',
      'next_follow_up_date',
      'owner_id',
      'profile_url',
      'revision',
      'updated_at',
      'updated_by',
    ])

    const owned = ours.filter((row) => row.owner_id !== null)
    expect(owned).toHaveLength(OWNED_FOLLOW_UPS)
    for (const row of owned) {
      // A number, never a string — and never a name. The id crosses the boundary
      // unresolved because the two providers' id spaces denote different people;
      // the browser holds the roster that interprets it. See N-B2.
      expect(typeof row.owner_id).toBe('number')
      expect(OWNER_IDS).toContain(row.owner_id)
    }

    expect(ours.filter((row) => row.archived_at !== null)).toHaveLength(
      ARCHIVED_FOLLOW_UPS,
    )

    // A `date`, not an instant: a follow-up is due on a calendar day, and the
    // browser compares it against `YYYY-MM-DD` strings from `presetRanges`.
    for (const row of ours.slice(0, 50)) {
      expect(String(row.next_follow_up_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    // `revision` is a `bigint` in the schema and a number in the browser.
    expect(typeof ours[0].revision).toBe('number')
  }, 300_000)
})

// ---------------------------------------------------------------------------
// conversations.followUpHistory — and the order disagreement it survives
// ---------------------------------------------------------------------------

describe('S13 — conversations.followUpHistory', () => {
  const params = {
    op: 'conversations.followUpHistory',
    instance_id: REST_SCOPE,
    profile_url: HISTORY_PROFILE,
    limit: String(FOLLOW_UP_PAGE),
  }

  it('walks one conversation newest-first at the panel own page size', async () => {
    const { rows, pageSizes } = await walk(params)

    expect(rows).toHaveLength(FOLLOW_UP_EVENT_COUNT)
    // 120 events at 50 per page: three pages, the last one short.
    expect(pageSizes).toEqual([
      FOLLOW_UP_PAGE,
      FOLLOW_UP_PAGE,
      FOLLOW_UP_EVENT_COUNT - 2 * FOLLOW_UP_PAGE,
    ])
    expect(new Set(rows.map((row) => Number(row.id))).size).toBe(
      FOLLOW_UP_EVENT_COUNT,
    )

    // Strictly descending on `(occurred_at, id)` pairwise.
    for (let index = 1; index < rows.length; index++) {
      const previous = rows[index - 1]
      const current = rows[index]
      const after =
        String(previous.occurred_at) > String(current.occurred_at) ||
        (previous.occurred_at === current.occurred_at &&
          Number(previous.id) > Number(current.id))
      expect(after).toBe(true)
    }

    expect(Object.keys(rows[0]).sort()).toEqual([
      'actor',
      'event_kind',
      'event_ordinal',
      'id',
      'instance_id',
      'mutation_id',
      'new_due_date',
      'new_owner_id',
      'new_owner_name',
      'occurred_at',
      'previous_due_date',
      'previous_owner_id',
      'previous_owner_name',
      'profile_url',
      'reason',
      'request_fingerprint',
      'state_revision',
    ])
    // The owner *name* snapshots are what make this readable with no roster.
    const scheduled = rows.find((row) => row.event_kind === 'scheduled')
    expect(String(scheduled?.new_owner_name)).toMatch(/^S13R Owner /)
    expect(scheduled?.new_owner_id).toBeNull()
    expect(String(scheduled?.new_due_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('survives an id/occurred_at order disagreement that an id-only seek does not', async () => {
    // The fixture plants one: two adjacent events have their `occurred_at`
    // swapped, so at that point `id` does not descend with `occurred_at`. This is
    // the situation `FollowUpPanel.tsx:112` gets wrong — it orders by
    // `(occurred_at DESC, id DESC)` and then pages with `.lt('id', lastId)`.
    //
    // First: confirm the disagreement is really in the seeded data, so neither
    // assertion below can pass vacuously.
    const ordered = await fixtures.asActor(
      CONTRACT_ACTORS.activeMember.actorId,
      async (client) => {
        const result = await client.query<{ id: string; occurred_at: Date }>(
          `SELECT id::text AS id, occurred_at
             FROM public.follow_up_events
            WHERE instance_id = $1 AND profile_url = $2
            ORDER BY occurred_at DESC, id DESC`,
          [REST_SCOPE, HISTORY_PROFILE],
        )
        return result.rows
      },
    )
    expect(ordered).toHaveLength(FOLLOW_UP_EVENT_COUNT)

    const lastOfPage = ordered[FOLLOW_UP_PAGE - 1]
    const firstOfNext = ordered[FOLLOW_UP_PAGE]
    // The planted inversion: the page boundary's own row has the *smaller* id.
    expect(Number(lastOfPage.id)).toBeLessThan(Number(firstOfNext.id))
    expect(INVERTED_INDICES).toHaveLength(2)

    // What the client's predicate would do with that boundary: `id < lastId`
    // skips the row whose id is larger, which is the very next row in the order.
    const idOnlySeek = await fixtures.asActor(
      CONTRACT_ACTORS.activeMember.actorId,
      async (client) => {
        const result = await client.query<{ id: string }>(
          `SELECT id::text AS id
             FROM public.follow_up_events
            WHERE instance_id = $1 AND profile_url = $2 AND id < $3::bigint
            ORDER BY occurred_at DESC, id DESC
            LIMIT $4`,
          [REST_SCOPE, HISTORY_PROFILE, lastOfPage.id, FOLLOW_UP_PAGE],
        )
        return result.rows.map((row) => row.id)
      },
    )
    expect(idOnlySeek[0]).not.toBe(firstOfNext.id)

    // And what this operation's ROW comparison does: returns it, in order, with
    // nothing skipped and nothing repeated.
    const { rows } = await walk(params)
    expect(rows.map((row) => String(row.id))).toEqual(
      ordered.map((row) => row.id),
    )
    expect(String(rows[FOLLOW_UP_PAGE].id)).toBe(firstOfNext.id)
  }, 120_000)

  it('is scoped by instance as well as profile', async () => {
    // Same profile URL, a different notebook: the schema's thread key is both
    // halves because the same person can be reached from two accounts.
    const other = await call({
      ...params,
      instance_id: 's13-rest-does-not-exist',
    })
    expect(other.status).toBe(200)
    expect(other.body.items).toEqual([])
    // Absent rows, not an absent relation — no tolerance marker.
    expect(other.body.unavailable).toBeUndefined()
  })

  it('requires both halves of the thread key', async () => {
    const incomplete: Record<string, string>[] = [
      { op: params.op, profile_url: HISTORY_PROFILE },
      { op: params.op, instance_id: REST_SCOPE },
      { op: params.op },
    ]
    for (const missing of incomplete) {
      expect((await call(missing)).status).toBe(400)
    }
  })
})

// ---------------------------------------------------------------------------
// messages.thread and leads.notes
// ---------------------------------------------------------------------------

describe('S13 — the two lead-scoped component reads', () => {
  it('messages.thread returns one conversation oldest-first, both directions', async () => {
    // A P3 conversation, so it has both an inbound and an outbound message.
    const index = 2
    expect(restIntentLevel(index)).toBe('p3')

    const { rows } = await walk({
      op: 'messages.thread',
      instance_id: REST_SCOPE,
      profile_url: restProfileUrl(index),
      limit: '1000',
    })

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.direction)).toEqual(['in', 'out'])
    expect(String(rows[0].sent_at) < String(rows[1].sent_at)).toBe(true)

    // The narrower projection the drawer actually needs — no `instance_id`,
    // `campaign_id` or `profile_url`, because the caller already holds the lead.
    expect(Object.keys(rows[0]).sort()).toEqual([
      'body',
      'classified_model',
      'direction',
      'id',
      'intent_classified_model',
      'intent_level',
      'intent_reason',
      'reason',
      'sent_at',
      'sentiment',
      'source',
    ])
    // The intent columns are present and populated. The Supabase path's middle
    // ladder rung silently drops them, which would show an SDR a conversation with
    // no buying intent because the query asked for none.
    expect(rows[0].intent_level).toBe('p3')
    expect(rows[0].intent_reason).toBe('fixture intent')
    expect(typeof rows[0].id).toBe('number')
  })

  it('messages.thread requires both halves of the thread key', async () => {
    expect(
      (await call({ op: 'messages.thread', profile_url: restProfileUrl(2) }))
        .status,
    ).toBe(400)
    expect(
      (await call({ op: 'messages.thread', instance_id: REST_SCOPE })).status,
    ).toBe(400)
  })

  it('leads.notes returns one lead notes newest-first, NULL created_at first', async () => {
    const { rows } = await walk({
      op: 'leads.notes',
      lead_id: NOTES_LEAD,
      limit: '1000',
    })

    expect(rows).toHaveLength(TOTAL_NOTE_COUNT)
    expect(Object.keys(rows[0]).sort()).toEqual([
      'author',
      'body',
      'created_at',
      'id',
      'lead_id',
    ])

    // A bare `DESC` puts NULLs first in PostgreSQL, and PostgREST emits the same
    // bare `DESC`, so the note with no timestamp leads on both providers. The
    // column is nullable in the baseline, so this state is reachable.
    expect(rows[0].created_at).toBeNull()
    expect(rows[0].body).toBe('S13R note with no timestamp')

    const dated = rows.slice(1)
    for (let index = 1; index < dated.length; index++) {
      expect(String(dated[index - 1].created_at) > String(dated[index].created_at)).toBe(
        true,
      )
    }
    expect(String(rows[0].lead_id)).toBe(NOTES_LEAD)
  })

  it('leads.notes refuses a malformed lead id before the database', async () => {
    // Without this the `::uuid` cast would raise SQLSTATE 22P02, which the driver
    // reports as a transaction error and the endpoint as a 500 — a server fault
    // for a caller's typo.
    for (const bad of ['not-a-uuid', '123', `${NOTES_LEAD}-extra`]) {
      const denied = await call({ op: 'leads.notes', lead_id: bad })
      expect(denied.status).toBe(400)
    }
    expect((await call({ op: 'leads.notes' })).status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// The sourcing library
// ---------------------------------------------------------------------------

describe('S13 — the six library reads', () => {
  it('searches.saved carries arrays and the jsonb filter bag as themselves', async () => {
    const { rows } = await walk({ op: 'searches.saved', limit: '1000' })
    const ours = mineByName(rows)

    expect(ours).toHaveLength(SAVED_SEARCH_COUNT)
    const apollo = ours.find((row) => row.platform === 'apollo')
    expect(apollo).toBeDefined()
    // `text[]` arrives from `pg` already parsed — an array, not the literal
    // `"{cto,founder}"` — which is what PostgREST produced and what `types.ts`
    // declares.
    expect(apollo?.include_keywords).toEqual(['cto', 'founder'])
    expect(apollo?.exclude_keywords).toEqual(['recruiter'])
    // `jsonb` likewise: an object, with its booleans intact.
    expect(apollo?.filters).toEqual({
      headcount: '11-50',
      country: 'DE',
      verified: true,
    })
    expect(typeof apollo?.hypothesis_id).toBe('number')
    expect(apollo?.archived).toBe(false)

    // The empty-array and empty-object defaults survive as themselves rather than
    // becoming null.
    const esun = ours.find((row) => row.platform === 'esun')
    expect(esun?.exclude_keywords).toEqual([])
    expect(esun?.filters).toEqual({})

    // Ordered by `(platform, name, id)`, a total order.
    const keys = ours.map((row) => `${row.platform}|${row.name}`)
    expect([...keys]).toEqual([...keys].sort())
  })

  it('the ICP layer answers with its arrays and its parent ids', async () => {
    const icps = mineByName((await walk({ op: 'icp.profiles', limit: '1000' })).rows)
    expect(icps).toHaveLength(ICP_COUNT)
    const icp = icps[0]
    expect(icp.company_countries).toEqual(['DE', 'PL', 'UA'])
    expect(icp.purchase_triggers).toEqual(['trigger one', 'trigger two'])
    // Migration 044's scope split: exclude is ICP-wide, include is per-industry.
    expect(icp.exclude_keywords).toEqual(['recruiting', 'agency'])
    expect(typeof icp.id).toBe('number')

    // Personas and industries are identified by their parent ICP rather than by
    // the name prefix: `icp_personas` has a `kind`, not a `name`, so a prefix
    // filter would silently match nothing. The parent id is the honest key here
    // and it also proves the child rows carry it as a number.
    const personas = (
      await walk({ op: 'icp.personas', limit: '1000' })
    ).rows.filter((row) => row.icp_id === icp.id)
    expect(personas).toHaveLength(ICP_PERSONA_COUNT)
    // Ordered by `(icp_id, sort, id)`: management (sort 0) before technical (1).
    expect(personas.map((row) => row.sort)).toEqual([0, 1])
    expect(personas[0].job_titles).toEqual(['CEO', 'Founder'])
    expect(personas[1].job_titles).toEqual(['CTO', 'VP Engineering'])

    const industries = (
      await walk({ op: 'icp.industries', limit: '1000' })
    ).rows.filter((row) => row.icp_id === icp.id)
    expect(industries).toHaveLength(ICP_INDUSTRY_COUNT)
    // Ordered by `(icp_id, name, id)`.
    const names = industries.map((row) => String(row.name))
    expect([...names]).toEqual([...names].sort())
    expect(
      industries.find((row) => String(row.name).endsWith('fintech'))
        ?.include_keywords,
    ).toEqual(['payments', 'ledger'])
  }, 120_000)

  it('the hypothesis layer answers, and its campaign links resolve', async () => {
    const hypotheses = mineByName(
      (await walk({ op: 'hypotheses.list', limit: '1000' })).rows,
    )
    expect(hypotheses).toHaveLength(HYPOTHESIS_COUNT)
    expect(typeof hypotheses[0].icp_id).toBe('number')
    expect(hypotheses[0].archived).toBe(false)

    const ids = new Set(hypotheses.map((row) => row.id))
    const links = (
      await walk({ op: 'hypotheses.campaigns', limit: '1000' })
    ).rows.filter((row) => ids.has(row.hypothesis_id))

    expect(links).toHaveLength(HYPOTHESIS_CAMPAIGN_COUNT)
    expect(links.map((row) => row.campaign_id).sort()).toEqual(
      [...REST_CAMPAIGN_IDS].sort(),
    )
    expect(Object.keys(links[0]).sort()).toEqual([
      'campaign_id',
      'created_at',
      'hypothesis_id',
    ])
    // A campaign belongs to at most one hypothesis — unique on `campaign_id`.
    expect(new Set(links.map((row) => row.campaign_id)).size).toBe(links.length)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// Tolerating an absent relation — the driver half, live
// ---------------------------------------------------------------------------

describe('S13 — the adapter classifies an absent relation, and only that', () => {
  /**
   * The endpoint's tolerance rests on `DataStoreSchemaError` meaning exactly one
   * thing. That cannot be proved by dropping a relation — no DDL outside the
   * migration ledger — so it is proved where it actually lives: SQLSTATE 42P01
   * from a real database, through the real driver, against a throwaway registry.
   *
   * The endpoint's other half — turning that class into a 200 with
   * `unavailable: true` — is asserted with no database in
   * `tests/dashboardTolerance.test.ts`. Together they close the loop.
   */
  const MISSING = 'probe.missingRelation'
  const MISSING_COLUMN = 'probe.missingColumn'

  it('raises DataStoreSchemaError for a relation that does not exist', async () => {
    const registry = new NeonOperationRegistry()
    registry.registerQuery(MISSING, {
      build: () => ({
        // A name no baseline defines and no fixture creates.
        text: 'SELECT 1 AS one FROM public.s13_relation_that_does_not_exist',
      }),
    })
    registry.registerQuery(MISSING_COLUMN, {
      build: () => ({
        text: 'SELECT i.s13_column_that_does_not_exist FROM public.instances i',
      }),
    })

    const store = new NeonDataStore({
      connectionString: connection.pooled,
      operations: registry,
      statementTimeoutMs: 10_000,
      maxConnections: 2,
      applicationName: 'lh2-s13-tolerance-probe',
    })

    try {
      const actor = CONTRACT_ACTORS.activeMember
      const missing = await store
        .query(actor, { operation: MISSING, page: { limit: 1, cursor: null } })
        .then(
          () => null,
          (error: unknown) => error,
        )

      expect(missing).toBeInstanceOf(DataStoreSchemaError)
      expect((missing as InstanceType<typeof DataStoreSchemaError>).code).toBe(
        'SCHEMA_OBJECT_MISSING',
      )
      // The message is composed by the adapter rather than quoted from the
      // driver, so it cannot carry driver text into a log or a response.
      expect(String((missing as Error).message)).not.toContain('s13_relation')

      // A missing *column* is deliberately a different failure: the retry ladders
      // are gone by decision, and widening the tolerated SQLSTATE to 42703 would
      // reinstate silent degradation.
      const missingColumn = await store
        .query(actor, {
          operation: MISSING_COLUMN,
          page: { limit: 1, cursor: null },
        })
        .then(
          () => null,
          (error: unknown) => error,
        )

      expect(missingColumn).not.toBeInstanceOf(DataStoreSchemaError)
      expect(missingColumn).toBeInstanceOf(DataStoreTransactionError)
    } finally {
      await store.close()
    }
  }, 120_000)

  it('answers a present-but-empty tolerated relation without the marker', async () => {
    // The distinction the marker exists for. Every library relation exists on this
    // provider, so a read that returns nothing for a filter is "empty", never
    // "unavailable" — and the follow-up reads depend on the browser being able to
    // tell those apart.
    const page = await call({ op: 'searches.saved', limit: '1000' })
    expect(page.status).toBe(200)
    expect(page.body.unavailable).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Authorization and malformed input
// ---------------------------------------------------------------------------

describe('S13 — the auth deny matrix over the new reads', () => {
  /**
   * Five operations, chosen to cover every kind added in this part: an unbounded
   * base-table read, a view-backed read, a tolerated library read, and a read that
   * takes required parameters.
   *
   * The tolerated ones are the point of including them. Tolerance must apply to an
   * absent relation and to nothing else — a denial that came back as
   * `200 {items: [], unavailable: true}` would be an authorization hole wearing a
   * tolerated read's clothes.
   */
  const OPS = [
    'pipeline.eventLog',
    'conversations.replyIntent',
    'conversations.followUpState',
    'searches.saved',
    'conversations.followUpHistory',
  ] as const

  it('fails unauthenticated requests closed, with the real verifier', async () => {
    stubbedSubject = null
    try {
      for (const op of OPS) {
        const denied = await call({ op }, '')
        expect(denied.status).toBe(401)
        expect(denied.body.items).toBeUndefined()
        expect(denied.body.unavailable).toBeUndefined()
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
        expect((await call({ op }, expiredToken)).status).toBe(401)
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
        expect((await call({ op })).status).toBe(403)
      }
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }

    // Corroborated out of band on this part's own relations: the same actor,
    // published the same way, sees none of them, while an active actor sees them
    // all. So the denial is the database's, not the handler's.
    const [inactiveView, activeView] = await Promise.all(
      [CONTRACT_ACTORS.inactive.actorId, CONTRACT_ACTORS.activeMember.actorId].map(
        (actorId) =>
          fixtures.asActor(actorId, async (client) => {
            const result = await client.query<Record<string, string>>(
              `SELECT (SELECT count(*) FROM public.conversation_follow_up_state
                        WHERE instance_id = $1) AS states,
                      (SELECT count(*) FROM public.pipeline_events
                        WHERE actor = $1) AS events,
                      (SELECT count(*) FROM public.conversation_reply_intent
                        WHERE instance_id = $1) AS intents`,
              [REST_SCOPE],
            )
            const row = result.rows[0] ?? {}
            return {
              states: Number(row.states ?? 0),
              events: Number(row.events ?? 0),
              intents: Number(row.intents ?? 0),
            }
          }),
      ),
    )

    expect(inactiveView).toEqual({ states: 0, events: 0, intents: 0 })
    expect(activeView).toEqual({
      states: FOLLOW_UP_STATE_COUNT,
      events: PIPELINE_EVENT_COUNT,
      intents: LABELLED_CONVERSATIONS,
    })
  }, 300_000)

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

  it('authenticates before it validates, so a bad request from nobody is a 401', async () => {
    // Ordering, asserted rather than assumed: `conversations.followUpHistory`
    // requires parameters this request omits, and an unauthenticated caller must
    // learn nothing about that.
    stubbedSubject = null
    try {
      const denied = await call({ op: 'conversations.followUpHistory' }, '')
      expect(denied.status).toBe(401)
    } finally {
      stubbedSubject = SUBJECTS.activeMember
    }
  })

  it('lets an active member and an active admin both read every new operation', async () => {
    const withParams: Record<string, Record<string, string>> = {
      'conversations.followUpHistory': {
        instance_id: REST_SCOPE,
        profile_url: HISTORY_PROFILE,
      },
      'messages.thread': {
        instance_id: REST_SCOPE,
        profile_url: HISTORY_PROFILE,
      },
      'leads.notes': { lead_id: NOTES_LEAD },
    }
    const ALL_NEW = [
      'pipeline.eventLog',
      'conversations.followUpState',
      'conversations.latestMessage',
      'conversations.replyIntent',
      'conversations.followUpHistory',
      'messages.thread',
      'leads.notes',
      'searches.saved',
      'icp.profiles',
      'icp.personas',
      'icp.industries',
      'hypotheses.list',
      'hypotheses.campaigns',
    ] as const
    expect(ALL_NEW).toHaveLength(13)

    for (const subject of [SUBJECTS.activeMember, SUBJECTS.activeAdmin]) {
      stubbedSubject = subject
      for (const op of ALL_NEW) {
        const allowed = await call({
          op,
          limit: '3',
          ...(withParams[op] ?? {}),
        })
        expect(allowed.status, op).toBe(200)
        expect(Array.isArray(allowed.body.items), op).toBe(true)
      }
    }
    stubbedSubject = SUBJECTS.activeMember
  }, 300_000)

  it('rejects malformed input before it reaches the database', async () => {
    // Still not allowlisted, whatever the registry now holds.
    expect((await call({ op: 'conversations.everything' })).status).toBe(400)
    expect((await call({ op: 'identity.admin.setRole' })).status).toBe(400)

    // The new watermark is an instant, and a value without one is refused rather
    // than silently reinterpreted.
    for (const bad of ['2025-11-01', 'last week', '2025-11-01 00:00:00']) {
      expect(
        (await call({ op: 'pipeline.eventLog', occurred_since: bad })).status,
      ).toBe(400)
    }

    // A cursor from another operation's scope, on a new keyset read.
    const first = await call({ op: 'conversations.replyIntent', limit: '10' })
    const borrowed = first.body.nextCursor as string
    expect(borrowed).toBeTruthy()
    expect(
      (await call({
        op: 'conversations.latestMessage',
        limit: '10',
        cursor: borrowed,
      })).status,
    ).toBe(400)

    // A key of the wrong width for a two-column conversation keyset.
    expect(
      (await call({ op: 'conversations.replyIntent', cursor: 'not-a-cursor' }))
        .status,
    ).toBe(400)

    // And the thread key's length cap, refused at the edge.
    expect(
      (await call({
        op: 'messages.thread',
        instance_id: REST_SCOPE,
        profile_url: 'x'.repeat(501),
      })).status,
    ).toBe(400)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// The measurement this part owes
// ---------------------------------------------------------------------------

describe('S13 — keyset against offset on an aggregate view', () => {
  it('records what the seek predicate does to the plan, whatever it shows', async () => {
    /**
     * Part 2 measured keyset against offset on `messages` and found **no
     * difference**, because the sort key had no index and both plans came out as a
     * sequential scan feeding a top-N heapsort. It said so plainly.
     *
     * The claim in `operations/conversations.ts` is different and needs its own
     * evidence: on an *aggregate view*, the seek predicate is on the grouping
     * columns, so PostgreSQL can push it down into the aggregate's input, whereas
     * an `OFFSET` applied outside can only be evaluated after the whole aggregate
     * has been computed. That either shows up in the numbers or the claim is
     * wrong, and this test prints both so the handoff cannot round the result.
     */
    const measure = async (label: string, sql: string, values: unknown[]) => {
      const runs: number[] = []
      let plan = ''
      await fixtures.asActor(
        CONTRACT_ACTORS.activeMember.actorId,
        async (client) => {
          for (let attempt = 0; attempt < 7; attempt++) {
            const explained = await client.query<{ 'QUERY PLAN': unknown[] }>(
              `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
              values,
            )
            const root = (
              explained.rows[0]['QUERY PLAN'] as { 'Execution Time': number }[]
            )[0]
            runs.push(root['Execution Time'])
            if (attempt === 0) plan = JSON.stringify(root)
          }
        },
      )
      runs.sort((a, b) => a - b)
      const p50 = runs[Math.floor(runs.length / 2)]
      return { label, p50, plan }
    }

    const projection = `SELECT i.instance_id, i.profile_url, i.highest_intent
                          FROM public.conversation_reply_intent i`
    const deep = LABELLED_CONVERSATIONS - 100

    const offsetFirst = await measure(
      'OFFSET 0',
      `SELECT * FROM (${projection} ORDER BY i.instance_id, i.profile_url)
         AS datastore_page LIMIT 1001 OFFSET 0`,
      [],
    )
    const offsetDeep = await measure(
      `OFFSET ${deep}`,
      `SELECT * FROM (${projection} ORDER BY i.instance_id, i.profile_url)
         AS datastore_page LIMIT 1001 OFFSET ${deep}`,
      [],
    )
    const keysetDeep = await measure(
      'keyset seek',
      `SELECT * FROM (${projection}
         WHERE (i.instance_id, i.profile_url) > ($1::text, $2::text)
         ORDER BY i.instance_id, i.profile_url) AS datastore_page LIMIT 1001`,
      [REST_SCOPE, restProfileUrl(deep)],
    )

    for (const result of [offsetFirst, offsetDeep, keysetDeep]) {
      console.log(
        `[S13 part 3 keyset] ${result.label}: p50 ${result.p50.toFixed(2)} ms`,
      )
    }
    // Whether the seek reaches an index scan rather than only a filter is the
    // mechanism behind the numbers, so it is printed too rather than asserted —
    // an assertion here would pin a planner decision this session does not own.
    console.log(
      `[S13 part 3 keyset] seek plan contains Index Scan: ${keysetDeep.plan.includes(
        'Index Scan',
      )}`,
    )

    // The only assertion: nothing is pathological. The comparison itself is
    // reported, not asserted, because a threshold would encode today's data volume
    // as a contract.
    expect(keysetDeep.p50).toBeLessThan(10_000)
  }, 300_000)
})
