import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { UI_LOCALE } from '../../ui/datetime'

export interface AnalyticsMetric {
  numerator: number
  denominator: number
  rate: number | null
  drilldown?: { kind?: string; value?: string } | Record<string, unknown>
}

export function metricRate(metric: AnalyticsMetric | undefined): string {
  if (!metric || metric.rate == null || metric.denominator === 0) return '—'
  return `${(metric.rate * 100).toFixed(1)}%`
}

export function MetricCard({
  label,
  metric,
  href,
  hint,
  icon,
  showRate = true,
}: {
  label: string
  metric?: AnalyticsMetric
  href: string | null
  hint?: ReactNode
  icon?: ReactNode
  showRate?: boolean
}) {
  const value = metric?.numerator ?? 0
  const content = <><div className="sa-metric-label">{icon}{label}</div><div className="sa-metric-value">{value.toLocaleString(UI_LOCALE)}</div>{showRate && <div className="sa-metric-rate">{metricRate(metric)} <span>· {metric?.denominator?.toLocaleString(UI_LOCALE) ?? 0} total</span></div>}{hint && <div className="sa-metric-hint">{hint}</div>}</>
  if (!href || value === 0) return <div className="sa-metric-card sa-disabled-drilldown" aria-label={`${label}: ${value} of ${metric?.denominator ?? 0}`}>{content}</div>
  return (
    <Link className="sa-metric-card" to={href} aria-label={`${label}: ${value} of ${metric?.denominator ?? 0}`}>
      {content}
    </Link>
  )
}
