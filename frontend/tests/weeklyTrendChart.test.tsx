// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { weeklySeries } from '../src/components/reply-analysis/WeeklyTrendChart'

const row = {
  week: '2026-09-07',
  messages: 4,
  reviewed: 3,
  coverage: 0.75,
  sentiment: {
    auto: { numerator: 2, denominator: 4, rate: 0.5 },
    neutral: { numerator: 1, denominator: 4, rate: 0.25 },
    negative: { numerator: 0, denominator: 4, rate: 0 },
  },
}

describe('WeeklyTrendChart', () => {
  it('renders metric-object breakdowns using their numerator instead of [object Object]', () => {
    const { chartRows } = weeklySeries([row], 'sentiment')
    expect(chartRows[0].auto).toBe(2)
    expect(chartRows[0].neutral).toBe(1)
    expect(chartRows[0].negative).toBe(0)
  })

  it('keeps primitive breakdown values working', () => {
    const { chartRows } = weeklySeries([{ ...row, sentiment: undefined, sentiments: { auto: 2, neutral: '1', negative: 0 } }], 'sentiment')
    expect(chartRows[0].auto).toBe(2)
    expect(chartRows[0].neutral).toBe(1)
    expect(chartRows[0].negative).toBe(0)
  })
})
