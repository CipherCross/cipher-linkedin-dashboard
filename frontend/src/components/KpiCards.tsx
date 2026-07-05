import { MessageSquare, Send, ThumbsUp, UserCheck, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CampaignMetrics, DailyActivity } from '../lib/types'
import type { DateRange, Totals } from '../lib/leads'
import { num, pct } from '../lib/format'
import { Sparkline } from './Sparkline'

interface Props {
  campaigns?: CampaignMetrics[]
  totals?: Totals
  /** Previous equal-length period, for the range-over-range delta chips. */
  prev?: Totals
  /** Per-day activity to drive each flow-metric sparkline (Overview only). */
  activity?: DailyActivity[]
  /** Sparkline span (matches the active range). */
  range?: DateRange
  flowLabel?: string
  /** When set, appends a "Positive" card (count + share of replies). */
  positive?: number
}

interface Card {
  key: string
  label: string
  value: number
  sub?: string
  icon: LucideIcon
  /** daily_activity event_type this metric maps to (drives the sparkline). */
  event?: string
  /** current / previous counts for the delta chip; omitted = no chip. */
  cur?: number
  prevCount?: number
  /** Replies lag invites, so their deltas are provisional — softened, not red/green. */
  maturing?: boolean
}

export function KpiCards({ campaigns = [], totals, prev, activity, range, flowLabel, positive }: Props) {
  const invites = totals ? totals.invites : sum(campaigns, (c) => c.invites_sent)
  const accepted = totals ? totals.accepted : sum(campaigns, (c) => c.accepted)
  const replies = totals ? totals.replies : sum(campaigns, (c) => c.replies)
  const leads = totals ? totals.leads : sum(campaigns, (c) => c.total_leads)
  const suffix = flowLabel ? ` · ${flowLabel}` : ''

  const cards: Card[] = [
    { key: 'leads', label: 'Leads in pipeline', value: leads, icon: Users },
    {
      key: 'invites', label: 'Invites sent' + suffix, value: invites, icon: Send,
      event: 'invite_sent', cur: invites, prevCount: prev?.invites,
    },
    {
      key: 'accepted', label: 'Accepted' + suffix, value: accepted, icon: UserCheck,
      sub: invites > 0 ? pct(accepted, invites) + ' acceptance' : undefined,
      event: 'invite_accepted',
      cur: accepted, prevCount: prev?.accepted,
    },
    {
      key: 'replies', label: 'Replies' + suffix, value: replies, icon: MessageSquare,
      sub: accepted > 0 ? pct(replies, accepted) + ' reply rate' : undefined,
      event: 'reply_received',
      cur: replies, prevCount: prev?.replies, maturing: true,
    },
  ]
  if (positive !== undefined)
    cards.push({
      key: 'positive', label: 'Positive' + suffix, value: positive, icon: ThumbsUp,
      sub: replies > 0 ? pct(positive, replies) + ' of replies' : undefined,
      cur: positive, prevCount: prev?.positive, maturing: true,
    })

  const showSpark = !!(activity && range)

  return (
    <div className="kpi-grid">
      {cards.map((c) => {
        const Icon = c.icon
        return (
          <div className="card kpi" key={c.key}>
            <div className="kpi-top">
              <span className="kpi-label"><Icon size={14} strokeWidth={2} /> {c.label}</span>
              {c.cur !== undefined && c.prevCount !== undefined && (
                <Delta cur={c.cur} prev={c.prevCount} maturing={c.maturing} />
              )}
            </div>
            <div className="kpi-value">{num(c.value)}</div>
            {c.sub && <div className="kpi-sub">{c.sub}</div>}
            {showSpark && c.event && (
              <div className="kpi-spark">
                <Sparkline
                  activity={activity!}
                  eventType={c.event}
                  from={range!.from}
                  to={range!.to}
                  height={28}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Range-over-range change chip. Green up / red down for volume metrics; a
 *  neutral "maturing" style for reply metrics whose recent counts are still
 *  arriving (per the cohort-lag guidance — a dip there isn't necessarily real). */
function Delta({ cur, prev, maturing }: { cur: number; prev: number; maturing?: boolean }) {
  if (prev === 0 && cur === 0) return null
  const isNew = prev === 0
  const dir = cur > prev ? 'up' : cur < prev ? 'down' : 'flat'
  const cls = maturing ? 'maturing' : dir
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'
  const change = isNew ? null : Math.abs(Math.round(((cur - prev) / prev) * 100))
  const title = maturing
    ? 'vs previous period — recent replies are still arriving, so this is provisional'
    : 'vs previous equal-length period'
  return (
    <span className={`kpi-delta ${cls}`} title={title}>
      {isNew ? 'New' : `${arrow} ${change}%`}
    </span>
  )
}

const sum = (xs: CampaignMetrics[], f: (c: CampaignMetrics) => number) =>
  xs.reduce((a, x) => a + (f(x) || 0), 0)
