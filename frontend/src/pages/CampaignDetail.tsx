import { useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { FileQuestion } from 'lucide-react'
import { useData } from '../lib/DataContext'
import type { CampaignMetrics, Lead } from '../lib/types'
import {
  daysBetween, instanceName, latestRepliesByLead, leadsToActivity,
  presetRanges, previousRange, rangeFromParam, rangeTotals, rangeToParam,
} from '../lib/leads'
import type { DateRange } from '../lib/leads'
import { num, rate } from '../lib/format'
import { DateRangePicker } from '../components/DateRangePicker'
import { EmptyState } from '../components/EmptyState'
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
  const [params, setParams] = useSearchParams()

  const RANGES = useMemo(() => presetRanges(), [])
  const rangeParam = params.get('range')
  // Default to All time so drilling in from the Overview shows the same all-time
  // numbers as before — the picker only narrows on demand.
  const range = useMemo<DateRange>(
    () =>
      rangeFromParam(rangeParam, RANGES) ??
      RANGES.find((r) => r.id === 'all') ??
      RANGES[RANGES.length - 1],
    [rangeParam, RANGES],
  )
  const setRange = (r: DateRange) => {
    const next = new URLSearchParams(params)
    next.set('range', rangeToParam(r))
    setParams(next, { replace: true })
  }

  const campaign = data?.campaigns.find((c) => c.campaign_id === id)
  const leads = useMemo(
    () => data?.leads.filter((l) => l.campaign_id === id) ?? [],
    [data, id],
  )
  const latest = useMemo(() => latestRepliesByLead(data?.messages ?? []), [data])
  // Range-scoped funnel for this campaign, recomputed client-side from raw leads
  // (same helpers as the Overview) so drill-down KPIs get delta chips + sparklines.
  const kpis = useMemo(() => {
    const prev = previousRange(range)
    return {
      totals: rangeTotals(leads, range, latest),
      prevTotals: prev ? rangeTotals(leads, prev, latest) : undefined,
      activity: leadsToActivity(leads),
    }
  }, [leads, range, latest])

  const compareIds = useMemo(() => {
    const raw = params.get('cmp')
    return raw ? raw.split(',').filter(Boolean) : []
  }, [params])
  const writeCompare = (ids: string[]) => {
    const next = new URLSearchParams(params)
    if (ids.length) next.set('cmp', ids.join(','))
    else next.delete('cmp')
    setParams(next, { replace: true })
  }

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
      <EmptyState
        className="card"
        icon={FileQuestion}
        title="Campaign not found"
        hint="It may have been removed or belongs to an account that hasn't synced."
        action={<Link className="link-btn" to="/">Back to overview</Link>}
      />
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
          <DateRangePicker presets={RANGES} value={range} onChange={setRange} />
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) writeCompare([...compareIds, e.target.value])
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
                    onClick={() => writeCompare(compareIds.filter((x) => x !== c.campaign_id))}
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
          <KpiCards
            totals={kpis.totals}
            prev={kpis.prevTotals}
            activity={kpis.activity}
            range={range}
            flowLabel={range.label}
            positive={kpis.totals.positive}
          />

          <div className="two-col">
            <Funnel leads={leads} showPipeline />
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
              color="var(--success)"
              lags={lagList(leads, 'invited_at', 'connected_at')}
            />
            <LagHistogram
              title="Time from accept to reply"
              color="var(--warning)"
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
          {num(campaign.invites_sent)} invites · {num(campaign.accepted)} accepted (
          {rate(campaign.acceptance_rate)}) · {num(campaign.replies)} replies (
          {rate(campaign.reply_rate)})
        </div>
      </div>
      <Funnel leads={leads} showPipeline />
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

