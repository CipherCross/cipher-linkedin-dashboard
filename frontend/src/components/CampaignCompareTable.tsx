import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CampaignMetrics, Instance } from '../lib/types'
import { instanceName } from '../lib/leads'

/** Fewer leads than this and the rates are too noisy to trust. */
const SMALL_SAMPLE = 30

type SortKey =
  | 'campaign_name' | 'total_leads' | 'invites_sent' | 'accepted'
  | 'acceptance_rate' | 'replies' | 'reply_rate'

const accessor: Record<SortKey, (c: CampaignMetrics) => number | string> = {
  campaign_name: (c) => c.campaign_name.toLowerCase(),
  total_leads: (c) => c.total_leads,
  invites_sent: (c) => c.invites_sent,
  accepted: (c) => c.accepted,
  acceptance_rate: (c) => c.acceptance_rate ?? -1,
  replies: (c) => c.replies,
  reply_rate: (c) => c.reply_rate ?? -1,
}

export function CampaignCompareTable({
  campaigns, instances,
}: { campaigns: CampaignMetrics[]; instances: Instance[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('reply_rate')
  const [sortAsc, setSortAsc] = useState(false)

  const maxAccept = Math.max(1, ...campaigns.map((c) => c.acceptance_rate ?? 0))
  const maxReply = Math.max(1, ...campaigns.map((c) => c.reply_rate ?? 0))

  const rows = useMemo(() => {
    const get = accessor[sortKey]
    return [...campaigns].sort((a, b) => {
      const av = get(a)
      const bv = get(b)
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
      return sortAsc ? cmp : -cmp
    })
  }, [campaigns, sortKey, sortAsc])

  const avg = useMemo(() => {
    const n = campaigns.length || 1
    const mean = (f: (c: CampaignMetrics) => number) =>
      campaigns.reduce((s, c) => s + f(c), 0) / n
    return {
      leads: mean((c) => c.total_leads),
      invites: mean((c) => c.invites_sent),
      accepted: mean((c) => c.accepted),
      accept: weightedRate(campaigns, (c) => c.accepted, (c) => c.invites_sent),
      replies: mean((c) => c.replies),
      reply: weightedRate(campaigns, (c) => c.replies, (c) => c.accepted),
    }
  }, [campaigns])

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(!sortAsc)
    else {
      setSortKey(key)
      setSortAsc(key === 'campaign_name')
    }
  }
  const arrow = (key: SortKey) => (key === sortKey ? (sortAsc ? ' ↑' : ' ↓') : '')
  const head = (key: SortKey, label: string, cls = '') => (
    <th className={`sortable ${cls}`} onClick={() => onSort(key)}>{label}{arrow(key)}</th>
  )

  return (
    <div className="card">
      <h2>Campaign comparison</h2>
      <table>
        <thead>
          <tr>
            {head('campaign_name', 'Campaign')}
            <th>Account</th>
            {head('total_leads', 'Leads', 'num')}
            {head('invites_sent', 'Invites', 'num')}
            {head('accepted', 'Accepted', 'num')}
            {head('acceptance_rate', 'Accept %', 'num')}
            {head('replies', 'Replies', 'num')}
            {head('reply_rate', 'Reply %', 'num')}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const small = c.total_leads < SMALL_SAMPLE
            return (
              <tr key={c.campaign_id}>
                <td>
                  <Link className="row-link" to={`/campaign/${encodeURIComponent(c.campaign_id)}`}>
                    {c.campaign_name}
                  </Link>
                  {small && (
                    <span className="cmp-warn" title={`Only ${c.total_leads} leads — rates are unreliable`}> ⚠</span>
                  )}
                </td>
                <td className="muted">{instanceName(instances.find((i) => i.id === c.instance_id), c.instance_id)}</td>
                <td className="num">{c.total_leads.toLocaleString('en-US')}</td>
                <td className="num">{c.invites_sent.toLocaleString('en-US')}</td>
                <td className="num">{c.accepted.toLocaleString('en-US')}</td>
                <td className="num">{rateCell(c.acceptance_rate, maxAccept, '#34c98e')}</td>
                <td className="num">{c.replies.toLocaleString('en-US')}</td>
                <td className="num">{rateCell(c.reply_rate, maxReply, '#f7b94f')}</td>
              </tr>
            )
          })}
        </tbody>
        {campaigns.length > 1 && (
          <tfoot>
            <tr className="cmp-avg">
              <td>Average</td>
              <td />
              <td className="num">{Math.round(avg.leads).toLocaleString('en-US')}</td>
              <td className="num">{Math.round(avg.invites).toLocaleString('en-US')}</td>
              <td className="num">{Math.round(avg.accepted).toLocaleString('en-US')}</td>
              <td className="num">{fmtRate(avg.accept)}</td>
              <td className="num">{Math.round(avg.replies).toLocaleString('en-US')}</td>
              <td className="num">{fmtRate(avg.reply)}</td>
            </tr>
          </tfoot>
        )}
      </table>
      <div className="muted small">
        ⚠ = under {SMALL_SAMPLE} leads, rate is noisy. Averages are
        pooled (totals ÷ totals), not a mean of the per-campaign rates.
      </div>
    </div>
  )
}

function rateCell(rate: number | null, max: number, color: string) {
  if (rate == null) return <span className="muted">—</span>
  return (
    <div className="cmp-rate">
      <span className="cmp-rate-val">{rate.toFixed(1)}%</span>
      <div className="cmp-bar">
        <span style={{ width: `${Math.min(100, (100 * rate) / max)}%`, background: color }} />
      </div>
    </div>
  )
}

/** Pooled rate across campaigns: Σnum ÷ Σden (so big campaigns dominate, which
 *  is the honest team-wide figure). */
function weightedRate(
  cs: CampaignMetrics[], num: (c: CampaignMetrics) => number, den: (c: CampaignMetrics) => number,
): number | null {
  const d = cs.reduce((s, c) => s + den(c), 0)
  return d > 0 ? (100 * cs.reduce((s, c) => s + num(c), 0)) / d : null
}

const fmtRate = (r: number | null) => (r == null ? '—' : r.toFixed(1) + '%')
