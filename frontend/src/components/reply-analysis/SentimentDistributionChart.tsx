import { Link } from 'react-router-dom'
import { SA_ROW, SA_TRACK, SA_FILL, SA_DISABLED } from './classes'
import type { AnalyticsMetric } from './MetricCard'
import { SENTIMENT_SERIES } from '../chartTheme'
import { UI_LOCALE } from '../../ui/datetime'

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
    <div className="flex flex-col gap-app-sm" role="list" aria-label="Sentiment distribution">
      {entries.map(([key, metric]) => (
        (() => { const href = linkFor(metric, key); const content = <><span className="min-w-0 text-app-table">{labels[key] ?? key}</span><span className={`${SA_TRACK}`} aria-hidden="true"><span className={`${SA_FILL}`} style={{ width: `${Math.round(metric.numerator / max * 100)}%`, background: SENTIMENT_SERIES[key] ?? 'var(--accent)' }} /></span><span className="text-app-table tabular-nums text-right whitespace-nowrap [&_small]:inline-block [&_small]:min-w-[52px] [&_small]:text-app-text-muted [&_small]:text-app-meta [&_small]:text-right">{metric.numerator.toLocaleString(UI_LOCALE)} <small>{metric.rate == null ? '—' : `${(metric.rate * 100).toFixed(1)}%`}</small></span></>; return href ? <Link key={key} to={href} className={`${SA_ROW} grid-cols-[minmax(150px,.8fr)_minmax(90px,1fr)_auto]`} role="listitem">{content}</Link> : <div key={key} className={`${SA_ROW} ${SA_DISABLED} grid-cols-[minmax(150px,.8fr)_minmax(90px,1fr)_auto]`} role="listitem">{content}</div> })()
      ))}
    </div>
  )
}
