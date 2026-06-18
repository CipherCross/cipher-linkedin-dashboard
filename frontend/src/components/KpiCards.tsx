import type { CampaignMetrics } from '../lib/types'
import type { Totals } from '../lib/leads'

interface Props {
  campaigns?: CampaignMetrics[]
  totals?: Totals
  flowLabel?: string
  /** When set, appends a "Positive" card (count + share of replies). */
  positive?: number
}

interface Card {
  label: string
  value: string
  sub?: string
}

export function KpiCards({ campaigns = [], totals, flowLabel, positive }: Props) {
  const invites = totals ? totals.invites : sum(campaigns, (c) => c.invites_sent)
  const accepted = totals ? totals.accepted : sum(campaigns, (c) => c.accepted)
  const replies = totals ? totals.replies : sum(campaigns, (c) => c.replies)
  const leads = totals ? totals.leads : sum(campaigns, (c) => c.total_leads)
  const suffix = flowLabel ? ` · ${flowLabel}` : ''

  const cards: Card[] = [
    { label: 'Leads in pipeline', value: fmt(leads) },
    { label: 'Invites sent' + suffix, value: fmt(invites) },
    { label: 'Accepted' + suffix, value: fmt(accepted), sub: pct(accepted, invites) + ' acceptance' },
    { label: 'Replies' + suffix, value: fmt(replies), sub: pct(replies, accepted) + ' reply rate' },
  ]
  if (positive !== undefined)
    cards.push({ label: 'Positive' + suffix, value: fmt(positive), sub: pct(positive, replies) + ' of replies' })

  return (
    <div className="kpi-grid">
      {cards.map((c) => (
        <div className="card kpi" key={c.label}>
          <div className="kpi-label">{c.label}</div>
          <div className="kpi-value">{c.value}</div>
          {c.sub && <div className="kpi-sub">{c.sub}</div>}
        </div>
      ))}
    </div>
  )
}

const sum = (xs: CampaignMetrics[], f: (c: CampaignMetrics) => number) =>
  xs.reduce((a, x) => a + (f(x) || 0), 0)
const fmt = (n: number) => n.toLocaleString('en-US')
const pct = (a: number, b: number) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : '—')
