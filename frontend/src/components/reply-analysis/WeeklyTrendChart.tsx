import { Link } from 'react-router-dom'
import type { AnalyticsMetric } from './MetricCard'

export interface WeeklyTrendRow {
  week: string
  messages: number
  reviewed: number
  coverage: number | null
  metric?: AnalyticsMetric
  [key: string]: unknown
}

function trendBreakdown(row: WeeklyTrendRow): string | null {
  const value = row.sentiment ?? row.sentiments ?? row.reasons ?? row.reason_counts
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => String(item)).join(' · ')
  return Object.entries(value as Record<string, unknown>).slice(0, 3).map(([key, count]) => `${key}: ${String(count)}`).join(' · ')
}

export function WeeklyTrendChart({
  rows,
  mode,
  linkFor,
}: {
  rows: readonly WeeklyTrendRow[]
  mode: 'counts' | 'rates'
  linkFor: (row: WeeklyTrendRow) => string | null
}) {
  const max = Math.max(1, ...rows.map((row) => mode === 'counts' ? row.messages : (row.coverage ?? 0)))
  return (
    <div className="sa-trend" role="list" aria-label="Недельная динамика">
      {rows.length === 0 ? <p className="muted">Нет входящих сообщений в выбранном периоде.</p> : rows.map((row) => {
        const value = mode === 'counts' ? row.messages : row.coverage
        const display = mode === 'counts' ? `${row.messages.toLocaleString('ru-RU')} сообщений` : value == null ? '—' : `${(value * 100).toFixed(1)}% покрытия`
        const content = <><span className="sa-trend-week">{row.week}</span><span className="sa-trend-track" aria-hidden="true"><span style={{ width: `${Math.round(((value ?? 0) / max) * 100)}%` }} /></span><span className="sa-trend-value">{display}<small>{row.reviewed.toLocaleString('ru-RU')} разобрано</small>{trendBreakdown(row) && <small>{trendBreakdown(row)}</small>}</span></>
        const href = linkFor(row)
        return href ? (
          <Link className="sa-trend-row" key={row.week} to={href} role="listitem">
            {content}
          </Link>
        ) : <div className="sa-trend-row sa-disabled-drilldown" key={row.week} role="listitem">{content}</div>
      })}
    </div>
  )
}
