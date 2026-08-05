/**
 * The dashboard read slice must not be able to name a person.
 *
 * The hazard this file exists for does not throw, does not log and does not fail
 * a parity check. `leads.assigned_to` is a Supabase `team_members.id`; the same
 * integers on Neon denote different people (source 1 is the real admin, target 1
 * is the immutable S06 fixture "Active One" — N-B2 has the map). While `leads`
 * and `team_members` are read from different providers, any join between them —
 * `usePipelineActions.memberName(lead.assigned_to)`, the Pipeline owner chip, the
 * CSV `assigned_to` column — renders a confident wrong name.
 *
 * N-S12 pre-decided that S13 could use the B4 roster for exactly those joins.
 * That premise is retired, and these assertions are what retires it: the roster
 * is not on the dashboard read path, and no operation on that path resolves a
 * member id.
 *
 * **The `assigned_to` assertion was deliberately narrowed in S13's second part.**
 * It used to be "no operation's SQL contains the string `assigned_to`", which was
 * true only because no operation read `leads` yet. `leads.directory` must carry
 * the column — the Pipeline page cannot work without it, and dropping it would be
 * data loss rather than safety. So the invariant is now the one that was always
 * meant: the column may be *selected*, and must never be *joined or resolved*.
 * The distinction is asserted per operation below.
 *
 * No database and no network — the SQL is inspected as text and the allowlist as
 * data.
 */

import { describe, expect, it } from 'vitest'

import { READ_OPERATION_NAMES } from '../api/activity-daily.js'
import type {
  NeonQueryContext,
  NeonQueryOperation,
  NeonStatement,
} from '../api/_lib/data/neon.js'
import type { DataStoreParams } from '../api/_lib/data/contracts.js'
import {
  ACTIVITY_OPERATIONS,
  DASHBOARD_OPERATIONS,
  IDENTITY_OPERATIONS,
  LEADS_OPERATIONS,
  MESSAGES_OPERATIONS,
} from '../api/_lib/data/operations/index.js'
import {
  annotationsTimelineOperation,
  campaignsPerformanceOperation,
  campaignsSequenceStepsOperation,
  instancesOverviewOperation,
  syncRecentRunsOperation,
} from '../api/_lib/data/operations/dashboard.js'
import { leadsDirectoryOperation } from '../api/_lib/data/operations/leads.js'
import {
  inboundHistoryOperation,
  outboundRecentOperation,
} from '../api/_lib/data/operations/messages.js'
import { dailySeriesOperation } from '../api/_lib/data/operations/activity.js'

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
] as unknown as Slice

/** The subset that must not so much as mention a member id. */
const ROSTER_FREE_SLICE = READ_SLICE.filter(
  ([name]) => name !== LEADS_OPERATIONS.directory,
)

describe('the dispatching read endpoint offers exactly the slice', () => {
  it('allowlists nine reads and no more', () => {
    // Spelled out rather than derived from the same constants the endpoint
    // builds its allowlist from: a widening should have to edit this line.
    expect([...READ_OPERATION_NAMES].sort()).toEqual([
      'activity.dailySeries',
      'annotations.timeline',
      'campaigns.performance',
      'campaigns.sequenceSteps',
      'instances.overview',
      'leads.directory',
      'messages.inboundHistory',
      'messages.outboundRecent',
      'sync.recentRuns',
    ])
  })

  it('covers every allowlisted name with an inspected definition', () => {
    // Otherwise a tenth read could be added to the endpoint and skip every
    // assertion in this file by simply not appearing in `READ_SLICE`.
    expect(READ_SLICE.map(([name]) => name).sort()).toEqual(
      [...READ_OPERATION_NAMES].sort(),
    )
  })

  it('does not offer the team roster', () => {
    expect(READ_OPERATION_NAMES).not.toContain(IDENTITY_OPERATIONS.teamRoster)
    // Under any name. The endpoint's surface holds nothing identity-shaped.
    for (const name of READ_OPERATION_NAMES) {
      expect(name).not.toMatch(/roster|member|identity|team/i)
    }
  })

  it('keeps the names the browser already depends on', () => {
    // `#/neon-activity` calls this endpoint with no `op`, which resolves to
    // `activity.dailySeries`; the legacy shape breaks if that name moves.
    expect(READ_OPERATION_NAMES).toContain(ACTIVITY_OPERATIONS.dailySeries)
  })
})

describe('no operation on the read path resolves a member id', () => {
  it.each(READ_SLICE)('%s reads no roster relation', (_name, operation) => {
    const sql = sqlOf(operation).toLowerCase()
    expect(sql).not.toContain('team_members')
    expect(sql).not.toContain('team_roster')
    // `owner_id` on `follow_ups` is the same hazard by another column name.
    expect(sql).not.toContain('owner_id')
  })

  it.each(ROSTER_FREE_SLICE)('%s carries no member id at all', (_name, operation) => {
    expect(sqlOf(operation).toLowerCase()).not.toContain('assigned_to')
  })

  it('leads.directory selects assigned_to and joins nothing to it', () => {
    const sql = sqlOf(inspectable(leadsDirectoryOperation)).toLowerCase()

    // It must carry the column: the Pipeline page's owner state is this value,
    // and omitting it would be data loss dressed up as caution.
    expect(sql).toContain('assigned_to')

    // And it must not resolve it. A single-relation read cannot: there is exactly
    // one `FROM`, no `JOIN` of any kind, and no subquery that could reach a
    // roster. That is what makes the id safe to hand to the browser — the browser
    // already holds a Supabase-shaped roster to interpret it with.
    expect(sql).not.toMatch(/\bjoin\b/)
    expect(sql.match(/\bfrom\b/g) ?? []).toHaveLength(1)
    expect(sql).toContain('from public.leads')
  })
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

  it('keysets the two base-table reads and leaves the aggregates on offset', () => {
    // Which reads seek and which count is a measured decision, not an accident.
    // S12 measured offset at 522 ms vs 525 ms on the aggregate slice, so the
    // small and view-backed reads keep it; the base tables that grow without
    // bound seek instead.
    const keysetNames = READ_SLICE.filter(([, op]) => op.keyset).map(([name]) => name)
    expect(keysetNames.sort()).toEqual([
      'leads.directory',
      'messages.inboundHistory',
      'messages.outboundRecent',
    ])
  })

  it('ends every keyset order in a unique column', () => {
    // The requirement keyset pagination cannot survive without: a repeated key
    // makes a walk loop or stall rather than silently skip, so it is asserted
    // rather than commented. `leads.id` and `messages.id` are the primary keys.
    expect(leadsDirectoryOperation.keyset?.columns).toEqual(['id'])
    expect(inboundHistoryOperation.keyset?.columns).toEqual(['sent_at', 'id'])
    expect(outboundRecentOperation.keyset?.columns).toEqual(['sent_at', 'id'])
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
