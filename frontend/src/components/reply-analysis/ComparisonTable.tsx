import { Link } from 'react-router-dom'
import type { AnalyticsMetric } from './MetricCard'
import { UI_LOCALE } from '../../ui/datetime'

export interface ComparisonTopReason { id: string; label?: string | null; numerator?: number }
export interface ComparisonRow extends AnalyticsMetric { kind: 'account' | 'campaign'; id: string; name?: string | null; coverage?: number | null; negative?: AnalyticsMetric; top_reasons?: readonly ComparisonTopReason[] }

export function ComparisonTable({ rows, labelFor, linkFor }: { rows: readonly ComparisonRow[]; labelFor: (row: ComparisonRow) => string; linkFor: (row: ComparisonRow) => string | null }) {
  return (
    <div className="sa-table-wrap"><table className="sa-table"><caption className="sr-only">Accounts and campaigns compared</caption><thead><tr><th scope="col">Segment</th><th scope="col">Replied</th><th scope="col">Coverage</th><th scope="col">Declines / objections</th><th scope="col">Most common reason</th></tr></thead><tbody>
      {rows.length === 0 ? <tr><td colSpan={5} className="muted">Not enough data to compare.</td></tr> : rows.map((row) => { const top = row.top_reasons?.[0]; const href = linkFor(row); return <tr key={`${row.kind}:${row.id}`}><th scope="row">{href ? <Link to={href}>{labelFor(row)}</Link> : <span className="sa-disabled-drilldown" title="Replies cannot filter this campaign precisely without a campaign_id">{labelFor(row)}</span>}</th><td>{row.denominator.toLocaleString(UI_LOCALE)}</td><td>{row.coverage == null ? 'Not reviewed' : `${(row.coverage * 100).toFixed(1)}%`}</td><td title={row.negative ? `${row.negative.numerator} of ${row.negative.denominator} conversations whose latest reply was reviewed by hand` : undefined}>{row.rate == null ? 'Not reviewed' : `${(row.rate * 100).toFixed(1)}%`}</td><td>{top ? `${top.label ?? top.id}${top.numerator == null ? '' : ` · ${top.numerator}`}` : '—'}</td></tr> })}
    </tbody></table></div>
  )
}
