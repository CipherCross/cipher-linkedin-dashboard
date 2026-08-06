/**
 * The dashboard read slice must not be able to name the *wrong* person.
 *
 * The hazard this file exists for does not throw, does not log and does not fail
 * a parity check. `leads.assigned_to` is a `team_members.id`; the same integers
 * denote different people on the two providers (source 1 is the real admin,
 * target 1 is the immutable S06 fixture "Active One" — N-B2 has the map). While
 * `leads` and `team_members` are read from *different* providers, any join
 * between them — `usePipelineActions.memberName(lead.assigned_to)`, the Pipeline
 * owner chip, the CSV `assigned_to` column — renders a confident wrong name.
 *
 * **The clause that matters is "different providers", and the roster slice
 * removed it.** Until then, the invariant these assertions carried was "no
 * roster on this endpoint at all", which was the right shape while `leads` came
 * from Supabase and this endpoint answered from Neon. Once `leads.directory`
 * feeds `DataContext`, both ends of the join arrive from one database and the
 * integers agree — while a dashboard with no roster prints "0 Active teammates",
 * which is the same class of defect pointed at a different number.
 *
 * So the ban became a **named permission**, exactly as `assigned_to` and
 * `owner_id` did before it: `identity.teamRoster` may read the roster, through
 * `public.team_roster()` and never through `public.team_members` directly, and
 * no other read may mention either. Widening that is one line in this file and
 * has to be written as a decision.
 *
 * N-S12 pre-decided that S13 could use the B4 roster for those joins *while the
 * leads still came from Supabase*. That premise stays retired: what makes the
 * join legitimate now is not a roster to borrow, it is both sides being read
 * from one place.
 *
 * **The `assigned_to` assertion was deliberately narrowed in S13's second part.**
 * It used to be "no operation's SQL contains the string `assigned_to`", which was
 * true only because no operation read `leads` yet. `leads.directory` must carry
 * the column — the Pipeline page cannot work without it, and dropping it would be
 * data loss rather than safety. So the invariant is now the one that was always
 * meant: the column may be *selected*, and must never be *joined or resolved*.
 * The distinction is asserted per operation below.
 *
 * **And `owner_id` was narrowed the same way in S13's third part, for the same
 * reason.** Part 1 asserted that no operation's SQL mentions `owner_id` at all,
 * which held only while nothing read the follow-up relations.
 * `conversation_follow_up_state.owner_id` and `follow_up_events`'
 * `previous_owner_id` / `new_owner_id` are `team_members.id` values in the source
 * id space — the identical hazard to `assigned_to` under a different column name —
 * and the two reads that carry them cannot drop them: the follow-up queue's owner
 * filter *is* that value. So the blanket ban becomes two per-operation
 * permissions, and every other read still may not mention a member id in any
 * spelling.
 *
 * `follow_up_events` also carries `previous_owner_name` / `new_owner_name`. Those
 * are text snapshots written at the time of the event and are not asserted
 * against: they need no roster to read, which is exactly why they are safe.
 *
 * No database and no network — the SQL is inspected as text and the allowlist as
 * data.
 */

import { describe, expect, it } from 'vitest'

import {
  READ_OPERATION_NAMES,
  TOLERANT_OPERATION_NAMES,
} from '../api/activity-daily.js'
import type {
  NeonQueryContext,
  NeonQueryOperation,
  NeonStatement,
} from '../api/_lib/data/neon.js'
import type { DataStoreParams } from '../api/_lib/data/contracts.js'
import {
  ACTIVITY_OPERATIONS,
  CONVERSATION_OPERATIONS,
  DASHBOARD_OPERATIONS,
  IDENTITY_OPERATIONS,
  LEADS_OPERATIONS,
  LIBRARY_OPERATIONS,
  MESSAGES_OPERATIONS,
  PIPELINE_OPERATIONS,
} from '../api/_lib/data/operations/index.js'
import {
  annotationsTimelineOperation,
  campaignsPerformanceOperation,
  campaignsSequenceStepsOperation,
  instancesOverviewOperation,
  syncRecentRunsOperation,
} from '../api/_lib/data/operations/dashboard.js'
import {
  leadNotesOperation,
  leadsDirectoryOperation,
} from '../api/_lib/data/operations/leads.js'
import {
  inboundHistoryOperation,
  outboundRecentOperation,
  threadOperation,
} from '../api/_lib/data/operations/messages.js'
import { dailySeriesOperation } from '../api/_lib/data/operations/activity.js'
import {
  conversationLatestMessageOperation,
  conversationReplyIntentOperation,
  followUpHistoryOperation,
  followUpStateOperation,
} from '../api/_lib/data/operations/conversations.js'
import {
  hypothesesOperation,
  hypothesisCampaignsOperation,
  icpIndustriesOperation,
  icpPersonasOperation,
  icpProfilesOperation,
  savedSearchesOperation,
} from '../api/_lib/data/operations/library.js'
import { pipelineEventLogOperation } from '../api/_lib/data/operations/pipeline.js'
import { teamRosterOperation } from '../api/_lib/data/operations/identity.js'

