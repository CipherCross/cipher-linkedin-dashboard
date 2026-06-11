import { Link } from 'react-router-dom'
import type { CampaignMetrics, Instance, Lead } from '../lib/types'
import type { DateRange } from '../lib/leads'
import { accountStats, instanceName, leadsToActivity, rangedCampaigns } from '../lib/leads'
import { ago } from './CampaignTable'
import { Avatar } from './Avatar'
import { Sparkline } from './Sparkline'

const STALE_HOURS = 24

/** One LinkedIn account on the Overview grid: identity + sync status, the
 *  range-scoped funnel stats, an invite-activity sparkline, and every campaign
 *  as a prominent link into its detail page. `leads` is this instance's subset. */
export function AccountCard({
  inst,
  leads,
  campaignsMeta,
  range,
}: {
  inst: Instance
  leads: Lead[]
  campaignsMeta: CampaignMetrics[]
  range: DateRange
}) {
  const last = inst.last_sync_at ? new Date(inst.last_sync_at).getTime() : 0
  const fresh = Date.now() - last < STALE_HOURS * 3_600_000
  const stats = accountStats(leads, range)
  const activity = leadsToActivity(leads).filter(
    (a) => (!range.from || a.day >= range.from) && (!range.to || a.day <= range.to),
  )
  const campaigns = rangedCampaigns(leads, campaignsMeta, range)

  return (
    <div className="card account-card">
      <div className="account-card-head">
        <Avatar inst={inst} size={38} />
        <div style={{ minWidth: 0 }}>
          <div className="account-cell">
            <span className={`dot inline ${fresh ? 'ok' : 'stale'}`} />
            <Link className="row-link account-card-name" to={`/account/${encodeURIComponent(inst.id)}`}>
              {instanceName(inst)}
            </Link>
            {inst.account_url && (
              <a className="li-link" href={inst.account_url} target="_blank"
                rel="noreferrer" title="Open LinkedIn profile">in</a>
            )}
          </div>
          <div className="muted small">
            {inst.last_sync_at ? `synced ${ago(inst.last_sync_at)}` : 'never synced'}
            {inst.agent_version && ` · agent v${inst.agent_version}`}
          </div>
        </div>
      </div>

      <div className="account-card-stats">
        <Stat value={stats.leads.toLocaleString('en-US')} label="leads" />
        <Stat value={stats.invites.toLocaleString('en-US')} label="invites" />
        <Stat value={stats.acceptPct} label="accept" />
        <Stat value={stats.replyPct} label="reply" />
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
              {c.total_leads.toLocaleString('en-US')} leads
              {' · '}{rate(c.acceptance_rate)} acc · {rate(c.reply_rate)} rep
              {c.last_activity_at && ` · ${ago(c.last_activity_at)}`}
            </span>
          </Link>
        ))}
        {campaigns.length === 0 && <div className="muted small">No campaigns synced.</div>}
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="account-stat">
      <div className="account-stat-value">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  )
}

const rate = (r: number | null) => (r == null ? '—' : r.toFixed(1) + '%')
