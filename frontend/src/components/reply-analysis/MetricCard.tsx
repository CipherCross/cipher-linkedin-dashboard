import type { ReactNode } from 'react'
import { SA_DISABLED } from './classes'
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
  const content = <><div className="flex items-center gap-app-xs text-app-text-muted text-app-meta">{icon}{label}</div><div className="mt-app-sm text-app-kpi font-semibold tabular-nums">{value.toLocaleString(UI_LOCALE)}</div>{showRate && <div className="mt-0.5 text-app-accent text-app-table tabular-nums [&_span]:text-app-text-muted">{metricRate(metric)} <span>· {metric?.denominator?.toLocaleString(UI_LOCALE) ?? 0} total</span></div>}{hint && <div className="mt-app-xs text-app-meta text-app-text-muted">{hint}</div>}</>
  if (!href || value === 0) return <div className={`${SA_DISABLED} block min-w-0 p-app-lg border border-app-border rounded-card bg-app-surface text-app-text no-underline [a&:hover]:border-app-accent`} aria-label={`${label}: ${value} of ${metric?.denominator ?? 0}`}>{content}</div>
  return (
    <Link className="block min-w-0 p-app-lg border border-app-border rounded-card bg-app-surface text-app-text no-underline [a&:hover]:border-app-accent" to={href} aria-label={`${label}: ${value} of ${metric?.denominator ?? 0}`}>
      {content}
    </Link>
  )
}
