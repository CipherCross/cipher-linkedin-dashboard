import { Link } from 'react-router-dom'
import { SA_ROW, SA_TRACK, SA_DISABLED } from './classes'
import type { AnalyticsMetric } from './MetricCard'
import { UI_LOCALE } from '../../ui/datetime'

export function ReasonBars({
  rows,
  labels,
  linkFor,
  showZero = false,
}: {
  rows: Readonly<Record<string, AnalyticsMetric>>
  labels: Record<string, string>
  linkFor: (metric: AnalyticsMetric, key: string) => string | null
  showZero?: boolean
}) {
  const entries = Object.entries(rows).filter(([, value]) => showZero || value.numerator > 0).sort(([, a], [, b]) => b.numerator - a.numerator)
  const max = Math.max(1, ...entries.map(([, metric]) => metric.numerator))
  return (
    <div className="flex flex-col gap-app-sm" role="list" aria-label="Decline and objection reasons">
      {entries.length === 0 ? <p className="muted">No reasons recorded in this period.</p> : entries.map(([key, metric]) => (
        (() => { const href = linkFor(metric, key); const content = <><span className="min-w-0 flex flex-col gap-0.5 [&_strong]:text-app-table [&_strong]:font-semibold [&_small]:text-app-text-muted [&_small]:text-app-meta"><strong>{labels[key] ?? key}</strong><small>{metric.numerator.toLocaleString(UI_LOCALE)}  conversations · {metric.rate == null ? '—' : `${(metric.rate * 100).toFixed(1)}%`}</small></span><span className={`${SA_TRACK} [&>span]:block [&>span]:h-full [&>span]:rounded-[inherit] [&>span]:bg-app-accent`} aria-hidden="true"><span style={{ width: `${Math.round(metric.numerator / max * 100)}%` }} /></span></>; return href ? <Link key={key} to={href} className={`${SA_ROW} grid-cols-[minmax(200px,1fr)_minmax(90px,1.2fr)]`} role="listitem">{content}</Link> : <div key={key} className={`${SA_ROW} ${SA_DISABLED} grid-cols-[minmax(200px,1fr)_minmax(90px,1.2fr)]`} role="listitem">{content}</div> })()
      ))}
    </div>
  )
}
