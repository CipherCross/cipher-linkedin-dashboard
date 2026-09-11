import { Link } from 'react-router-dom'
import type { AnalyticsMetric } from './MetricCard'

export interface ComparisonTopReason { id: string; label?: string | null; numerator?: number }
export interface ComparisonRow extends AnalyticsMetric { kind: 'account' | 'campaign'; id: string; name?: string | null; coverage?: number | null; top_reasons?: readonly ComparisonTopReason[] }

export function ComparisonTable({ rows, labelFor, linkFor }: { rows: readonly ComparisonRow[]; labelFor: (row: ComparisonRow) => string; linkFor: (row: ComparisonRow) => string | null }) {
  return (
    <div className="sa-table-wrap"><table className="sa-table"><caption className="sr-only">Сравнение аккаунтов и кампаний</caption><thead><tr><th>Разрез</th><th>Ответившие</th><th>Покрытие</th><th>Negative / objection</th><th>Причина №1</th></tr></thead><tbody>
      {rows.length === 0 ? <tr><td colSpan={5} className="muted">Недостаточно данных для сравнения.</td></tr> : rows.map((row) => { const top = row.top_reasons?.[0]; const href = linkFor(row); return <tr key={`${row.kind}:${row.id}`}><th scope="row">{href ? <Link to={href}>{labelFor(row)}</Link> : <span className="sa-disabled-drilldown" title="В Replies пока нельзя точно отфильтровать кампанию без campaign_id">{labelFor(row)}</span>}</th><td>{row.denominator.toLocaleString('ru-RU')}</td><td>{row.coverage == null ? '—' : `${(row.coverage * 100).toFixed(1)}%`}</td><td>{row.rate == null ? '—' : `${(row.rate * 100).toFixed(1)}%`}</td><td>{top ? `${top.label ?? top.id}${top.numerator == null ? '' : ` · ${top.numerator}`}` : '—'}</td></tr> })}
    </tbody></table></div>
  )
}
