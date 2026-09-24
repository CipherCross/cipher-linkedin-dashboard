import { Link } from 'react-router-dom'
import { SA_DISABLED } from './classes'
import type { AnalyticsMetric } from './MetricCard'
import { Table, TableFrame } from '../../ui'
import { UI_LOCALE } from '../../ui/datetime'

export interface ComparisonTopReason { id: string; label?: string | null; numerator?: number }
export interface ComparisonRow extends AnalyticsMetric { kind: 'account' | 'campaign'; id: string; name?: string | null; coverage?: number | null; negative?: AnalyticsMetric; top_reasons?: readonly ComparisonTopReason[] }

const CAPTION = 'Accounts and campaigns compared'

export function ComparisonTable({ rows, labelFor, linkFor }: { rows: readonly ComparisonRow[]; labelFor: (row: ComparisonRow) => string; linkFor: (row: ComparisonRow) => string | null }) {
  return (
    <TableFrame scrollLabel={CAPTION}>
      <Table caption={CAPTION} className="min-w-[680px]">
        <thead>
          <tr>
            <th scope="col">Segment</th>
            <th scope="col" className="ui-table__num">Replied</th>
            <th scope="col" className="ui-table__num">Coverage</th>
            <th scope="col" className="ui-table__num">Declines / objections</th>
            <th scope="col" className="ui-table__num">Most common reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={5} className="text-app-text-muted">Not enough data to compare.</td></tr> : rows.map((row) => {
            const top = row.top_reasons?.[0]
            const href = linkFor(row)
            return (
              <tr key={`${row.kind}:${row.id}`}>
                <th scope="row" className="font-medium">{href ? <Link to={href} className="text-app-text no-underline hover:text-app-accent hover:underline">{labelFor(row)}</Link> : <span className={SA_DISABLED} title="Replies cannot filter this campaign precisely without a campaign_id">{labelFor(row)}</span>}</th>
                <td className="ui-table__num">{row.denominator.toLocaleString(UI_LOCALE)}</td>
                <td className="ui-table__num">{row.coverage == null ? 'Not reviewed' : `${(row.coverage * 100).toFixed(1)}%`}</td>
                <td className="ui-table__num" title={row.negative ? `${row.negative.numerator} of ${row.negative.denominator} conversations whose latest reply was reviewed by hand` : undefined}>{row.rate == null ? 'Not reviewed' : `${(row.rate * 100).toFixed(1)}%`}</td>
                <td className="ui-table__num">{top ? `${top.label ?? top.id}${top.numerator == null ? '' : ` · ${top.numerator}`}` : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </Table>
    </TableFrame>
  )
}