/**
 * Every operation asserted below either ignores its context or reads it through
 * optional chaining, so an empty context yields the first page of the unfiltered
 * query — which is the form worth inspecting as text. The cast records that rather
 * than inventing an actor the builders would not read.
 */
const NO_CONTEXT = {} as unknown as NeonQueryContext<DataStoreParams>

/**
 * Erase an operation's parameter type so it can be inspected as text.
 *
 * `NeonQueryOperation` is contravariant in its params through `build`, so an
 * operation declaring `LeadsDirectoryParams` is not assignable to one declaring
 * the open `DataStoreParams` — correctly, since a real caller must supply the
 * narrower type. This file is not a caller: it reads SQL. One cast, named, rather
 * than a cast at each use.
 */
type Inspectable = NeonQueryOperation<unknown, DataStoreParams>

const inspectable = (operation: {
  build: (context: never) => NeonStatement
  keyset?: { readonly columns: readonly string[] }
}): Inspectable => operation as unknown as Inspectable

const sqlOf = (operation: Inspectable): string => {
  const statement: NeonStatement = operation.build(NO_CONTEXT)
  return statement.text
}

type Slice = ReadonlyArray<
  readonly [string, NeonQueryOperation<unknown, DataStoreParams>]
>

/** Every read the dispatching endpoint offers, paired with its definition. */
const READ_SLICE = [
  [ACTIVITY_OPERATIONS.dailySeries, dailySeriesOperation],
  [DASHBOARD_OPERATIONS.instancesOverview, instancesOverviewOperation],
  [DASHBOARD_OPERATIONS.campaignsPerformance, campaignsPerformanceOperation],
  [DASHBOARD_OPERATIONS.campaignsSequenceSteps, campaignsSequenceStepsOperation],
  [DASHBOARD_OPERATIONS.syncRecentRuns, syncRecentRunsOperation],
  [DASHBOARD_OPERATIONS.annotationsTimeline, annotationsTimelineOperation],
  [LEADS_OPERATIONS.directory, leadsDirectoryOperation],
  [MESSAGES_OPERATIONS.inboundHistory, inboundHistoryOperation],
  [MESSAGES_OPERATIONS.outboundRecent, outboundRecentOperation],
  [PIPELINE_OPERATIONS.eventLog, pipelineEventLogOperation],
  [CONVERSATION_OPERATIONS.followUpState, followUpStateOperation],
  [CONVERSATION_OPERATIONS.latestMessage, conversationLatestMessageOperation],
  [CONVERSATION_OPERATIONS.replyIntent, conversationReplyIntentOperation],
  [CONVERSATION_OPERATIONS.followUpHistory, followUpHistoryOperation],
  [MESSAGES_OPERATIONS.thread, threadOperation],
  [LEADS_OPERATIONS.notes, leadNotesOperation],
  [LIBRARY_OPERATIONS.savedSearches, savedSearchesOperation],
  [LIBRARY_OPERATIONS.icpProfiles, icpProfilesOperation],
  [LIBRARY_OPERATIONS.icpPersonas, icpPersonasOperation],
  [LIBRARY_OPERATIONS.icpIndustries, icpIndustriesOperation],
  [LIBRARY_OPERATIONS.hypotheses, hypothesesOperation],
  [LIBRARY_OPERATIONS.hypothesisCampaigns, hypothesisCampaignsOperation],
  [IDENTITY_OPERATIONS.teamRoster, teamRosterOperation],
] as unknown as Slice

