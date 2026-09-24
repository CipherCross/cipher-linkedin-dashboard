// @vitest-environment jsdom
/**
 * Sentiment analysis after the Phase 9 conversion to the canonical `src/ui`
 * contracts: the comparison table moved onto `TableFrame`/`Table`, the trend's
 * mode switches moved onto `SegmentedControl`, and a failed read now surfaces
 * through the shared `InlineError` alert. `tests/sentimentAnalysis.test.tsx`
 * still owns the drilldown-href and parsing contracts; this file only pins the
 * page/component chrome those tests don't render.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  act, cleanup, fireEvent, render, screen, within,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import {
  afterEach, describe, expect, it, vi,
} from 'vitest'
import type { Message } from '../src/lib/types'

const data = vi.hoisted(() => ({
  value: {
    instances: [{ id: 'notebook-1', label: 'Notebook One', account_name: 'Ada Admin LI' }],
    campaigns: [{ campaign_id: 'notebook-1:1', campaign_name: 'Intro sequence', instance_id: 'notebook-1' }],
    teamMembers: [{ id: 1, name: 'Ada Admin', active: true, email: 'ada@fixture.test' }],
  } as unknown,
}))

vi.mock('../src/lib/DataContext', () => ({ useData: () => ({ data: data.value }) }))

import { SentimentAnalysis, parseAnalytics } from '../src/pages/SentimentAnalysis'
import { SentimentTrendChart } from '../src/components/SentimentTrendChart'

const RAW_ANALYTICS = {
  coverage: {
    dialogues: { numerator: 3, denominator: 3, rate: 1 },
    messages: { numerator: 3, denominator: 3, rate: 1 },
    unreviewed_dialogues: { numerator: 0, denominator: 3, rate: 0 },
  },
  sentiment: {
    positive: { numerator: 2, denominator: 3, rate: 2 / 3 },
    neutral: { numerator: 1, denominator: 3, rate: 1 / 3 },
    negative: { numerator: 0, denominator: 3, rate: 0 },
    objection: { numerator: 0, denominator: 3, rate: 0 },
    referral: { numerator: 0, denominator: 3, rate: 0 },
    auto: { numerator: 0, denominator: 3, rate: 0 },
    business_rate: { numerator: 0, denominator: 3, rate: 0 },
  },
  reasons: {},
  weekly_trend: [{
    week: '2026-09-07',
    messages: 3,
    reviewed: 3,
    coverage: { numerator: 3, denominator: 3, rate: 1 },
    volume: { numerator: 3, denominator: 3, rate: 1 },
    sentiment: {
      positive: 2, neutral: 1, negative: 0, objection: 0, referral: 0, auto: 0,
    },
  }],
  workflow: { needs_confirmation: { numerator: 1, denominator: 3, rate: 1 / 3 } },
  comparison: [
    {
      kind: 'account', id: 'notebook-1', name: 'Notebook One', volume: 3,
      coverage: { numerator: 3, denominator: 3, rate: 1 }, neg_objection: { numerator: 0, denominator: 3, rate: 0 },
    },
  ],
  dataset_at: '2026-09-20T00:00:00.000Z',
}

async function renderPage(reader: () => Promise<ReturnType<typeof parseAnalytics>>) {
  render(<MemoryRouter><SentimentAnalysis reader={reader} /></MemoryRouter>)
  await act(async () => {})
}

afterEach(cleanup)

describe('Sentiment analysis page chrome', () => {
  it('renders the comparison table as a named table', async () => {
    await renderPage(async () => parseAnalytics(RAW_ANALYTICS))

    const table = screen.getByRole('table', { name: 'Accounts and campaigns compared' })
    expect(within(table).getByText('Ada Admin LI')).toBeTruthy()
  })

  it('shows a retryable alert on a failed read, and Retry re-reads', async () => {
    let calls = 0
    const reader = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('Analytics endpoint is down')
      return parseAnalytics(RAW_ANALYTICS)
    })
    await renderPage(reader)

    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Could not load the analytics.')).toBeTruthy()

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await act(async () => {})

    expect(reader).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('table', { name: 'Accounts and campaigns compared' })).toBeTruthy()
  })
})

describe('SentimentTrendChart', () => {
  function message(overrides: Partial<Message> = {}): Message {
    return {
      id: 1,
      instance_id: 'notebook-1',
      campaign_id: 'notebook-1:1',
      profile_url: 'https://www.linkedin.com/in/lead-1',
      direction: 'in',
      body: 'Sounds good',
      sent_at: new Date().toISOString(),
      sentiment: 'positive',
      reason: null,
      classified_at: null,
      intent_level: 'p3',
      ...overrides,
    }
  }

  it('is a segmented control (radiogroup) whose selection changes on click', () => {
    render(<SentimentTrendChart messages={[message()]} weeks={4} />)

    const dimension = screen.getByRole('radiogroup', { name: 'Classification dimension' })
    expect(dimension).toBeTruthy()

    const intentOption = screen.getByRole('radio', { name: 'P1–P3 intent' })
    const sentimentOption = screen.getByRole('radio', { name: 'Sentiment' })
    expect(intentOption.getAttribute('aria-checked')).toBe('true')
    expect(sentimentOption.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(sentimentOption)

    expect(sentimentOption.getAttribute('aria-checked')).toBe('true')
    expect(intentOption.getAttribute('aria-checked')).toBe('false')
  })

  it('also exposes the scale toggle as a segmented control', () => {
    render(<SentimentTrendChart messages={[message()]} weeks={4} />)

    const scale = screen.getByRole('radiogroup', { name: 'Scale' })
    const share = within(scale).getByRole('radio', { name: 'Share' })
    expect(share.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(share)

    expect(share.getAttribute('aria-checked')).toBe('true')
  })
})

describe('No hex color literals in the converted charts', () => {
  const files = [
    '../src/components/reply-analysis/ComparisonTable.tsx',
    '../src/components/reply-analysis/MetricCard.tsx',
    '../src/components/reply-analysis/ReasonBars.tsx',
    '../src/components/reply-analysis/SentimentDistributionChart.tsx',
    '../src/components/reply-analysis/WeeklyTrendChart.tsx',
    '../src/components/reply-analysis/WorkflowBuckets.tsx',
    '../src/components/SentimentTrendChart.tsx',
  ]

  it('draws every series color from chartTheme, never a hex literal', () => {
    const hex = /#[0-9a-fA-F]{3,8}\b/
    for (const relative of files) {
      const path = fileURLToPath(new URL(relative, import.meta.url))
      const content = readFileSync(path, 'utf8')
      expect(hex.test(content), `${relative} still has a hex color literal`).toBe(false)
    }
  })
})
