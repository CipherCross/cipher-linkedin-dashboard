import { memo, useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { CampaignMetrics, Instance, Lead } from '../lib/types'
import type { DateRange } from '../lib/leads'
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
}: {
  inst: Instance
  leads: Lead[]
  campaignsMeta: CampaignMetrics[]
  range: DateRange
  latest?: Map<string, ReplyInfo>
}) {
  const last = inst.last_sync_at ? new Date(inst.last_sync_at).getTime() : 0
  const fresh = Date.now() - last < STALE_HOURS * 3_600_000
  // Each derivation is memoized on just the inputs it uses, so a re-render that
  // changes only one prop (e.g. range) doesn't recompute the rest — and React.memo
  // skips the whole card when Overview re-renders with the same props.
  const stats = useMemo(() => accountStats(leads, range, latest), [leads, range, latest])
  const activity = useMemo(
    () =>
      leadsToActivity(leads).filter(
        (a) => (!range.from || a.day >= range.from) && (!range.to || a.day <= range.to),
      ),
    [leads, range],
  )
  const campaigns = useMemo(
    () => rangedCampaigns(leads, campaignsMeta, range),
    [leads, campaignsMeta, range],
  )
  const weekAdded = useMemo(() => weeklyAdded(leads, inst.id), [leads, inst.id])
  const addedFrac = weekAdded / WEEKLY_ADD_LIMIT
  const capTone = addedFrac >= 1 ? 'danger' : addedFrac >= 0.7 ? 'warning' : 'success'

  return (
    <div className="card account-card">
      <div className="account-card-head">
        <Link
          className="account-card-identity row-link"
          to={`/account/${encodeURIComponent(inst.id)}`}
        >
          <Avatar inst={inst} size={38} />
          <div style={{ minWidth: 0 }}>
            <div className="account-cell">
              <span className={`dot inline ${fresh ? 'ok' : 'stale'}`} />
              <span className="account-card-name">{instanceName(inst)}</span>
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

      <div className="account-card-stats">
        <Stat value={num(stats.leads)} label="leads" />
        <Stat value={num(stats.invites)} label="invites" />
        <Stat value={stats.acceptPct} label="accept" />
        <Stat value={stats.replyPct} label="reply" />
        <Stat value={num(stats.positive)} label="positive" />
      </div>

      <div
        className="account-card-cap"
        title={`${weekAdded} of ${WEEKLY_ADD_LIMIT} weekly add limit used this week (Mon–Sun)`}
      >
        <span className="muted small">weekly cap</span>
        <div className="account-cap-track" style={{ background: `var(--${capTone}-subtle)` }}>
          <div
            className="account-cap-fill"
            style={{
              width: `${Math.min(100, addedFrac * 100)}%`,
              background: `var(--${capTone})`,
            }}
          />
        </div>
        <span className="small account-cap-value">
          {num(weekAdded)}/{WEEKLY_ADD_LIMIT}
        </span>
      </div>

      <div className="account-card-spark">
        <Sparkline activity={activity} from={range.from} to={range.to} />
        <span className="muted small">invites · {range.label.toLowerCase()}</span>
      </div>

      <div className="account-card-campaigns">
        <div className="account-card-section muted small">Campaigns</div>
        {campaigns.map((c) => (
          <Link
            key={c.campaign_id}
            className="account-campaign-link"
            to={`/campaign/${encodeURIComponent(c.campaign_id)}`}
          >
            <span className="account-campaign-name">▸ {c.campaign_name}</span>
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
    <div className="account-stat">
      <div className="account-stat-value">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  )
}
