import { Link } from 'react-router-dom'
import type { AnalyticsMetric } from './MetricCard'

// The SQL bucket is mutually exclusive. Keep this order identical to its
// precedence: DNC first, then pending acknowledgement, then calendar/action
// buckets. Do not add a synthetic "unassigned" row: absent action is already
// represented by needs_confirmation in the server aggregate.
const ORDER = ['do_not_contact', 'needs_confirmation', 'overdue', 'follow_up_today', 'follow_up_later', 'needs_reply', 'awaiting_reply', 'resolved', 'closed_soft', 'closed_hard']
const LABELS: Record<string, string> = {
  needs_confirmation: 'Без подтверждённого шага', needs_reply: 'Нужен ответ', follow_up_today: 'Follow-up сегодня', overdue: 'Follow-up просрочен', follow_up_later: 'Follow-up позже', awaiting_reply: 'Ждём ответа', resolved: 'Завершено', closed_soft: 'Мягкий отказ', closed_hard: 'Окончательный отказ', do_not_contact: 'Не связываться',
}

export function WorkflowBuckets({ rows, linkFor }: { rows: Readonly<Record<string, AnalyticsMetric>>; linkFor: (metric: AnalyticsMetric, key: string) => string | null }) {
  // Transfers are event counts, not an exclusive current-state bucket. Keep
  // them out of the ordinary list even when the server includes the row in
  // the same workflow object, then render them separately below.
  const keys = [...new Set([...ORDER, ...Object.keys(rows)])].filter((key) => key !== 'transfers' && key !== 'transfer')
  return (
    <div className="sa-workflow-grid" role="list" aria-label="Текущее состояние работы">
      {keys.map((key) => {
        const metric = rows[key] ?? { numerator: 0, denominator: 0, rate: null }
        const href = linkFor(metric, key); const content = <><span>{LABELS[key] ?? key}</span><strong>{metric.numerator.toLocaleString('ru-RU')}</strong><small>{metric.rate == null ? '—' : `${(metric.rate * 100).toFixed(1)}%`}</small></>; return href ? <Link to={href} className="sa-workflow-item" key={key} role="listitem">{content}</Link> : <div className="sa-workflow-item sa-disabled-drilldown" key={key} role="listitem">{content}</div>
      })}
      {(rows.transfers || rows.transfer) && (() => { const transfer = rows.transfers ?? rows.transfer!; const href = linkFor(transfer, 'transfers'); const content = <><span>Передачи (события)</span><strong>{transfer.numerator.toLocaleString('ru-RU')}</strong><small>отдельно от статусов</small></>; return href ? <Link to={href} className="sa-workflow-item sa-workflow-transfer" role="listitem">{content}</Link> : <div className="sa-workflow-item sa-workflow-transfer sa-disabled-drilldown" role="listitem">{content}</div> })()}
    </div>
  )
}
