import { Link } from 'react-router-dom'
import type { AnalyticsMetric } from './MetricCard'

export function ReasonBars({
  rows,
  labels,
  linkFor,
}: {
  rows: Readonly<Record<string, AnalyticsMetric>>
  labels: Record<string, string>
  linkFor: (metric: AnalyticsMetric, key: string) => string | null
}) {
  const entries = Object.entries(rows).sort(([, a], [, b]) => b.numerator - a.numerator)
  const max = Math.max(1, ...entries.map(([, metric]) => metric.numerator))
  return (
    <div className="sa-reason-list" role="list" aria-label="Причины отказа и возражений">
      {entries.length === 0 ? <p className="muted">Причин за выбранный период нет.</p> : entries.map(([key, metric]) => (
        (() => { const href = linkFor(metric, key); const content = <><span className="sa-reason-copy"><strong>{labels[key] ?? key}</strong><small>{metric.numerator.toLocaleString('ru-RU')} диалогов · {metric.rate == null ? '—' : `${(metric.rate * 100).toFixed(1)}%`}</small></span><span className="sa-reason-track" aria-hidden="true"><span style={{ width: `${Math.round(metric.numerator / max * 100)}%` }} /></span></>; return href ? <Link key={key} to={href} className="sa-reason-row" role="listitem">{content}</Link> : <div key={key} className="sa-reason-row sa-disabled-drilldown" role="listitem">{content}</div> })()
      ))}
    </div>
  )
}