/**
 * The reads permitted to carry a member id, and the only ones. Each is named
 * individually rather than filtered by a pattern, so adding a fourth has to
 * appear here as a decision.
 */
const MEMBER_ID_BEARING = [
  LEADS_OPERATIONS.directory,
  CONVERSATION_OPERATIONS.followUpState,
  CONVERSATION_OPERATIONS.followUpHistory,
] as readonly string[]

/** The subset that must not so much as mention a member id, in any spelling. */
const ROSTER_FREE_SLICE = READ_SLICE.filter(
  ([name]) => !MEMBER_ID_BEARING.includes(name),
)

/**
 * The one read permitted to touch the roster. Named rather than pattern-matched,
 * for the same reason `MEMBER_ID_BEARING` is: a second one has to be written
 * here as a decision.
 */
const ROSTER_READING = [IDENTITY_OPERATIONS.teamRoster] as readonly string[]

describe('the dispatching read endpoint offers exactly the slice', () => {
  it('allowlists twenty-three reads and no more', () => {
    // Spelled out rather than derived from the same constants the endpoint
    // builds its allowlist from: a widening should have to edit this line.
    //
    // It said *nine* until S13's third part, which added the four medium
    // relations, the six tolerated library reads and the three reads that used to
    // live inside a component, and *twenty-two* until the roster slice added
    // `identity.teamRoster`. Deliberately edited each time, and this is the
    // record of it: the number in a test name is the cheapest possible tripwire
    // on the surface area of the whole read path.
    expect([...READ_OPERATION_NAMES].sort()).toEqual([
      'activity.dailySeries',
      'annotations.timeline',
      'campaigns.performance',
      'campaigns.sequenceSteps',
      'conversations.followUpHistory',
      'conversations.followUpState',
      'conversations.latestMessage',
      'conversations.replyIntent',
      'hypotheses.campaigns',
      'hypotheses.list',
      'icp.industries',
      'icp.personas',
      'icp.profiles',
      'identity.teamRoster',
      'instances.overview',
      'leads.directory',
      'leads.notes',
      'messages.inboundHistory',
      'messages.outboundRecent',
      'messages.thread',
      'pipeline.eventLog',
      'searches.saved',
      'sync.recentRuns',
    ])
  })

  it('covers every allowlisted name with an inspected definition', () => {
    // Otherwise a twenty-third read could be added to the endpoint and skip every
    // assertion in this file by simply not appearing in `READ_SLICE`.
    expect(READ_SLICE.map(([name]) => name).sort()).toEqual(
      [...READ_OPERATION_NAMES].sort(),
    )
  })

  it('tolerates a missing relation on exactly the ten reads that may', () => {
    // The set, not the mechanism. Marking a funnel read tolerant is one word and
    // would turn a broken deployment into a quietly smaller funnel — so the
    // permission is enumerated, and every read that computes a number is absent
    // from it.
    expect([...TOLERANT_OPERATION_NAMES].sort()).toEqual([
      'conversations.followUpState',
      'conversations.latestMessage',
      'conversations.replyIntent',
      'hypotheses.campaigns',
      'hypotheses.list',
      'icp.industries',
      'icp.personas',
      'icp.profiles',
      'pipeline.eventLog',
      'searches.saved',
    ])

    for (const funnelRead of [
      ACTIVITY_OPERATIONS.dailySeries,
      DASHBOARD_OPERATIONS.campaignsPerformance,
      DASHBOARD_OPERATIONS.instancesOverview,
      LEADS_OPERATIONS.directory,
      MESSAGES_OPERATIONS.inboundHistory,
      MESSAGES_OPERATIONS.outboundRecent,
    ]) {
      expect(TOLERANT_OPERATION_NAMES).not.toContain(funnelRead)
    }

    // And the on-demand component reads are not tolerant either: each is behind a
    // panel with its own error state, so an empty answer would hide a message the
    // user would otherwise see.
    for (const onDemand of [
      CONVERSATION_OPERATIONS.followUpHistory,
      MESSAGES_OPERATIONS.thread,
      LEADS_OPERATIONS.notes,
    ]) {
      expect(TOLERANT_OPERATION_NAMES).not.toContain(onDemand)
    }

    // Nor the roster, and this one is the newest and the easiest to get wrong.
    // `team_members` is in the baseline's first artifact — it cannot be "not yet
    // migrated" on a database that answered anything else here — so tolerating
    // its absence would convert a broken deployment straight back into
    // "0 Active teammates", the defect the roster slice exists to end.
    expect(TOLERANT_OPERATION_NAMES).not.toContain(IDENTITY_OPERATIONS.teamRoster)
  })

  it('offers the roster under exactly one name', () => {
    // Narrowed from "offers no roster at all", which held only while `leads` was
    // read from the other provider — see this file's header. What replaces it is
    // a named permission: the roster is here, it is `identity.teamRoster`, and
    // nothing else on this endpoint is identity-shaped.
    expect(READ_OPERATION_NAMES).toContain(IDENTITY_OPERATIONS.teamRoster)
    for (const name of READ_OPERATION_NAMES) {
      if (ROSTER_READING.includes(name)) continue
      expect(name).not.toMatch(/roster|member|identity|team/i)
    }
    expect(ROSTER_READING).toHaveLength(1)

    // And the endpoint still offers none of the identity *writes*, which live on
    // `/api/identity` and are the reason this allowlist is a list rather than a
    // pass-through to the registry.
    for (const command of ['identity.admin.invite', 'identity.admin.setActive', 'identity.admin.setRole']) {
      expect(READ_OPERATION_NAMES).not.toContain(command)
    }
  })

  it('keeps the names the browser already depends on', () => {
    // `#/neon-activity` calls this endpoint with no `op`, which resolves to
    // `activity.dailySeries`; the legacy shape breaks if that name moves.
    expect(READ_OPERATION_NAMES).toContain(ACTIVITY_OPERATIONS.dailySeries)
  })
})

