import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import type { CampaignMetrics, Lead } from '../lib/types'
import { daysBetween, instanceName, latestRepliesByLead, leadKey, leadsToActivity, segmentOf } from '../lib/leads'
import { KpiCards } from '../components/KpiCards'
import { Funnel } from '../components/Funnel'
import { CohortChart } from '../components/CohortChart'
import { LeadAdditionsChart } from '../components/LeadAdditionsChart'
import { AddBatchesTable } from '../components/AddBatchesTable'
import { LagHistogram } from '../components/LagHistogram'
import { ActivityChart } from '../components/ActivityChart'
import { CampaignCompareTable } from '../components/CampaignCompareTable'
import { RateVolumeScatter } from '../components/RateVolumeScatter'
import { MessageSequence } from '../components/MessageSequence'

export function CampaignDetail() {
  const { id } = useParams<{ id: string }>()
  const { data } = useData()

  const campaign = data?.campaigns.find((c) => c.campaign_id === id)
  const leads = useMemo(
    () => data?.leads.filter((l) => l.campaign_id === id) ?? [],
    [data, id],
  )
  // Positive replies for this campaign, from the latest inbound message per lead.
  const positive = useMemo(() => {
    if (!data) return 0
    const latest = latestRepliesByLead(data.messages)
    return leads.filter(
      (l) => latest.get(leadKey(l.instance_id, l.profile_url))?.sentiment === 'positive',
    ).length
  }, [data, leads])
  const [compareIds, setCompareIds] = useState<string[]>([])

  // The base campaign (route) plus any added ones, in selection order, deduped
  // against campaigns that may have disappeared from a refresh.
  const selected = useMemo(() => {
    if (!data || !id) return []
    const ids = [id, ...compareIds]
    return ids
      .map((cid) => data.campaigns.find((c) => c.campaign_id === cid))
      .filter((c): c is CampaignMetrics => !!c)
  }, [data, id, compareIds])

  const leadsFor = (cid: string) => data?.leads.filter((l) => l.campaign_id === cid) ?? []

  if (!data) return null
  if (!campaign) {
    return (
      <div className="card">
        Campaign not found. <Link to="/">Back to overview</Link>
      </div>
    )
  }

  const instanceLabel = instanceName(
    data.instances.find((i) => i.id === campaign.instance_id),
    campaign.instance_id,
  )

  return (
    <>
      <header>
        <div>
          <div className="breadcrumb muted small">
            <Link to="/">Overview</Link> / campaign
          </div>
          <h1>{campaign.campaign_name}</h1>
          <div className="muted small">
            <Link className="row-link muted" to={`/account/${encodeURIComponent(campaign.instance_id)}`}>
              {instanceLabel}
            </Link>
            {campaign.status ? ` · ${campaign.status}` : ''}
          </div>
        </div>
        <div className="controls">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) setCompareIds((ids) => [...ids, e.target.value])
            }}
          >
            <option value="">Compare with…</option>
            {data.campaigns
              .filter((c) => c.campaign_id !== campaign.campaign_id && !compareIds.includes(c.campaign_id))
              .map((c) => (
                <option key={c.campaign_id} value={c.campaign_id}>
                  {c.campaign_name}
                </option>
              ))}
          </select>
        </div>
      </header>

      {compareIds.length > 0 ? (
        <>
          <div className="cmp-chips">
            {selected.map((c) => (
              <span className="cmp-chip" key={c.campaign_id}>
                {c.campaign_name}
                {c.campaign_id === campaign.campaign_id ? (
                  <span className="cmp-chip-base"> · base</span>
                ) : (
                  <button
                    aria-label={`Remove ${c.campaign_name}`}
                    onClick={() => setCompareIds((ids) => ids.filter((x) => x !== c.campaign_id))}
                  >×</button>
                )}
              </span>
            ))}
          </div>

          <CampaignCompareTable campaigns={selected} instances={data.instances} />
          <RateVolumeScatter campaigns={selected} />

          <div className="compare-grid">
            {selected.map((c) => (
              <CampaignColumn key={c.campaign_id} campaign={c} leads={leadsFor(c.campaign_id)} />
            ))}
          </div>
        </>
      ) : (
        <>
          <KpiCards campaigns={[campaign]} positive={positive} />

          <div className="two-col">
            <Funnel leads={leads} />
            <CohortChart leads={leads} />
          </div>

          <div className="stack">
            <LeadAdditionsChart leads={leads} granularity="day" />
            <AddBatchesTable leads={leads} />
          </div>

          <div className="stack">
            <MessageSequence
              steps={data.steps.filter((s) => s.campaign_id === campaign.campaign_id)}
            />
          </div>

          <div className="two-col">
            <LagHistogram
              title="Time from invite to accept"
              color="#34c98e"
              lags={lagList(leads, 'invited_at', 'connected_at')}
            />
            <LagHistogram
              title="Time from accept to reply"
              color="#f7b94f"
              lags={lagList(leads, 'connected_at', 'replied_at')}
            />
          </div>

          <div className="stack">
            <ActivityChart
              activity={leadsToActivity(leads)}
              title="Campaign activity over time"
              annotations={data.annotations.filter(
                (a) => !a.campaign_id || a.campaign_id === campaign.campaign_id,
              )}
            />
          </div>

          <div className="two-col">
            <SegmentTable leads={leads} />
            <CompanyTable leads={leads} />
          </div>
        </>
      )}
    </>
  )
}

