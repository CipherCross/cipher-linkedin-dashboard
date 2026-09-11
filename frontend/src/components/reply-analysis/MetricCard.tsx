import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

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
}: {
  label: string
  metric?: AnalyticsMetric
  href: string | null
  hint?: ReactNode
  icon?: ReactNode
}) {
  const value = metric?.numerator ?? 0
  const content = <><div className="sa-metric-label">{icon}{label}</div><div className="sa-metric-value">{value.toLocaleString('ru-RU')}</div><div className="sa-metric-rate">{metricRate(metric)} <span>· {metric?.denominator?.toLocaleString('ru-RU') ?? 0} всего</span></div>{hint && <div className="sa-metric-hint">{hint}</div>}</>
  if (!href) return <div className="sa-metric-card sa-disabled-drilldown" aria-label={`${label}: ${value} из ${metric?.denominator ?? 0}`}>{content}</div>
  return (
    <Link className="sa-metric-card" to={href} aria-label={`${label}: ${value} из ${metric?.denominator ?? 0}`}>
      {content}
    </Link>
  )
}