describe('no operation on the read path resolves a member id', () => {
  const NON_ROSTER_SLICE = READ_SLICE.filter(
    ([name]) => !ROSTER_READING.includes(name),
  )

  it.each(NON_ROSTER_SLICE)('%s reads no roster relation', (_name, operation) => {
    const sql = sqlOf(operation).toLowerCase()
    expect(sql).not.toContain('team_members')
    expect(sql).not.toContain('team_roster')
  })

  it('reads the roster through the function and never through the table', () => {
    // The permission is `public.team_roster()` specifically, and the difference
    // is not stylistic. `team_members_active_actor_select` restricts
    // `app_runtime` to the caller's **own row**, so `SELECT … FROM
    // public.team_members` under an ordinary actor returns exactly one member —
    // and the Team page would state "1 Active teammate", which is a wrong number
    // wearing the shape of a right one. Making the table readable would need an
    // RLS widening in a new ledger step; the `SECURITY DEFINER` function is
    // already granted and already membership-gated.
    const sql = sqlOf(inspectable(teamRosterOperation)).toLowerCase()
    expect(sql).toContain('public.team_roster()')
    expect(sql).not.toMatch(/from\s+public\.team_members/)
    // No join to anything, on the read that is allowed to name people: the
    // function's own seven columns are the whole projection.
    expect(sql).not.toMatch(/\bjoin\b/)
    expect(sql.match(/\bfrom\b/g) ?? []).toHaveLength(1)
  })

  it('orders the roster on a unique column so an offset walk cannot skip', () => {
    // It has no keyset, so the driver pages it with LIMIT/OFFSET — which is only
    // correct over a **total** order. `name` alone is not unique; `id` is the
    // primary key, and it is the tiebreak.
    const sql = sqlOf(inspectable(teamRosterOperation)).toLowerCase()
    expect(sql).toMatch(/order by\s+r\.name,\s*r\.id/)
  })

  it.each(ROSTER_FREE_SLICE)('%s carries no member id at all', (_name, operation) => {
    const sql = sqlOf(operation).toLowerCase()
    expect(sql).not.toContain('assigned_to')
    // The same hazard under its other column name. `owner_id` matches
    // `previous_owner_id` and `new_owner_id` as substrings, which is the point.
    expect(sql).not.toContain('owner_id')
  })

  /**
   * The three reads that may carry a member id, each asserted the same way:
   * the column is present, and the SQL structurally cannot resolve it — one
   * `FROM`, no `JOIN`, no subquery that could reach a roster. That is what makes
   * the raw id safe to hand to the browser, which already holds a
   * Supabase-shaped roster to interpret it with.
   */
  const idBearing = [
    ['leads.directory', leadsDirectoryOperation, 'assigned_to', 'from public.leads'],
    [
      'conversations.followUpState',
      followUpStateOperation,
      'owner_id',
      'from public.conversation_follow_up_state',
    ],
    [
      'conversations.followUpHistory',
      followUpHistoryOperation,
      'owner_id',
      'from public.follow_up_events',
    ],
  ] as const

  it.each(idBearing)(
    '%s selects its member id and joins nothing to it',
    (_name, operation, column, from) => {
      const sql = sqlOf(inspectable(operation)).toLowerCase()

      // It must carry the column. The Pipeline page's owner state and the
      // follow-up queue's owner filter *are* these values; dropping them would be
      // data loss dressed up as caution.
      expect(sql).toContain(column)

      expect(sql).not.toMatch(/\bjoin\b/)
      expect(sql.match(/\bfrom\b/g) ?? []).toHaveLength(1)
      expect(sql).toContain(from)
    },
  )
})