function CampaignColumn({ campaign, leads }: { campaign: CampaignMetrics; leads: Lead[] }) {
  return (
    <div className="stack">
      <div className="card">
        <h2>
          <Link className="row-link" to={`/campaign/${encodeURIComponent(campaign.campaign_id)}`}>
            {campaign.campaign_name}
          </Link>
        </h2>
        <div className="muted small">
          {campaign.invites_sent} invites · {campaign.accepted} accepted (
          {campaign.acceptance_rate ?? '—'}%) · {campaign.replies} replies (
          {campaign.reply_rate ?? '—'}%)
        </div>
      </div>
      <Funnel leads={leads} />
      <CohortChart leads={leads} weeks={12} />
      <LeadAdditionsChart leads={leads} weeks={12} />
    </div>
  )
}

function lagList(leads: Lead[], from: keyof Lead, to: keyof Lead): number[] {
  const out: number[] = []
  for (const l of leads) {
    const d = daysBetween(l[from] as string | null, l[to] as string | null)
    if (d != null) out.push(d)
  }
  return out
}

function SegmentTable({ leads }: { leads: Lead[] }) {
  const rows = new Map<string, { leads: number; invited: number; accepted: number; replied: number }>()
  for (const l of leads) {
    const seg = segmentOf(l.headline)
    const r = rows.get(seg) ?? { leads: 0, invited: 0, accepted: 0, replied: 0 }
    r.leads += 1
    if (l.invited_at) r.invited += 1
    if (l.connected_at) r.accepted += 1
    if (l.replied_at) r.replied += 1
    rows.set(seg, r)
  }
  const sorted = [...rows.entries()].sort((a, b) => b[1].leads - a[1].leads)

  return (
    <div className="card">
      <h2>Performance by audience segment (from headline)</h2>
      <table>
        <thead>
          <tr>
            <th>Segment</th>
            <th className="num">Leads</th>
            <th className="num">Accepted</th>
            <th className="num">Accept %</th>
            <th className="num">Replied</th>
            <th className="num">Reply %</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(([seg, r]) => (
            <tr key={seg}>
              <td>{seg}</td>
              <td className="num">{r.leads}</td>
              <td className="num">{r.accepted}</td>
              <td className="num">{pct(r.accepted, r.invited)}</td>
              <td className="num">{r.replied}</td>
              <td className="num">{pct(r.replied, r.accepted)}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr><td colSpan={6} className="muted">No leads yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function CompanyTable({ leads }: { leads: Lead[] }) {
  const rows = new Map<string, { leads: number; accepted: number; replied: number }>()
  for (const l of leads) {
    if (!l.company) continue
    const r = rows.get(l.company) ?? { leads: 0, accepted: 0, replied: 0 }
    r.leads += 1
    if (l.connected_at) r.accepted += 1
    if (l.replied_at) r.replied += 1
    rows.set(l.company, r)
  }
  const top = [...rows.entries()].sort((a, b) => b[1].leads - a[1].leads).slice(0, 10)

  return (
    <div className="card">
      <h2>Top companies</h2>
      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th className="num">Leads</th>
            <th className="num">Accepted</th>
            <th className="num">Replied</th>
          </tr>
        </thead>
        <tbody>
          {top.map(([name, r]) => (
            <tr key={name}>
              <td>{name}</td>
              <td className="num">{r.leads}</td>
              <td className="num">{r.accepted}</td>
              <td className="num">{r.replied}</td>
            </tr>
          ))}
          {top.length === 0 && (
            <tr><td colSpan={4} className="muted">No company data synced.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

const pct = (a: number, b: number) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : '—')
