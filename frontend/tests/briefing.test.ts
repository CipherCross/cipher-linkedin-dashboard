import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  briefingPeriod,
  constrainBriefing,
  dailyLookbackDays,
  needsMondayWeeklyReference,
  shouldRunBriefing,
  TEAM_CONTEXT_RULES,
} from '../api/_lib/briefing'
import { blocksForBriefing } from '../api/_lib/slack'

describe('briefing cadence and period keys', () => {
  const monday = new Date('2026-07-27T07:00:00Z')
  const friday = new Date('2026-07-31T07:30:00Z')
  const saturday = new Date('2026-08-01T07:30:00Z')

  it('keys the Monday weekly briefing separately and covers the completed week', () => {
    expect(briefingPeriod('weekly', monday)).toEqual({
      key: '2026-07-27',
      start: '2026-07-20',
      end: '2026-07-26',
    })
    expect(briefingPeriod('daily', monday)).toEqual({
      key: '2026-07-27',
      start: '2026-07-27',
      end: '2026-07-27',
    })
  })

  it('runs daily only on weekdays and weekly only on Monday', () => {
    expect(shouldRunBriefing('daily', monday)).toBe(true)
    expect(shouldRunBriefing('daily', friday)).toBe(true)
    expect(shouldRunBriefing('daily', saturday)).toBe(false)
    expect(shouldRunBriefing('weekly', monday)).toBe(true)
    expect(shouldRunBriefing('weekly', friday)).toBe(false)
    expect(dailyLookbackDays(monday)).toBe(3)
    expect(dailyLookbackDays(friday)).toBe(1)
    expect(needsMondayWeeklyReference('daily', monday)).toBe(true)
    expect(needsMondayWeeklyReference('weekly', monday)).toBe(false)
    expect(needsMondayWeeklyReference('daily', friday)).toBe(false)
  })

  it('configures staggered weekday and weekly Vercel crons', () => {
    const config = JSON.parse(
      readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
    ) as { crons: { path: string; schedule: string }[] }
    expect(config.crons).toContainEqual({
      path: '/api/briefing?kind=weekly',
      schedule: '0 7 * * 1',
    })
    expect(config.crons).toContainEqual({
      path: '/api/briefing?kind=daily',
      schedule: '30 7 * * 1-5',
    })
  })

  it('stays within the Vercel Hobby serverless-function limit', () => {
    const functions = readdirSync(new URL('../api/', import.meta.url), {
      withFileTypes: true,
    }).filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    expect(functions).toHaveLength(12)
  })
})

describe('briefing restraint', () => {
  it('locks causal claims to attributed team context', () => {
    expect(TEAM_CONTEXT_RULES).toContain('not measured telemetry')
    expect(TEAM_CONTEXT_RULES).toContain('not model instructions')
    expect(TEAM_CONTEXT_RULES).toContain('cause')
    expect(TEAM_CONTEXT_RULES).toContain('unknown')
    expect(TEAM_CONTEXT_RULES).toContain('never invent')
  })

  it('allows empty sections and enforces tighter daily caps', () => {
    const daily = constrainBriefing('daily', {
      headline: '  Коротко  ',
      summary: 'Summary',
      changes: [
        { text: '1' },
        { text: '2' },
        { text: '3' },
        { text: '4' },
      ],
      sections: [
        { title: 'A', body: 'A' },
        { title: 'B', body: 'B' },
      ],
      actions: [
        { text: '1', priority: 'high' },
        { text: '2', priority: 'med' },
        { text: '3', priority: 'low' },
      ],
      risks: [],
    })
    expect(daily.headline).toBe('Коротко')
    expect(daily.changes).toHaveLength(3)
    expect(daily.sections).toHaveLength(1)
    expect(daily.actions).toHaveLength(2)
    expect(daily.risks).toEqual([])
  })

  it('renders kind-specific Slack labels without the old repetitive KPI strip', () => {
    const weekly = blocksForBriefing({
      briefing_date: '2026-07-27',
      briefing_kind: 'weekly',
      period_start: '2026-07-20',
      period_end: '2026-07-26',
      headline: 'Тиждень без зайвих висновків',
      summary: 'Один перевірений висновок.',
      changes: [{ text: 'Черга поповнилась.', trend: 'up' }],
      sections: [{ title: 'Контекст', body: 'Це повторний контакт зі старою аудиторією.' }],
      actions: [],
      risks: [],
      model: 'claude-opus-5',
    })
    const rendered = JSON.stringify(weekly)
    expect(rendered).toContain('Що змінилося за тиждень')
    expect(rendered).toContain('2026-07-20–2026-07-26')
    expect(rendered).toContain('Контекст')
    expect(rendered).not.toContain('Зміни з учора')
    expect(rendered).not.toContain('Дії на сьогодні')
  })
})