describe('every read is a paged, ordered, read-only projection', () => {
  it.each(READ_SLICE)('%s is read-only SQL', (_name, operation) => {
    // The store runs these in `BEGIN READ ONLY`, so this is belt and braces —
    // and it is cheap enough to keep the second belt.
    expect(sqlOf(operation).trimStart().toLowerCase()).toMatch(/^(select|with)\b/)
  })

  it.each(READ_SLICE)('%s orders its rows', (_name, operation) => {
    // The driver wraps every query in `LIMIT`. An unordered relation paged that
    // way can repeat or skip a row at a page boundary.
    expect(sqlOf(operation).toLowerCase()).toContain('order by')
  })

  it.each(READ_SLICE)('%s selects every keyset column it declares', (_name, operation) => {
    // A declared key column the projection does not contain makes the driver
    // raise rather than hand back a broken cursor, but it would raise at request
    // time on the live path. Caught here instead, with no database.
    const keyset = operation.keyset
    if (!keyset) return
    const sql = sqlOf(operation).toLowerCase()
    for (const column of keyset.columns) {
      expect(sql).toContain(column.toLowerCase())
    }
  })

  it('keysets the unbounded reads and leaves the bounded ones on offset', () => {
    // Which reads seek and which count is a measured decision, not an accident.
    // S12 measured offset at 522 ms vs 525 ms on the aggregate slice, so the small
    // and view-backed reads keep it; the reads that grow without bound seek.
    //
    // The line between the two is "does the row count grow with the team's work":
    // leads, messages, the pipeline audit log and one row per conversation all do.
    // A thread, one lead's notes, and a hand-maintained ICP library do not — and
    // `leads.notes` additionally *may not* seek, because `lead_notes.created_at` is
    // nullable and a ROW comparison against NULL drops rows silently.
    const keysetNames = READ_SLICE.filter(([, op]) => op.keyset).map(([name]) => name)
    expect(keysetNames.sort()).toEqual([
      'conversations.followUpHistory',
      'conversations.followUpState',
      'conversations.latestMessage',
      'conversations.replyIntent',
      'leads.directory',
      'messages.inboundHistory',
      'messages.outboundRecent',
      'pipeline.eventLog',
    ])
  })

  it('ends every keyset order in a unique column', () => {
    // The requirement keyset pagination cannot survive without: a repeated key
    // makes a walk loop or stall rather than silently skip, so it is asserted
    // rather than commented.
    //
    // `leads.id`, `messages.id`, `pipeline_events.id` and `follow_up_events.id`
    // are primary keys. `(instance_id, profile_url)` is the primary key of
    // `conversation_follow_up_state` and the grouping key of the two conversation
    // views, so it is unique in each of their outputs — which no constraint
    // declares, so the live suite proves it over a full walk as well.
    expect(leadsDirectoryOperation.keyset?.columns).toEqual(['id'])
    expect(inboundHistoryOperation.keyset?.columns).toEqual(['sent_at', 'id'])
    expect(outboundRecentOperation.keyset?.columns).toEqual(['sent_at', 'id'])
    expect(pipelineEventLogOperation.keyset?.columns).toEqual(['occurred_at', 'id'])
    expect(followUpHistoryOperation.keyset?.columns).toEqual(['occurred_at', 'id'])
    for (const operation of [
      followUpStateOperation,
      conversationLatestMessageOperation,
      conversationReplyIntentOperation,
    ]) {
      expect(operation.keyset?.columns).toEqual(['instance_id', 'profile_url'])
    }
  })

  it('seeks in the direction each keyset read actually orders', () => {
    // A seek predicate pointing the opposite way to the `ORDER BY` returns the
    // page it just returned, forever — a walk that never terminates rather than one
    // that skips. The driver deliberately does not generate either half
    // (`NeonKeysetPagination`), so the two agreeing is the operation's own
    // responsibility and worth pinning as text.
    const ascending = [
      [PIPELINE_OPERATIONS.eventLog, pipelineEventLogOperation],
      [CONVERSATION_OPERATIONS.followUpState, followUpStateOperation],
      [CONVERSATION_OPERATIONS.latestMessage, conversationLatestMessageOperation],
      [CONVERSATION_OPERATIONS.replyIntent, conversationReplyIntentOperation],
      [LEADS_OPERATIONS.directory, leadsDirectoryOperation],
    ] as const
    for (const [name, operation] of ascending) {
      const sql = sqlOf(inspectable(operation))
      expect(sql, name).toMatch(/>\s*\(?\$/)
      expect(sql, name).not.toMatch(/order by[^;]*\bdesc\b/i)
    }

    const descending = [
      [MESSAGES_OPERATIONS.inboundHistory, inboundHistoryOperation],
      [MESSAGES_OPERATIONS.outboundRecent, outboundRecentOperation],
      [CONVERSATION_OPERATIONS.followUpHistory, followUpHistoryOperation],
    ] as const
    for (const [name, operation] of descending) {
      const sql = sqlOf(inspectable(operation))
      expect(sql, name).toMatch(/<\s*\(\$/)
      expect(sql, name).toMatch(/order by[^;]*\bdesc\b/i)
    }
  })

  it('scopes every conversation-scoped read by instance as well as profile', () => {
    // `CLAUDE.md`'s rule, and the schema's: the same person can be reached from two
    // LinkedIn accounts, so a `profile_url` on its own names two conversations.
    // A read filtered on the profile alone would merge two people's threads.
    for (const operation of [threadOperation, followUpHistoryOperation]) {
      const sql = sqlOf(inspectable(operation)).toLowerCase()
      expect(sql).toContain('instance_id = $1')
      expect(sql).toContain('profile_url = $2')
    }
  })
})

describe('the inbound history cannot be windowed', () => {
  it('ignores a range even when one is supplied', () => {
    // The invariant from CLAUDE.md: inbound is fetched in full because sentiment
    // and durable P3 counts sit beside all-time lead totals. A window here
    // undercounts them on a busy account and fails nothing, so the operation
    // refuses to see one.
    const withRange = inspectable(inboundHistoryOperation).build({
      params: undefined,
      range: {
        fromInclusive: '2026-01-01T00:00:00.000Z',
        toExclusive: '2026-02-01T00:00:00.000Z',
      },
      after: undefined,
    } as unknown as NeonQueryContext<DataStoreParams>)

    // The two `sent_at` window placeholders stay null; only outbound fills them.
    expect(withRange.values).toEqual([null, null, null, null, null])

    const outbound = inspectable(outboundRecentOperation).build({
      params: undefined,
      range: {
        fromInclusive: '2026-01-01T00:00:00.000Z',
        toExclusive: '2026-02-01T00:00:00.000Z',
      },
      after: undefined,
    } as unknown as NeonQueryContext<DataStoreParams>)

    expect(outbound.values).toEqual([
      null,
      null,
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    ])
  })

  it('reads only its own direction', () => {
    expect(sqlOf(inspectable(inboundHistoryOperation))).toContain("m.direction = 'in'")
    expect(sqlOf(inspectable(outboundRecentOperation))).toContain("m.direction = 'out'")
  })
})
