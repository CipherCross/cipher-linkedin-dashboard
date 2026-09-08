import { describe, expect, it } from 'vitest'
import { buildOverviewAnalytics } from '../src/lib/overviewAnalytics'
import type { DateRange } from '../src/lib/leads'
import type { Lead } from '../src/lib/types'

const range: DateRange = { id: 'custom', label: 'window', from: '2026-01-02', to: '2026-01-03' }
const lead = (overrides: Partial<Lead>): Lead => ({
  id: crypto.randomUUID(), instance_id: 'a', campaign_id: 'c', profile_url: 'p',
  full_name: null, headline: null, company: null, added_at: null,
  invited_at: null, connected_at: null, first_message_at: null, replied_at: null,
  last_action_at: null, ...overrides,
} as Lead)

describe('buildOverviewAnalytics', () => {
  it('deduplicates within and across accounts, uses earliest milestones, and keeps lifetime nulls at zero', () => {
    const result = buildOverviewAnalytics([
      lead({ instance_id: 'a', profile_url: 'same', added_at: '2026-01-02T00:00:00Z', invited_at: '2026-01-02T12:00:00Z' }),
      lead({ instance_id: 'a', profile_url: 'same', invited_at: '2026-01-02T01:00:00Z', connected_at: '2026-01-03T00:00:00Z' }),
      lead({ instance_id: 'b', profile_url: 'same', added_at: '2026-01-02T00:00:00Z', invited_at: '2026-01-02T00:00:00Z', replied_at: '2026-01-03T23:00:00Z' }),
      lead({ instance_id: 'a', profile_url: 'undated' }),
    ], range)
    expect(result.totals.leads).toBe(2)
    expect(result.totals.invited).toBe(2)
    expect(result.totals.connected).toBe(1)
    expect(result.totals.acceptedOfInvited).toBe(1)
    expect(result.lifetime).toMatchObject({ leads: 3, invited: 2, connected: 1, replied: 1, messaged: 0 })
    expect(result.accounts.map((account) => account.instance_id)).toEqual(['a', 'b'])
  })

  it('uses inclusive UTC days and normalizes offset timestamps in activity', () => {
    const result = buildOverviewAnalytics([
      lead({ instance_id: 'a', profile_url: 'x', added_at: '2026-01-02T00:00:00Z', invited_at: '2026-01-03T00:30:00+02:00', connected_at: '2026-01-03T23:59:59Z', replied_at: '2026-01-04T00:00:00Z' }),
    ], range)
    expect(result.totals).toMatchObject({ invited: 1, connected: 1, replied: 0 })
    expect(result.activity).toEqual([
      { day: '2026-01-02', instance_id: 'a', event_type: 'invited', cnt: 1 },
      { day: '2026-01-03', instance_id: 'a', event_type: 'connected', cnt: 1 },
    ])
    expect(result.activity.reduce((sum, row) => sum + row.cnt, 0)).toBe(2)
  })

  it('returns a previous window for dated ranges and null for all time', () => {
    const dated = buildOverviewAnalytics([lead({ added_at: '2025-12-31T00:00:00Z', invited_at: '2026-01-01T12:00:00Z' })], range)
    expect(dated.previous).not.toBeNull()
    expect(dated.previous?.invited).toBe(1)
    expect(buildOverviewAnalytics([], { id: 'all', label: 'All time', from: null, to: null }).previous).toBeNull()
  })

  it('counts undated people in all time and supports open ended UTC ranges', () => {
    const rows = [
      lead({ instance_id: 'a', profile_url: 'undated' }),
      lead({ instance_id: 'a', profile_url: 'early', added_at: '2026-01-01T00:00:00Z', invited_at: '2026-01-01T00:00:00Z' }),
      lead({ instance_id: 'a', profile_url: 'late', added_at: '2026-01-03T00:00:00Z', invited_at: '2026-01-03T00:00:00Z' }),
    ]
    expect(buildOverviewAnalytics(rows, { id: 'all', label: 'All time', from: null, to: null }).totals.leads).toBe(3)
    expect(buildOverviewAnalytics(rows, { id: 'since', label: 'Since', from: '2026-01-02', to: null }).totals.leads).toBe(1)
    expect(buildOverviewAnalytics(rows, { id: 'until', label: 'Until', from: null, to: '2026-01-02' }).totals.leads).toBe(1)
  })

  it('uses the instant, rather than the source offset date, for range membership and duplicate ordering', () => {
    const result = buildOverviewAnalytics([
      lead({ instance_id: 'a', profile_url: 'x', added_at: '2026-01-01T00:00:00Z', invited_at: '2026-01-01T01:00:00+02:00' }),
      lead({ instance_id: 'a', profile_url: 'x', invited_at: '2026-01-01T00:30:00Z' }),
    ], { id: 'day', label: 'Day', from: '2026-01-01', to: '2026-01-01' })
    expect(result.totals.invited).toBe(0)
    expect(result.lifetime.invited).toBe(1)
  })
})
