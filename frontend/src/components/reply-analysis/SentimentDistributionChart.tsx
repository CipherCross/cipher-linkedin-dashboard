import { Link } from 'react-router-dom'
import type { AnalyticsMetric } from './MetricCard'

const COLORS: Record<string, string> = {
  positive: '#38b27d', neutral: '#8792a8', negative: '#e16b71', objection: '#e9a447', referral: '#8d7bea', auto: '#6d788c', latest_unreviewed: '#d79a49', unreviewed: '#d79a49', only_auto: '#b36bce',
}

export function DistributionChart({
  rows,
  labels,
  linkFor,
}: {
  rows: Readonly<Record<string, AnalyticsMetric>>
  labels: Record<string, string>
  linkFor: (metric: AnalyticsMetric, key: string) => string | null
}) {
  const entries = Object.entries(rows)
  const max = Math.max(1, ...entries.map(([, metric]) => metric.numerator))
  return (
    <div className="sa-bars" role="list" aria-label="Распределение sentiment">
      {entries.map(([key, metric]) => (
        (() => { const href = linkFor(metric, key); const content = <><span className="sa-bar-label">{labels[key] ?? key}</span><span className="sa-bar-track" aria-hidden="true"><span className="sa-bar-fill" style={{ width: `${Math.round(metric.numerator / max * 100)}%`, background: COLORS[key] ?? 'var(--accent)' }} /></span><span className="sa-bar-value">{metric.numerator.toLocaleString('ru-RU')} <small>{metric.rate == null ? '—' : `${(metric.rate * 100).toFixed(1)}%`}</small></span></>; return href ? <Link key={key} to={href} className="sa-bar-row" role="listitem">{content}</Link> : <div key={key} className="sa-bar-row sa-disabled-drilldown" role="listitem">{content}</div> })()
      ))}
    </div>
  )
}
