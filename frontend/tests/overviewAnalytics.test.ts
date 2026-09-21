import { describe, expect, it } from 'vitest'
import { buildOverviewAnalytics, buildOverviewSystemTotals } from '../src/lib/overviewAnalytics'
import { comparisonLabel, pct } from '../src/lib/format'
import { previousRange, type DateRange } from '../src/lib/leads'
import type { Lead } from '../src/lib/types'

const lead = (overrides: Partial<Lead>): Lead => ({
  id: crypto.randomUUID(), instance_id: 'a', campaign_id: 'c', profile_url: 'p',
  full_name: null, headline: null, company: null, added_at: null,
  invited_at: null, connected_at: null, first_message_at: null, replied_at: null,
  last_action_at: null, pipeline_stage: null, pipeline_substatus: null, lost_reason: null,
  pipeline_stage_changed_at: null, assigned_to: null, ...overrides,
})

const range: DateRange = { id: 'custom', label: '2–3 Jan', from: '2026-01-02', to: '2026-01-03' }

describe('Overview fallback cohort semantics', () => {
  it('deduplicates by account and profile, honors cohort boundaries, and follows late outcomes', () => {
    const result = buildOverviewSystemTotals([
      lead({ instance_id: 'a', profile_url: 'same', invited_at: '2026-01-02T12:00:00Z' }),
      lead({ instance_id: 'a', profile_url: 'same', connected_at: '2026-01-05T12:00:00Z', first_message_at: '2026-01-06T12:00:00Z', replied_at: '2026-01-07T12:00:00Z' }),
      lead({ instance_id: 'a', profile_url: 'new', invited_at: '2026-01-03T12:00:00Z' }),
      lead({ instance_id: 'b', profile_url: 'same', invited_at: '2026-01-02T12:00:00Z' }),
      lead({ instance_id: 'a', profile_url: 'organic', connected_at: '2026-01-02T12:00:00Z' }),
      lead({ instance_id: 'a', profile_url: 'old', invited_at: '2026-01-01T12:00:00Z', connected_at: '2026-01-02T12:00:00Z', replied_at: '2026-01-03T00:00:00Z' }),
    ], range)

    expect(result.invited).toBe(3)
    expect(result.connected).toBe(1)
    expect(result.messaged).toBe(1)
    expect(result.replied).toBe(1)
    // The organic connection and the old invite are not in this invite cohort.
    expect(result.connected).toBeLessThanOrEqual(result.invited)
  })

  it('pins the 100/40/30/10 contract exactly', () => {
    const rows = Array.from({ length: 100 }, (_, index) => lead({
      profile_url: `p-${index}`,
      added_at: '2026-01-02T00:00:00Z',
      invited_at: '2026-01-02T00:00:00Z',
      connected_at: index < 40 ? '2026-01-05T00:00:00Z' : null,
      first_message_at: index < 30 ? '2026-01-06T00:00:00Z' : null,
      replied_at: index < 10 ? '2026-01-07T00:00:00Z' : null,
    }))
    const totals = buildOverviewSystemTotals(rows, range)
    expect(totals).toMatchObject({ invited: 100, connected: 40, messaged: 30, replied: 10 })
    expect((100 * totals.connected) / totals.invited).toBe(40)
    expect((100 * totals.messaged) / totals.connected).toBe(75)
    expect((100 * totals.replied) / totals.connected).toBe(25)
  })

  it('uses event-time current/previous activity but cohort totals for conversion', () => {
    const result = buildOverviewAnalytics([
      lead({ profile_url: 'late', invited_at: '2026-01-02T00:00:00Z', connected_at: '2026-01-10T00:00:00Z', replied_at: '2026-01-11T00:00:00Z' }),
      lead({ profile_url: 'previous', invited_at: '2025-12-26T00:00:00Z' }),
    ], { id: '7_days', label: 'Past 7 days', from: '2026-01-02', to: '2026-01-08' })
    expect(result.totals).toMatchObject({ invited: 1, connected: 0, replied: 0 })
    expect(result.cohort).toMatchObject({ invited: 1, connected: 1, replied: 1 })
    expect(result.previous?.invited).toBe(1)
    expect(result.previousCohort?.invited).toBe(1)
  })

  it('keeps all zero denominators finite and explicit', () => {
    const empty = buildOverviewSystemTotals([], range)
    expect(empty).toEqual({ leads: 0, invited: 0, connected: 0, messaged: 0, replied: 0 })
    expect(comparisonLabel(0, 0, range)).toBe('0.0% vs previous 2 days · 0')
    expect(comparisonLabel(3, 0, range)).toBe('New vs previous 2 days · 0')
    expect(comparisonLabel(3, null, { from: null, to: null })).toBe('No comparison')
    expect(pct(empty.replied, empty.connected)).toBe('—')
    expect(comparisonLabel(0, 0, range)).not.toMatch(/NaN|Infinity/)
  })

  it('uses equal previous windows for 7-day, 30-day, and custom ranges', () => {
    expect(previousRange({ id: '7', label: '7', from: '2026-09-01', to: '2026-09-07' })).toMatchObject({ from: '2026-08-25', to: '2026-08-31' })
    expect(previousRange({ id: '30', label: '30', from: '2026-09-01', to: '2026-09-30' })).toMatchObject({ from: '2026-08-02', to: '2026-08-31' })
    expect(previousRange({ id: 'custom', label: 'custom', from: '2026-09-10', to: '2026-09-12' })).toMatchObject({ from: '2026-09-07', to: '2026-09-09' })
    expect(previousRange({ id: 'all', label: 'All time', from: null, to: null })).toBeNull()
  })
})
