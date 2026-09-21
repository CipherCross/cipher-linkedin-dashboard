import { Link } from 'react-router-dom'
import { SA_DISABLED } from './classes'
import type { AnalyticsMetric } from './MetricCard'
import { UI_LOCALE } from '../../ui/datetime'

// The SQL bucket is mutually exclusive. Keep this order identical to its
// precedence: DNC first, then pending acknowledgement, then calendar/action
// buckets. Do not add a synthetic "unassigned" row: absent action is already
// represented by needs_confirmation in the server aggregate.
const ORDER = ['do_not_contact', 'needs_confirmation', 'overdue', 'follow_up_today', 'follow_up_later', 'needs_reply', 'awaiting_reply', 'resolved', 'closed_soft', 'closed_hard']
export const WORKFLOW_LABELS: Record<string, string> = {
  needs_confirmation: 'No next step confirmed', needs_reply: 'Needs reply', follow_up_today: 'Follow-up today', overdue: 'Follow-up overdue', follow_up_later: 'Follow-up later', awaiting_reply: 'Awaiting reply', resolved: 'Completed', closed_soft: 'Soft decline', closed_hard: 'Hard decline', do_not_contact: 'Do not contact',
}

export function WorkflowBuckets({ rows, linkFor, showZero = true }: { rows: Readonly<Record<string, AnalyticsMetric>>; linkFor: (metric: AnalyticsMetric, key: string) => string | null; showZero?: boolean }) {
  // Transfers are event counts, not an exclusive current-state bucket. Keep
  // them out of the ordinary list even when the server includes the row in
  // the same workflow object, then render them separately below.
  const keys = [...new Set([...ORDER, ...Object.keys(rows)])].filter((key) => key !== 'transfers' && key !== 'transfer' && (showZero || (rows[key]?.numerator ?? 0) > 0))
  return (
    <div className="grid gap-app-md grid-cols-[repeat(auto-fit,minmax(260px,1fr))]" role="list" aria-label="Current state of work">
      {keys.length === 0 && <p className="muted">No open next steps.</p>}
      {keys.map((key) => {
        const metric = rows[key] ?? { numerator: 0, denominator: 0, rate: null }
        const href = linkFor(metric, key); const content = <><span>{WORKFLOW_LABELS[key] ?? key}</span><strong>{metric.numerator.toLocaleString(UI_LOCALE)}</strong><small>{metric.rate == null ? '—' : `${(metric.rate * 100).toFixed(1)}%`}</small></>; return href ? <Link to={href} className="grid items-center gap-x-app-md gap-y-0.5 grid-cols-[1fr_auto] min-h-row px-app-lg py-app-md border border-app-border rounded-control bg-app-surface text-app-text no-underline [a&:hover]:border-app-accent [a&:hover]:bg-app-surface-2 [&_span]:min-w-0 [&_span]:text-app-table [&_strong]:text-app-section [&_strong]:tabular-nums [&_small]:col-span-full [&_small]:text-app-text-muted [&_small]:text-app-meta" key={key} role="listitem">{content}</Link> : <div className={`${SA_DISABLED} grid items-center gap-x-app-md gap-y-0.5 grid-cols-[1fr_auto] min-h-row px-app-lg py-app-md border border-app-border rounded-control bg-app-surface text-app-text no-underline [a&:hover]:border-app-accent [a&:hover]:bg-app-surface-2 [&_span]:min-w-0 [&_span]:text-app-table [&_strong]:text-app-section [&_strong]:tabular-nums [&_small]:col-span-full [&_small]:text-app-text-muted [&_small]:text-app-meta`} key={key} role="listitem">{content}</div>
      })}
      {(rows.transfers || rows.transfer) && (showZero || (rows.transfers ?? rows.transfer)!.numerator > 0) && (() => { const transfer = rows.transfers ?? rows.transfer!; const href = linkFor(transfer, 'transfers'); const content = <><span>Handovers (events)</span><strong>{transfer.numerator.toLocaleString(UI_LOCALE)}</strong><small>counted separately from statuses</small></>; return href ? <Link to={href} className="grid items-center gap-x-app-md gap-y-0.5 grid-cols-[1fr_auto] min-h-row px-app-lg py-app-md border border-app-border rounded-control bg-app-surface text-app-text no-underline [a&:hover]:border-app-accent [a&:hover]:bg-app-surface-2 [&_span]:min-w-0 [&_span]:text-app-table [&_strong]:text-app-section [&_strong]:tabular-nums [&_small]:col-span-full [&_small]:text-app-text-muted [&_small]:text-app-meta border-dashed" role="listitem">{content}</Link> : <div className={`${SA_DISABLED} grid items-center gap-x-app-md gap-y-0.5 grid-cols-[1fr_auto] min-h-row px-app-lg py-app-md border border-app-border rounded-control bg-app-surface text-app-text no-underline [a&:hover]:border-app-accent [a&:hover]:bg-app-surface-2 [&_span]:min-w-0 [&_span]:text-app-table [&_strong]:text-app-section [&_strong]:tabular-nums [&_small]:col-span-full [&_small]:text-app-text-muted [&_small]:text-app-meta border-dashed`} role="listitem">{content}</div> })()}
    </div>
  )
}
