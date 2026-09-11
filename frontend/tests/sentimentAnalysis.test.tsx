// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { MetricCard, metricRate } from '../src/components/reply-analysis/MetricCard'
import { ReasonBars } from '../src/components/reply-analysis/ReasonBars'
import { addUtcDays, buildRepliesDrilldownHref, defaultAnalyticsBounds, parseAnalytics } from '../src/pages/SentimentAnalysis'
import { ComparisonTable } from '../src/components/reply-analysis/ComparisonTable'
import { WorkflowBuckets } from '../src/components/reply-analysis/WorkflowBuckets'

describe('Sentiment Analysis UI contract', () => {
  it('displays the server numerator/denominator and leaves zero denominator as an em dash', () => {
    render(<BrowserRouter><MetricCard label="Диалоги" metric={{ numerator: 4, denominator: 10, rate: 0.4 }} href="/replies" /></BrowserRouter>)
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByText(/10 всего/)).toBeTruthy()
    expect(metricRate({ numerator: 0, denominator: 0, rate: null })).toBe('—')
  })

  it('preserves base filters and overrides inbox defaults in metric links', () => {
    const href = buildRepliesDrilldownHref({ from: '2026-09-01', to: '2026-10-01', account: 'notebook-1', campaign: 'notebook-1:42', owner: '7' }, { numerator: 2, denominator: 4, rate: 0.5, drilldown: { kind: 'sentiment', value: 'negative' } }, 'negative')
    expect(href).not.toBeNull()
    if (href === null) throw new Error('expected a representable sentiment drilldown')
    const query = new URLSearchParams(href.split('?')[1])
    expect(query.get('scope')).toBe('all')
    expect(query.get('view')).toBe('all')
    expect(query.get('account')).toBe('notebook-1')
    expect(query.get('campaign')).toBe('notebook-1:42')
    expect(query.get('owner')).toBe('7')
    expect(query.get('sentiment')).toBe('negative')
    expect(query.get('from')).toBe('2026-09-01')
  })

  it('uses only supported metric scopes for comparison and latest/only-auto links', () => {
    const comparison = buildRepliesDrilldownHref({ from: '2026-09-01', to: '2026-09-30', account: null, campaign: null, owner: null }, { numerator: 4, denominator: 8, rate: 0.5, drilldown: { kind: 'coverage', value: 'account' } }, 'account:notebook-1')
    expect(comparison).not.toBeNull()
    if (comparison === null) throw new Error('expected a representable account comparison drilldown')
    const comparisonParams = new URLSearchParams(comparison.split('?')[1])
    expect(comparisonParams.get('account')).toBe('notebook-1')
    expect(comparisonParams.get('metric_scope')).toBeNull()
    expect(buildRepliesDrilldownHref({ from: '2026-09-01', to: '2026-09-30', account: null, campaign: null, owner: null }, { numerator: 1, denominator: 8, rate: 0.125, drilldown: { kind: 'coverage', value: 'messages' } }, 'messages')).toBeNull()
    const onlyAuto = buildRepliesDrilldownHref({ from: '2026-09-01', to: '2026-09-30', account: null, campaign: null, owner: null }, { numerator: 1, denominator: 8, rate: 0.125, drilldown: { kind: 'sentiment', value: 'only_auto' } }, 'only_auto')
    expect(onlyAuto).not.toBeNull()
    if (onlyAuto === null) throw new Error('expected a representable only-auto drilldown')
    expect(new URLSearchParams(onlyAuto.split('?')[1]).get('metric_scope')).toBe('coverage:only_auto')
    for (const [kind, value] of [['coverage', 'unreviewed_intent'], ['coverage', 'legacy_ai'], ['reason', 'missing_reason'], ['workflow', 'do_not_contact'], ['workflow', 'transfers']] as const) {
      const link = buildRepliesDrilldownHref({ from: '2026-09-01', to: '2026-09-30', account: null, campaign: null, owner: null }, { numerator: 1, denominator: 8, rate: 0.125, drilldown: { kind, value } }, value)
      expect(link).not.toBeNull()
      if (link === null) throw new Error(`expected a representable ${kind}:${value} drilldown`)
      expect(new URLSearchParams(link.split('?')[1]).get('metric_scope')).toBe(`${kind}:${value}`)
    }
    expect(buildRepliesDrilldownHref({ from: '2026-09-01', to: '2026-09-30', account: null, campaign: null, owner: null }, { numerator: 1, denominator: 8, rate: 0.125, drilldown: { kind: 'coverage', value: 'weekly_messages' } }, 'weekly_messages')).toBeNull()
    expect(buildRepliesDrilldownHref({ from: '2026-09-01', to: '2026-09-30', account: null, campaign: null, owner: null }, { numerator: 1, denominator: 8, rate: 0.125, drilldown: { kind: 'coverage', value: 'campaign' } }, 'campaign:__none__')).toBeNull()
  })

  it('explains that multi-select reason percentages can exceed 100%', () => {
    render(<BrowserRouter><ReasonBars rows={{ budget: { numerator: 2, denominator: 3, rate: 2 / 3 } }} labels={{ budget: 'Нет бюджета' }} linkFor={() => '/replies'} /></BrowserRouter>)
    expect(screen.getByText(/2 диалогов/)).toBeTruthy()
    // The note is rendered by the page; this component keeps one-dialog-per-reason semantics.
    expect(screen.getByRole('link').getAttribute('href')).toBe('/replies')
  })

  it('uses 30 UTC calendar days ending today', () => {
    const bounds = defaultAnalyticsBounds(new Date('2026-09-11T18:30:00.000Z'))
    expect(bounds.from).toBe('2026-08-13')
    expect(bounds.to).toBe('2026-09-11')
  })

  it('makes weekly links cover the full seven-day UTC week', () => {
    expect(addUtcDays('2026-09-07', 6)).toBe('2026-09-13')
    const href = buildRepliesDrilldownHref({ from: '2026-09-07', to: '2026-09-13', account: null, campaign: null, owner: null }, { numerator: 3, denominator: 5, rate: 0.6, drilldown: { kind: 'coverage', value: 'weekly_volume' } }, 'week')
    expect(href).not.toBeNull()
    if (href === null) throw new Error('expected a representable weekly dialogue drilldown')
    const query = new URLSearchParams(href.split('?')[1])
    expect(query.get('from')).toBe('2026-09-07')
    expect(query.get('to')).toBe('2026-09-13')
  })

  it('renders the server-provided top reason in comparison rows', () => {
    render(<BrowserRouter><ComparisonTable rows={[{ kind: 'campaign', id: 'c1', numerator: 6, denominator: 10, rate: 0.2, coverage: 0.6, top_reasons: [{ id: 'budget', label: 'Нет бюджета', numerator: 3 }] }]} labelFor={() => 'Campaign'} linkFor={() => '/replies'} /></BrowserRouter>)
    expect(screen.getByText(/Нет бюджета · 3/)).toBeTruthy()
  })

  it('renders an unrepresentable no-campaign comparison as non-clickable', () => {
    const { container } = render(<BrowserRouter><ComparisonTable rows={[{ kind: 'campaign', id: '__none__', numerator: 2, denominator: 2, rate: null, coverage: 1 }]} labelFor={() => 'Без кампании'} linkFor={(row) => buildRepliesDrilldownHref({ from: '2026-09-01', to: '2026-09-30', account: null, campaign: null, owner: null }, row, 'campaign:__none__')} /></BrowserRouter>)
    expect(within(container).queryByRole('link')).toBeNull()
    expect(within(container).getByText('Без кампании')).toBeTruthy()
  })

  it('normalizes string-valued weekly server fields without letting raw values overwrite them', () => {
    const parsed = parseAnalytics({ weekly_trend: [{ week: '2026-09-07', messages: '12', reviewed: '8', coverage: { numerator: '8', denominator: '12', rate: '0.6667', drilldown: { kind: 'coverage', value: 'weekly_messages' } }, volume: { numerator: '4', denominator: '4', rate: '1', drilldown: { kind: 'coverage', value: 'weekly_volume' } } }] })
    const row = parsed.weekly_trend[0]
    expect(row.week).toBe('2026-09-07')
    expect(row.messages).toBe(12)
    expect(row.reviewed).toBe(8)
    expect(row.coverage).toBeCloseTo(0.6667)
    expect(row.metric?.numerator).toBe(4)
  })

  it('keeps workflow precedence canonical and does not invent an unassigned bucket', () => {
    const { container } = render(<BrowserRouter><WorkflowBuckets rows={{ do_not_contact: { numerator: 1, denominator: 3, rate: 1 / 3 }, needs_confirmation: { numerator: 1, denominator: 3, rate: 1 / 3 }, follow_up_later: { numerator: 1, denominator: 3, rate: 1 / 3 }, transfers: { numerator: 2, denominator: 2, rate: 1 } }} linkFor={() => '/replies'} /></BrowserRouter>)
    const labels = within(container).getAllByRole('listitem').map((link) => link.textContent ?? '')
    expect(labels[0]).toContain('Не связываться')
    expect(labels[1]).toContain('Без подтверждённого шага')
    expect(labels.findIndex((label) => label.includes('Follow-up позже'))).toBeGreaterThan(labels.findIndex((label) => label.includes('Без подтверждённого шага')))
    expect(labels.some((label) => label.includes('Без действия'))).toBe(false)
    expect(labels.filter((label) => label.includes('Передачи (события)'))).toHaveLength(1)
  })
})
