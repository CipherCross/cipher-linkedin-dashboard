// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { WeeklyTrendChart } from '../src/components/reply-analysis/WeeklyTrendChart'

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
  afterEach(() => cleanup())

  it('renders metric-object breakdowns using their numerator instead of [object Object]', () => {
    render(<BrowserRouter><WeeklyTrendChart rows={[row]} mode="counts" linkFor={() => null} /></BrowserRouter>)

    expect(screen.getByText(/auto: 2 · neutral: 1 · negative: 0/)).toBeTruthy()
    expect(screen.queryByText(/\[object Object\]/)).toBeNull()
  })

  it('keeps primitive breakdown values working', () => {
    render(<BrowserRouter><WeeklyTrendChart rows={[{ ...row, sentiment: undefined, sentiments: { auto: 2, neutral: '1', negative: 0 } }]} mode="counts" linkFor={() => null} /></BrowserRouter>)

    expect(screen.getByText(/auto: 2 · neutral: 1 · negative: 0/)).toBeTruthy()
  })
})
