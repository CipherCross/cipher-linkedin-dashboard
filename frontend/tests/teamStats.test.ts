import { describe, expect, it } from 'vitest'
import { presetRanges, teamStatsRanges } from '../src/lib/leads'
import {
  blockTable, isDay, rangeDayCount, teamStatsColumns,
  type ConfiguredTeamStats, type TeamStatsBucket,
} from '../src/lib/teamStats'

const ranges = (now: string) =>
  Object.fromEntries(teamStatsRanges(new Date(now)).map((range) => [range.id, [range.from, range.to]]))

describe('teamStatsRanges', () => {
  it('offers the Team stats periods in order, with the shared label style', () => {
    expect(teamStatsRanges(new Date('2026-11-04T10:00:00Z')).map((range) => range.label)).toEqual([
      'Today', 'Yesterday', 'This week', 'Last week', 'Past 14 days', 'This month', 'Last month', 'Past 30 days',
    ])
  })

  it('starts weeks on Monday and months on the 1st, in UTC', () => {
    // Wednesday 4 Nov 2026.
    expect(ranges('2026-11-04T10:00:00Z')).toEqual({
      today: ['2026-11-04', '2026-11-04'],
      yesterday: ['2026-11-03', '2026-11-03'],
      this_week: ['2026-11-02', '2026-11-04'],
      last_week: ['2026-10-26', '2026-11-01'],
      '14_days': ['2026-10-22', '2026-11-04'],
      this_month: ['2026-11-01', '2026-11-04'],
      last_month: ['2026-10-01', '2026-10-31'],
      '30_days': ['2026-10-06', '2026-11-04'],
    })
  })

  it('makes a Monday its own week start and a Sunday the end of its week', () => {
    expect(ranges('2026-11-02T00:00:00Z').this_week).toEqual(['2026-11-02', '2026-11-02'])
    expect(ranges('2026-11-02T00:00:00Z').last_week).toEqual(['2026-10-26', '2026-11-01'])
    expect(ranges('2026-11-08T23:59:59Z').this_week).toEqual(['2026-11-02', '2026-11-08'])
  })

  it('rolls over months and years, and handles a leap February', () => {
    const newYear = ranges('2027-01-01T08:00:00Z')
    expect(newYear.yesterday).toEqual(['2026-12-31', '2026-12-31'])
    expect(newYear.this_month).toEqual(['2027-01-01', '2027-01-01'])
    expect(newYear.last_month).toEqual(['2026-12-01', '2026-12-31'])
    expect(newYear.this_week).toEqual(['2026-12-28', '2027-01-01'])
    expect(ranges('2028-03-15T12:00:00Z').last_month).toEqual(['2028-02-01', '2028-02-29'])
  })

  it('reads the UTC day, not the local one, near midnight', () => {
    // 23:30 UTC on the 31st is already the 1st east of UTC; the period stays in October.
    expect(ranges('2026-10-31T23:30:00Z').this_month).toEqual(['2026-10-01', '2026-10-31'])
    expect(ranges('2026-11-01T00:30:00Z').this_month).toEqual(['2026-11-01', '2026-11-01'])
  })

  it('leaves presetRanges as it was', () => {
    expect(presetRanges(new Date('2026-11-04T10:00:00Z')).map((range) => range.id)).toEqual([
      '7_days', '14_days', '30_days', '2_months', '3_months', '6_months', '12_months', 'all',
    ])
  })
})

describe('teamStatsColumns', () => {
  it('is one column per day up to 31 days', () => {
    const columns = teamStatsColumns('2026-10-01', '2026-10-31')
    expect(columns).toHaveLength(31)
    expect(columns[0]).toEqual({ key: '2026-10-01', from: '2026-10-01', to: '2026-10-01', kind: 'day' })
    expect(columns[30].key).toBe('2026-10-31')
  })

  it('is one Monday week per column beyond 31 days, clipped to the period', () => {
    const columns = teamStatsColumns('2026-10-01', '2026-11-04')
    expect(rangeDayCount('2026-10-01', '2026-11-04')).toBe(35)
    expect(columns.map((column) => [column.key, column.from, column.to])).toEqual([
      ['2026-09-28', '2026-10-01', '2026-10-04'],
      ['2026-10-05', '2026-10-05', '2026-10-11'],
      ['2026-10-12', '2026-10-12', '2026-10-18'],
      ['2026-10-19', '2026-10-19', '2026-10-25'],
      ['2026-10-26', '2026-10-26', '2026-11-01'],
      ['2026-11-02', '2026-11-02', '2026-11-04'],
    ])
    expect(columns.every((column) => column.kind === 'week')).toBe(true)
  })

  it('accepts only real calendar days', () => {
    expect(['2026-10-01', '2028-02-29'].every(isDay)).toBe(true)
    expect(['2026-02-29', '2026-13-01', '2026-10-1', '', null].some(isDay)).toBe(false)
  })
})

