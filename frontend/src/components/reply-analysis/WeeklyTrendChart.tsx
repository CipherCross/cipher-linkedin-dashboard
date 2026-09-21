import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { REASON_LABELS, SENTIMENT_LABELS } from '../../lib/replyReview'
import type { AnalyticsMetric } from './MetricCard'
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

const SENTIMENT_COLORS: Record<string, string> = {
  positive: '#38b27d', neutral: '#8792a8', negative: '#e16b71',
  objection: '#e9a447', referral: '#8d7bea', auto: '#6d788c',
  latest_unreviewed: '#d79a49', only_auto: '#b36bce',
}
const REASON_COLORS = ['#e16b71', '#e9a447', '#8d7bea', '#38b27d', '#6d788c']

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
  const keys = mode === 'sentiment' ? Object.keys(SENTIMENT_COLORS)
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
  if (!rows.length) return <p className="muted">No inbound messages in this period.</p>
  const { keys, chartRows } = weeklySeries(rows, mode)
  const label = (key: string) => mode === 'sentiment' ? (SENTIMENT_LABELS as Record<string, string>)[key] ?? (key === 'latest_unreviewed' ? 'Unreviewed' : 'Automated replies only')
    : mode === 'reasons' ? (REASON_LABELS as Record<string, string>)[key] ?? key
      : key === 'reviewed' ? 'Reviewed' : 'Unreviewed'
  return <div >
    <p className="muted small">{mode === 'coverage' ? 'Messages by week' : 'Conversations by week'} · the current week may still be incomplete</p>
    {keys.length === 0 ? <p className="muted">No reasons recorded in this period yet.</p> : <div className="min-h-[260px] min-w-0 w-full" role="img" aria-label="Weekly trend">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={chartRows} margin={{ top: 8, right: 8, bottom: 12, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="week" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip formatter={(value, name) => [Number(value).toLocaleString(UI_LOCALE), label(String(name))]} />
          <Legend formatter={(value) => label(String(value))} />
          {keys.map((key, index) => <Bar key={key} dataKey={key} stackId={mode === 'reasons' ? undefined : 'total'} fill={mode === 'sentiment' ? SENTIMENT_COLORS[key] : mode === 'reasons' ? REASON_COLORS[index % REASON_COLORS.length] : key === 'reviewed' ? '#38b27d' : '#d79a49'} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>}
    <div className="flex flex-wrap gap-app-sm mt-app-md [&_a]:px-app-sm [&_a]:py-app-xs [&_a]:rounded-control [&_a]:bg-app-surface-2 [&_a]:text-app-text-secondary [&_a]:text-app-meta [&_a]:no-underline [&_span]:px-app-sm [&_span]:py-app-xs [&_span]:rounded-control [&_span]:bg-app-surface-2 [&_span]:text-app-text-secondary [&_span]:text-app-meta">{rows.map((row) => { const href = linkFor(row); return href ? <Link key={row.week} to={href}>{weekLabel(row.week)} · {row.messages} messages</Link> : <span key={row.week}>{weekLabel(row.week)}</span> })}</div>
  </div>
}
