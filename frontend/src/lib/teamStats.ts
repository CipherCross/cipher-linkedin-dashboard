// Team stats on the CSV import page: who added how many companies and leads to
// an Airtable base, and how many of them are approved. The server
// (`import_stats` on /api/import, api/_lib/importStats.ts) answers compact
// daily buckets; everything here — columns, totals, weeks and the All bases sum
// — is computed in the browser from those buckets.
//
// Days are UTC, like every interval slice in the dashboard, and a record's day
// is its creation time in Airtable. A status is the record's current value, so
// "approved" means approved now, not approved inside the period.
//
// The server imports this file at runtime, so it imports nothing but types: a
// relative import without `.js` would not resolve in the deployed function.
import type { AirtableBaseId } from './airtableBases'

export type TeamStatsTable = 'db' | 'companies' | 'contacts'
export type StatusGroup = 'new' | 'approve' | 'reject'
export type CellMetric = 'all' | StatusGroup

/** The longest period one request may cover, inclusive. */
export const MAX_TEAM_STATS_DAYS = 92
/** Up to this many days the tables show one column per day; longer, per week. */
export const DAILY_COLUMNS_MAX_DAYS = 31

export interface TeamStatsBucket {
  table: TeamStatsTable
  /** UTC `YYYY-MM-DD` the record was created. */
  day: string
  /** The record's `Added by`; `''` when it has none. */
  addedBy: string
  group: StatusGroup
  count: number
}

export interface TeamStatsTableInfo {
  /** `Added by` choices from the table's schema, in schema order. */
  people: string[]
  /** The table's status choices and the group each counts as (`excluded` = Old). */
  statuses: Array<{ name: string; group: StatusGroup | 'excluded' }>
}

export type TeamStatsResponse =
  | { base: AirtableBaseId; configured: false; from: string; to: string }
  | {
    base: AirtableBaseId
    configured: true
    from: string
    to: string
    fetchedAt: string
    tables: Record<TeamStatsTable, TeamStatsTableInfo>
    buckets: TeamStatsBucket[]
  }

export type ConfiguredTeamStats = Extract<TeamStatsResponse, { configured: true }>

export interface TeamStatsBlock {
  id: 'companyAdditions' | 'companyApprovals' | 'leadAdditions' | 'leadApprovals'
  table: TeamStatsTable
  title: string
  description: string
  /** What a day cell shows until the viewer picks another. */
  defaultMetric: CellMetric
}

export const TEAM_STATS_BLOCKS: TeamStatsBlock[] = [
  {
    id: 'companyAdditions',
    table: 'db',
    title: 'Company additions',
    description: 'Companies added to DB, by Initial status.',
    defaultMetric: 'all',
  },
  {
    id: 'companyApprovals',
    table: 'companies',
    title: 'Company approvals',
    description: 'Records created in Companies — an approved DB row lands there, so the day is about when it was approved. By Approve status.',
    defaultMetric: 'all',
  },
  {
    id: 'leadAdditions',
    table: 'contacts',
    title: 'Lead additions',
    description: 'Leads added to Contacts, by Approve status.',
    defaultMetric: 'all',
  },
  {
    id: 'leadApprovals',
    table: 'contacts',
    title: 'Lead approvals',
    description: 'The same Contacts records: how many are approved or rejected now. There is no separate approval date.',
    defaultMetric: 'approve',
  },
]

export const METRIC_LABEL: Record<CellMetric, string> = {
  all: 'All',
  new: 'New',
  approve: 'Approve',
  reject: 'Reject',
}

export const NOT_SET_LABEL = 'Not set'

// ------------------------------------------------------------------ columns

const DAY_MS = 86_400_000
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const msOf = (day: string) => Date.parse(`${day}T00:00:00Z`)

/** A real calendar day in `YYYY-MM-DD` form (not `2026-02-30`, not `2026-13-01`). */
export const isDay = (value: unknown): value is string =>
  typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(msOf(value))
  && dayOf(msOf(value)) === value

/** Days from `from` to `to`, both included. */
export function rangeDayCount(from: string, to: string): number {
  return Math.round((msOf(to) - msOf(from)) / DAY_MS) + 1
}

