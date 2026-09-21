import { memo, useMemo } from 'react'
import { Link } from 'react-router-dom'
import type {
  CampaignMetrics, DailyActivity, Instance, Lead, OverviewAccountSummary,
} from '../lib/types'
import type { DateRange, ReplyIntentMetrics } from '../lib/leads'
import type { ReplyInfo } from '../lib/leads'
import {
  WEEKLY_ADD_LIMIT, accountStats, instanceName, leadsToActivity, rangedCampaigns, weeklyAdded,
} from '../lib/leads'
import { ago, num, rate } from '../lib/format'
import { Avatar } from './Avatar'
import { Sparkline } from './Sparkline'

const STALE_HOURS = 24

/** One LinkedIn account on the Overview grid: identity + sync status, the
 *  range-scoped funnel stats, an invite-activity sparkline, and every campaign
 *  as a prominent link into its detail page. `leads` is this instance's subset. */
export const AccountCard = memo(function AccountCard({
  inst,
  leads,
  campaignsMeta,
  range,
  latest,
  intent,
  summary,
  summaryActivity,
  summaryCampaigns,
}: {
  inst: Instance
  leads?: Lead[]
  campaignsMeta: CampaignMetrics[]
  range: DateRange
  latest?: Map<string, ReplyInfo>
  intent?: ReplyIntentMetrics
  summary?: OverviewAccountSummary
  summaryActivity?: DailyActivity[]
  summaryCampaigns?: CampaignMetrics[]
}) {
  const last = inst.last_sync_at ? new Date(inst.last_sync_at).getTime() : 0
  const fresh = Date.now() - last < STALE_HOURS * 3_600_000
  // Each derivation is memoized on just the inputs it uses, so a re-render that
  // changes only one prop (e.g. range) doesn't recompute the rest — and React.memo
  // skips the whole card when Overview re-renders with the same props.
  const stats = useMemo(() => {
    if (summary) {
      const t = summary.totals
      const percent = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : '—')
      return {
        ...t,
        acceptPct: percent(t.acceptedOfInvited, t.invites),
        replyPct: percent(t.repliedOfConnected, t.accepted),
      }
    }
    return accountStats(leads ?? [], range, latest)
  }, [leads, range, latest, summary])
  const activity = useMemo(
    () => summaryActivity ??
      leadsToActivity(leads ?? []).filter(
        (a) => (!range.from || a.day >= range.from) && (!range.to || a.day <= range.to),
      ),
    [leads, range, summaryActivity],
  )
  const campaigns = useMemo(
    () => summaryCampaigns ?? rangedCampaigns(leads ?? [], campaignsMeta, range),
    [leads, campaignsMeta, range, summaryCampaigns],
  )
  const weekAdded = useMemo(
    () => summary?.weeklyAdded ?? weeklyAdded(leads ?? [], inst.id),
    [leads, inst.id, summary],
  )
  const addedFrac = weekAdded / WEEKLY_ADD_LIMIT
  const capTone = addedFrac >= 1 ? 'danger' : addedFrac >= 0.7 ? 'warning' : 'success'

  return (
    <div className="card flex flex-col gap-app-lg">
      <div className="flex gap-2.5 items-center">
        <Link
          className="group flex gap-app-md items-center flex-1 min-w-0 no-underline row-link"
          to={`/account/${encodeURIComponent(inst.id)}`}
        >
          <Avatar inst={inst} size={38} />
          <div style={{ minWidth: 0 }}>
            <div className="flex items-center gap-app-sm">
              <span className={`dot inline ${fresh ? 'ok' : 'stale'}`} />
              <span className="text-[length:var(--text-lg)] font-semibold text-app-text transition-colors group-hover:text-app-accent">{instanceName(inst)}</span>
            </div>
            <div className="muted small">
              {inst.last_sync_at ? `synced ${ago(inst.last_sync_at)}` : 'never synced'}
              {inst.agent_version && ` · agent v${inst.agent_version}`}
            </div>
          </div>
        </Link>
        {inst.account_url && (
          <a className="li-link" href={inst.account_url} target="_blank"
            rel="noreferrer" title="Open LinkedIn profile">in</a>
        )}
      </div>

      <div className="grid grid-cols-5 gap-app-sm py-2.5 border-y border-app-border">
        <Stat value={num(stats.leads)} label="leads" />
        <Stat value={num(stats.invites)} label="invites" />
        <Stat value={stats.acceptPct} label="accept" />
        <Stat value={stats.replyPct} label="reply" />
        <Stat value={num(intent?.p3 ?? 0)} label="P3 intent" />
      </div>

      <div
        className="flex items-center gap-2.5 -mt-1"
        title={`${weekAdded} of ${WEEKLY_ADD_LIMIT} weekly add limit used this week (Mon–Sun)`}
      >
        <span className="muted small">weekly cap</span>
        <div className="flex-1 h-1.5 rounded-[3px] overflow-hidden" style={{ background: `var(--${capTone}-subtle)` }}>
          <div
            className="h-full rounded-[3px] transition-[width]"
            style={{
              width: `${Math.min(100, addedFrac * 100)}%`,
              background: `var(--${capTone})`,
            }}
          />
        </div>
        <span className="small font-semibold tabular-nums">
          {num(weekAdded)}/{WEEKLY_ADD_LIMIT}
        </span>
      </div>

      <div className="flex items-end gap-2.5">
        <Sparkline activity={activity} from={range.from} to={range.to} />
        <span className="muted small">invites · {range.label.toLowerCase()}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="uppercase tracking-[var(--tracking-caps)] text-[length:var(--text-2xs)] muted small">Campaigns</div>
        {campaigns.map((c) => (
          <Link
            key={c.campaign_id}
            className="flex flex-col gap-0.5 px-2.5 py-app-sm border border-app-border rounded-md no-underline text-app-text bg-app-bg transition-[border-color] hover:border-app-accent"
            to={`/campaign/${encodeURIComponent(c.campaign_id)}`}
          >
            <span className="text-app-accent font-semibold">▸ {c.campaign_name}</span>
            <span className="muted small">
              {num(c.total_leads)} leads
              {(c.leads_added ?? 0) > 0 && ` · +${num(c.leads_added!)} added`}
              {' · '}{rate(c.acceptance_rate)} acc · {rate(c.reply_rate)} rep
              {c.last_activity_at && ` · ${ago(c.last_activity_at)}`}
            </span>
          </Link>
        ))}
        {campaigns.length === 0 && <div className="muted small">No campaigns synced.</div>}
      </div>
    </div>
  )
})

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="grid grid-rows-[1fr_auto] text-center">
      <div className="text-[length:var(--text-lg)] font-semibold tabular-nums self-end">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  )
}
