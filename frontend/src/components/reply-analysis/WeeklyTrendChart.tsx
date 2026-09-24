import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { REASON_LABELS, SENTIMENT_LABELS } from '../../lib/replyReview'
import type { AnalyticsMetric } from './MetricCard'
import { AXIS, BAR_CURSOR, GRID, NO_ANIM, REASON_SERIES, REVIEW_SERIES, SENTIMENT_SERIES, TOOLTIP } from '../chartTheme'
import { UI_LOCALE } from '../../ui/datetime'

export interface WeeklyTrendRow {
  week: string
  messages: number
  reviewed: number
  coverage: number | null
  metric?: AnalyticsMetric
  [key: string]: unknown
}

export type WeeklyTrendMode = 'sentiment' | 'reasons' | 'coverage'

/** Order for the sentiment mode's stacked bars — the same set `SENTIMENT_SERIES`
 *  colours, kept as its own list because the mode also needs an ordering, not
 *  just a palette (`Object.keys` on a shared theme map would also pull in
 *  `unreviewed`/`unclassified`, which this dimension never reports). */
const SENTIMENT_TREND_KEYS = ['positive', 'neutral', 'negative', 'objection', 'referral', 'auto', 'latest_unreviewed', 'only_auto'] as const

function count(value: unknown): number {
  if (value && typeof value === 'object') return Number((value as { numerator?: unknown }).numerator ?? 0) || 0
  return Number(value ?? 0) || 0
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function weekLabel(week: string): string {
  const start = new Date(week + 'T00:00:00Z')
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 6)
  const day = (date: Date) => new Intl.DateTimeFormat(UI_LOCALE, { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(date)
  return day(start) + ' – ' + day(end)
}

export function weeklySeries(rows: readonly WeeklyTrendRow[], mode: WeeklyTrendMode) {
  const reasonTotals = new Map<string, number>()
  rows.forEach((row) => Object.entries(record(row.reasons ?? row.reason_counts)).forEach(([key, value]) => reasonTotals.set(key, (reasonTotals.get(key) ?? 0) + count(value))))
  const topReasons = [...reasonTotals].filter(([, total]) => total > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key]) => key)
  const keys = mode === 'sentiment' ? [...SENTIMENT_TREND_KEYS]
    : mode === 'reasons' ? topReasons : ['reviewed', 'pending']
  const chartRows = rows.map((row) => {
    const values: Record<string, string | number> = { week: weekLabel(row.week) }
    keys.forEach((key) => {
      values[key] = mode === 'coverage' ? key === 'reviewed' ? row.reviewed : Math.max(0, row.messages - row.reviewed)
        : count(record(mode === 'sentiment' ? row.sentiment ?? row.sentiments : row.reasons ?? row.reason_counts)[key])
    })
    return values
  })
  return { keys, chartRows }
}

export function WeeklyTrendChart({
  rows, mode, linkFor,
}: {
  rows: readonly WeeklyTrendRow[]
  mode: WeeklyTrendMode
  linkFor: (row: WeeklyTrendRow) => string | null
}) {
  if (!rows.length) return <p className="text-app-text-muted">No inbound messages in this period.</p>
  const { keys, chartRows } = weeklySeries(rows, mode)
  const label = (key: string) => mode === 'sentiment' ? (SENTIMENT_LABELS as Record<string, string>)[key] ?? (key === 'latest_unreviewed' ? 'Unreviewed' : 'Automated replies only')
    : mode === 'reasons' ? (REASON_LABELS as Record<string, string>)[key] ?? key
      : key === 'reviewed' ? 'Reviewed' : 'Unreviewed'
  return <div >
    <p className="text-app-text-muted text-app-meta">{mode === 'coverage' ? 'Messages by week' : 'Conversations by week'} · the current week may still be incomplete</p>
    {keys.length === 0 ? <p className="text-app-text-muted">No reasons recorded in this period yet.</p> : <div className="min-h-[260px] min-w-0 w-full" role="img" aria-label="Weekly trend">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={chartRows} margin={{ top: 8, right: 8, bottom: 12, left: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="week" {...AXIS} />
          <YAxis allowDecimals={false} {...AXIS} />
          <Tooltip {...TOOLTIP} cursor={BAR_CURSOR} formatter={(value, name) => [Number(value).toLocaleString(UI_LOCALE), label(String(name))]} />
          <Legend formatter={(value) => label(String(value))} />
          {keys.map((key, index) => <Bar key={key} {...NO_ANIM} dataKey={key} stackId={mode === 'reasons' ? undefined : 'total'} fill={mode === 'sentiment' ? SENTIMENT_SERIES[key] : mode === 'reasons' ? REASON_SERIES[index % REASON_SERIES.length] : key === 'reviewed' ? REVIEW_SERIES.reviewed : REVIEW_SERIES.unreviewed} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>}
    <div className="flex flex-wrap gap-app-sm mt-app-md [&_a]:px-app-sm [&_a]:py-app-xs [&_a]:rounded-control [&_a]:bg-app-surface-2 [&_a]:text-app-text-secondary [&_a]:text-app-meta [&_a]:no-underline [&_span]:px-app-sm [&_span]:py-app-xs [&_span]:rounded-control [&_span]:bg-app-surface-2 [&_span]:text-app-text-secondary [&_span]:text-app-meta">{rows.map((row) => { const href = linkFor(row); return href ? <Link key={row.week} to={href}>{weekLabel(row.week)} · {row.messages} messages</Link> : <span key={row.week}>{weekLabel(row.week)}</span> })}</div>
  </div>
}