const stats = (base: 'web2mob' | 'fintech_arabic', buckets: TeamStatsBucket[], people = ['Daria Krut', 'David Gamanuk']): ConfiguredTeamStats => ({
  base,
  configured: true,
  from: '2026-10-01',
  to: '2026-10-07',
  fetchedAt: '2026-10-07T12:00:00.000Z',
  tables: {
    db: { people, statuses: [] },
    companies: { people, statuses: [] },
    contacts: { people, statuses: [] },
  },
  buckets,
})

const bucket = (day: string, addedBy: string, group: TeamStatsBucket['group'], count: number): TeamStatsBucket =>
  ({ table: 'db', day, addedBy, group, count })

describe('blockTable', () => {
  const columns = teamStatsColumns('2026-10-01', '2026-10-03')

  it('keeps a zero row for every person, adds Not set last, and totals All = New + Approve + Reject', () => {
    const table = blockTable([stats('web2mob', [
      bucket('2026-10-01', 'Daria Krut', 'new', 2),
      bucket('2026-10-02', 'Daria Krut', 'approve', 1),
      bucket('2026-10-03', 'Daria Krut', 'reject', 1),
      { ...bucket('2026-10-01', 'David Gamanuk', 'new', 9), table: 'contacts' },
    ])], 'db', columns)

    expect(table.rows.map((row) => row.label)).toEqual(['Daria Krut', 'David Gamanuk', 'Not set'])
    const [daria, david, notSet] = table.rows
    expect(daria.totals).toEqual({ all: 4, new: 2, approve: 1, reject: 1 })
    expect(daria.perColumn.map((counts) => counts.all)).toEqual([2, 1, 1])
    expect(david.totals).toEqual({ all: 0, new: 0, approve: 0, reject: 0 })
    expect(david.perColumn.map((counts) => counts.all)).toEqual([0, 0, 0])
    expect(notSet.person).toBe('')
    expect(table.totals).toEqual({ all: 4, new: 2, approve: 1, reject: 1 })
    expect(table.columnTotals.map((counts) => counts.approve)).toEqual([0, 1, 0])
  })

  it('adds a row for an Added by value that is not a schema choice, and sorts busiest first', () => {
    const table = blockTable([stats('web2mob', [
      bucket('2026-10-01', 'AI', 'new', 3),
      bucket('2026-10-01', 'David Gamanuk', 'new', 1),
      bucket('2026-10-02', '', 'approve', 5),
    ])], 'db', columns)
    expect(table.rows.map((row) => [row.label, row.totals.all])).toEqual([
      ['AI', 3], ['David Gamanuk', 1], ['Daria Krut', 0], ['Not set', 5],
    ])
  })

  it('sums several bases per person, across the union of their people', () => {
    const table = blockTable([
      stats('web2mob', [bucket('2026-10-01', 'Daria Krut', 'approve', 2)]),
      stats('fintech_arabic', [bucket('2026-10-01', 'Daria Krut', 'approve', 3), bucket('2026-10-02', 'Omar Haddad', 'new', 1)], ['Daria Krut', 'Omar Haddad']),
    ], 'db', columns)
    expect(table.rows.map((row) => [row.label, row.totals.all])).toEqual([
      ['Daria Krut', 5], ['Omar Haddad', 1], ['David Gamanuk', 0], ['Not set', 0],
    ])
    expect(table.rows[0].perColumn[0].approve).toBe(5)
  })

  it('folds days into their week column', () => {
    const weeks = teamStatsColumns('2026-09-01', '2026-10-07')
    const table = blockTable([stats('web2mob', [
      bucket('2026-10-05', 'Daria Krut', 'new', 1),
      bucket('2026-10-07', 'Daria Krut', 'new', 2),
    ])], 'db', weeks)
    expect(table.rows[0].perColumn.at(-1)).toEqual({ all: 3, new: 3, approve: 0, reject: 0 })
  })
})
