import { Link } from 'react-router-dom'
import { MessageSquare, Send, ThumbsUp, UserCheck, UserPlus, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CampaignMetrics, DailyActivity, Lead } from '../lib/types'
import type { DateRange, Totals } from '../lib/leads'
import { rangeToParam } from '../lib/leads'
import { num, pct } from '../lib/format'
import { Sparkline } from './Sparkline'
import { LeadsVelocityChart } from './LeadsVelocityChart'

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
  /** Leads added within the range; renders a clickable "Leads added" card. */
  added?: number
  addedPrev?: number
  /** All leads (unfiltered by range); when set, renders a "Leads velocity"
   *  tile with a per-week trend line (Overview only). */
  velocityLeads?: Lead[]
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
  /** When set, the card becomes a router link to this path. */
  to?: string
}

export function KpiCards({ campaigns = [], totals, prev, activity, range, flowLabel, positive, added, addedPrev, velocityLeads }: Props) {
  const invites = totals ? totals.invites : sum(campaigns, (c) => c.invites_sent)
  const accepted = totals ? totals.accepted : sum(campaigns, (c) => c.accepted)
  const replies = totals ? totals.replies : sum(campaigns, (c) => c.replies)
  const leads = totals ? totals.leads : sum(campaigns, (c) => c.total_leads)
  // Rate numerators constrained to the prior milestone being present, matching the
  // campaign_metrics view (migrations 019/030) — otherwise manual-import/InMail leads
  // (connected without invite, replied without connect) push the rates past 100%.
  // The campaigns fallback has no constrained numerators; its counts stay approximate.
  const acceptedOfInvited = totals ? totals.acceptedOfInvited : accepted
  const repliedOfConnected = totals ? totals.repliedOfConnected : replies

  // The active range already sits in the page-header picker; repeating it inside
  // every label made them wrap to two lines. It appears once per tile at most,
  // in the quiet sub line of tiles that have no rate to show there. Lowercased
  // to match the sentence-fragment style of the other subs ("per week", …).
  const rangeSub = flowLabel?.toLowerCase()
  const cards: Card[] = [
    { key: 'leads', label: 'Leads in pipeline', value: leads, icon: Users, sub: 'all time' },
  ]
  if (added !== undefined)
    cards.push({
      key: 'added', label: 'Leads added', value: added, icon: UserPlus,
      sub: rangeSub, cur: added, prevCount: addedPrev,
      to: `/review?tab=leads-added${range ? `&range=${rangeToParam(range)}` : ''}`,
    })
  cards.push(
    {
      key: 'invites', label: 'Invites sent', value: invites, icon: Send,
      sub: rangeSub, event: 'invite_sent', cur: invites, prevCount: prev?.invites,
    },
    {
      key: 'accepted', label: 'Accepted', value: accepted, icon: UserCheck,
      sub: invites > 0 ? pct(acceptedOfInvited, invites) + ' acceptance' : rangeSub,
      event: 'invite_accepted',
      cur: accepted, prevCount: prev?.accepted,
    },
    {
      key: 'replies', label: 'Replies', value: replies, icon: MessageSquare,
      sub: accepted > 0 ? pct(repliedOfConnected, accepted) + ' reply rate' : rangeSub,
      event: 'reply_received',
      cur: replies, prevCount: prev?.replies, maturing: true,
    },
  )
  if (positive !== undefined)
    cards.push({
      key: 'positive', label: 'Positive', value: positive, icon: ThumbsUp,
      sub: replies > 0 ? pct(positive, replies) + ' of replies' : rangeSub,
      cur: positive, prevCount: prev?.positive, maturing: true,
    })

  const showSpark = !!(activity && range)

  return (
    <div className="kpi-grid">
      {cards.map((c) => {
        const Icon = c.icon
        const body = (
          <>
            <div className="kpi-top">
              <span className="kpi-label"><Icon size={14} strokeWidth={2} /> {c.label}</span>
              {c.cur !== undefined && c.prevCount !== undefined && (
                <Delta cur={c.cur} prev={c.prevCount} maturing={c.maturing} />
              )}
            </div>
            <div className="kpi-value">{num(c.value)}</div>
            {/* Sub + spark are always rendered (spacer when absent) so every
                tile shares one anatomy and the values align across the row. */}
            <div className="kpi-sub">{c.sub ?? ' '}</div>
            {showSpark && (
              <div className="kpi-spark">
                {c.event ? (
                  <Sparkline
                    activity={activity!}
                    eventType={c.event}
                    from={range!.from}
                    to={range!.to}
                    height={28}
                  />
                ) : (
                  <div className="kpi-spark-spacer" aria-hidden="true" />
                )}
              </div>
            )}
          </>
        )
        return c.to ? (
          <Link className="card kpi kpi-link" key={c.key} to={c.to}>{body}</Link>
        ) : (
          <div className="card kpi" key={c.key}>{body}</div>
        )
      })}
      {velocityLeads && range && <LeadsVelocityChart leads={velocityLeads} range={range} />}
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
  // Triple-digit percentages read as alarm rather than scale ("↑ 400%") —
  // switch to a multiplier once the change is at least 3× / a third.
  const text =
    isNew ? 'New'
    : change! >= 200 ? `${arrow} ×${(cur / prev).toFixed(1)}`
    : `${arrow} ${change}%`
  return (
    <span className={`kpi-delta ${cls}`} title={title}>
      {text}
    </span>
  )
}

const sum = (xs: CampaignMetrics[], f: (c: CampaignMetrics) => number) =>
  xs.reduce((a, x) => a + (f(x) || 0), 0)
