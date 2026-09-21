import type { Totals } from '../../lib/leads'
import { num, pct } from '../../lib/format'

/**
 * The portfolio in one line.
 *
 * The full KPI cards, with their deltas and sparklines, now live under
 * Analytics; this strip exists so the operational top of the page still answers
 * "how are we doing overall" without scrolling. It shows the same numbers, so
 * it must keep reading the same `overview.summary` aggregate rather than
 * recomputing anything of its own.
 */
export function GlobalSummary({
  totals,
  intent,
  rangeLabel,
  accounts,
}: {
  totals: Totals
  /** Only the buying-intent count is shown here; the rates live in KPI cards. */
  intent: { p3: number } | undefined
  rangeLabel: string
  accounts: number
}) {
  const cells: Array<{ label: string; value: string; hint?: string }> = [
    { label: 'Leads', value: num(totals.leads) },
    { label: 'Invites', value: num(totals.invites) },
    // Same numerator/denominator pairing as the KPI cards and campaign_metrics:
    // the rate counts only leads that actually passed the previous milestone.
    {
      label: 'Accepted',
      value: num(totals.accepted),
      hint: pct(totals.acceptedOfInvited, totals.invites),
    },
    {
      label: 'Replies',
      value: num(totals.replies),
      hint: pct(totals.repliedOfConnected, totals.accepted),
    },
    { label: 'Buying intent', value: num(intent?.p3 ?? 0), hint: 'P3' },
  ]

  return (
    <section className="card flex flex-col gap-app-sm mb-app-lg" aria-label="Portfolio summary">
      <div className="muted small">
        {rangeLabel} · {accounts} {accounts === 1 ? 'account' : 'accounts'}
      </div>
      <dl className="flex flex-wrap gap-[14px] m-0 [&_dt]:text-[length:var(--text-2xs)] [&_dt]:uppercase [&_dt]:tracking-[.04em] [&_dt]:text-app-text-muted [&_dd]:m-0 [&_dd]:text-[length:var(--text-lg)] [&_dd]:font-[650] [&_dd]:tabular-nums">
        {cells.map((cell) => (
          <div key={cell.label}>
            <dt>{cell.label}</dt>
            <dd>
              {cell.value}
              {cell.hint && <span className="muted small"> {cell.hint}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