export function shiftDay(day: string, days: number): string {
  return dayOf(msOf(day) + days * DAY_MS)
}

export interface StatsColumn {
  key: string
  /** First and last day the column covers, inside the period. */
  from: string
  to: string
  kind: 'day' | 'week'
}

/** One column per day up to 31 days, else one per Monday-based week clipped to the period. */
export function teamStatsColumns(from: string, to: string): StatsColumn[] {
  if (rangeDayCount(from, to) <= DAILY_COLUMNS_MAX_DAYS) {
    return Array.from({ length: rangeDayCount(from, to) }, (_, index) => {
      const day = shiftDay(from, index)
      return { key: day, from: day, to: day, kind: 'day' as const }
    })
  }
  const columns: StatsColumn[] = []
  // The Monday of `from`'s week, as `weekStart` in leads.ts computes it.
  const first = shiftDay(from, -((new Date(msOf(from)).getUTCDay() + 6) % 7))
  for (let monday = first; monday <= to; monday = shiftDay(monday, 7)) {
    const sunday = shiftDay(monday, 6)
    columns.push({
      key: monday,
      from: monday < from ? from : monday,
      to: sunday > to ? to : sunday,
      kind: 'week',
    })
  }
  return columns
}

// -------------------------------------------------------------- aggregation

export interface Counts {
  all: number
  new: number
  approve: number
  reject: number
}

export const zeroCounts = (): Counts => ({ all: 0, new: 0, approve: 0, reject: 0 })

function addTo(counts: Counts, group: StatusGroup, count: number) {
  counts[group] += count
  counts.all += count
}

export interface PersonRow {
  /** The `Added by` value; `''` is Not set. */
  person: string
  label: string
  perColumn: Counts[]
  totals: Counts
}

export interface BlockTable {
  rows: PersonRow[]
  columnTotals: Counts[]
  totals: Counts
}

/**
 * Person × column counts for one table, summed over every base in `stats`.
 * Rows are every `Added by` choice of that table in any base (a person with
 * nothing in the period stays as a row of zeros), any other value found on a
 * record, and Not set last. Rows sort by All, busiest first.
 */
export function blockTable(
  stats: ConfiguredTeamStats[],
  table: TeamStatsTable,
  columns: StatsColumn[],
): BlockTable {
  const columnOf = new Map<string, number>()
  columns.forEach((column, index) => {
    for (let day = column.from; day <= column.to; day = shiftDay(day, 1)) columnOf.set(day, index)
  })

  const rows = new Map<string, PersonRow>()
  const rowFor = (person: string) => {
    let row = rows.get(person)
    if (!row) {
      row = {
        person,
        label: person || NOT_SET_LABEL,
        perColumn: columns.map(zeroCounts),
        totals: zeroCounts(),
      }
      rows.set(person, row)
    }
    return row
  }

  for (const base of stats) for (const person of base.tables[table].people) rowFor(person)
  rowFor('')
  for (const base of stats) {
    for (const bucket of base.buckets) {
      if (bucket.table !== table) continue
      const index = columnOf.get(bucket.day)
      if (index === undefined) continue
      const row = rowFor(bucket.addedBy)
      addTo(row.perColumn[index], bucket.group, bucket.count)
      addTo(row.totals, bucket.group, bucket.count)
    }
  }

  const sorted = [...rows.values()].sort((a, b) => {
    if (!a.person !== !b.person) return a.person ? -1 : 1
    return b.totals.all - a.totals.all || a.label.localeCompare(b.label)
  })
  const columnTotals = columns.map((_, index) => {
    const sum = zeroCounts()
    for (const row of sorted) {
      for (const key of ['all', 'new', 'approve', 'reject'] as const) sum[key] += row.perColumn[index][key]
    }
    return sum
  })
  const totals = zeroCounts()
  for (const row of sorted) {
    for (const key of ['all', 'new', 'approve', 'reject'] as const) totals[key] += row.totals[key]
  }
  return { rows: sorted, columnTotals, totals }
}
