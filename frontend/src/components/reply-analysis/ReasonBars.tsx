import { Link } from 'react-router-dom'
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
    <div className="sa-reason-list" role="list" aria-label="Decline and objection reasons">
      {entries.length === 0 ? <p className="muted">No reasons recorded in this period.</p> : entries.map(([key, metric]) => (
        (() => { const href = linkFor(metric, key); const content = <><span className="sa-reason-copy"><strong>{labels[key] ?? key}</strong><small>{metric.numerator.toLocaleString(UI_LOCALE)}  conversations · {metric.rate == null ? '—' : `${(metric.rate * 100).toFixed(1)}%`}</small></span><span className="sa-reason-track" aria-hidden="true"><span style={{ width: `${Math.round(metric.numerator / max * 100)}%` }} /></span></>; return href ? <Link key={key} to={href} className="sa-reason-row" role="listitem">{content}</Link> : <div key={key} className="sa-reason-row sa-disabled-drilldown" role="listitem">{content}</div> })()
      ))}
    </div>
  )
}
