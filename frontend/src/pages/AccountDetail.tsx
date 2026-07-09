import { useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { FileQuestion } from 'lucide-react'
import { useData } from '../lib/DataContext'
import {
  WEEKLY_ADD_LIMIT, instanceName, latestRepliesByLead, leadsToActivity, presetRanges,
  previousRange, rangeFromParam, rangeTotals, rangeToParam, weeklyAdded,
} from '../lib/leads'
import type { DateRange } from '../lib/leads'
import { ago, num } from '../lib/format'
import { DateRangePicker } from '../components/DateRangePicker'
import { EmptyState } from '../components/EmptyState'
import { KpiCards } from '../components/KpiCards'
import { WarmupChart } from '../components/WarmupChart'
import { Heatmap } from '../components/Heatmap'
import { CampaignTable } from '../components/CampaignTable'
import { Avatar } from '../components/Avatar'

export function AccountDetail() {
  const { id } = useParams<{ id: string }>()
  const { data } = useData()
  const [params, setParams] = useSearchParams()

  const RANGES = useMemo(() => presetRanges(), [])
  const rangeParam = params.get('range')
  // Default to All time so drilling in from the Overview keeps the same all-time
  // numbers; the picker only narrows the KPIs on demand.
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

  const leads = useMemo(
    () => data?.leads.filter((l) => l.instance_id === id) ?? [],
    [data, id],
  )
  const latest = useMemo(() => latestRepliesByLead(data?.messages ?? []), [data])
  // Range-scoped funnel for this account, recomputed from raw leads with the same
  // helpers the Overview uses, so drill-down KPIs get delta chips + sparklines.
  const kpis = useMemo(() => {
    const prev = previousRange(range)
    return {
      totals: rangeTotals(leads, range, latest),
      prevTotals: prev ? rangeTotals(leads, prev, latest) : undefined,
      activity: leadsToActivity(leads),
    }
  }, [leads, range, latest])

  if (!data) return null
  const inst = data.instances.find((i) => i.id === id)
  if (!inst) {
    return (
      <EmptyState
        className="card"
        icon={FileQuestion}
        title="Account not found"
        hint="This LinkedIn account may not have synced yet, or the link is out of date."
        action={<Link className="link-btn" to="/">Back to overview</Link>}
      />
    )
  }
  const campaigns = data.campaigns.filter((c) => c.instance_id === inst.id)
  const added7d = weeklyAdded(leads, inst.id)
  const remaining = Math.max(0, WEEKLY_ADD_LIMIT - added7d)
  const addedFrac = added7d / WEEKLY_ADD_LIMIT
  const capColor =
    addedFrac >= 1 ? 'var(--danger)' : addedFrac >= 0.7 ? 'var(--warning)' : 'var(--success)'

  return (
    <>
      <header>
        <div className="account-head">
          <Avatar inst={inst} size={52} />
          <div>
            <div className="breadcrumb muted small">
              <Link to="/">Overview</Link> / account
            </div>
            <h1>{instanceName(inst)}</h1>
            <div className="muted small">
              {inst.account_url && (
                <>
                  <a className="row-link muted" href={inst.account_url} target="_blank" rel="noreferrer">
                    LinkedIn profile ↗
                  </a>
                  {' · '}
                </>
              )}
              {inst.account_name && inst.label && `${inst.label} · `}
              {inst.last_sync_at ? `synced ${ago(inst.last_sync_at)}` : 'never synced'} ·{' '}
              {campaigns.length} campaigns · {num(leads.length)} leads
            </div>
          </div>
        </div>
        <div className="controls">
          <DateRangePicker presets={RANGES} value={range} onChange={setRange} />
        </div>
      </header>

      <KpiCards
        totals={kpis.totals}
        prev={kpis.prevTotals}
        activity={kpis.activity}
        range={range}
        flowLabel={range.label}
        positive={kpis.totals.positive}
      />

      <div className="card">
        <div className="account-cell" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Added last 7 days</h2>
          <div className="small" style={{ color: capColor, fontWeight: 600 }}>
            {num(added7d)} / {WEEKLY_ADD_LIMIT}
          </div>
        </div>
        <div
          style={{
            height: 8, borderRadius: 4, background: 'var(--surface-2)',
            overflow: 'hidden', margin: '10px 0 8px',
          }}
        >
          <div
            style={{
              width: `${Math.min(100, addedFrac * 100)}%`,
              height: '100%', background: capColor, transition: 'width .2s',
            }}
          />
        </div>
        <div className="muted small">
          {remaining > 0 ? `${num(remaining)} more can be added this week` : 'Weekly add limit reached'}
          {' · '}~200/week keeps the account safe. Count is approximate until the
          agent v1.8.0 rollout backfills exact add dates.
        </div>
      </div>

      <div className="stack">
        <WarmupChart leads={leads} />
        <Heatmap leads={leads} />
        <CampaignTable
          campaigns={campaigns}
          instances={data.instances}
          title="Campaigns on this instance"
        />
      </div>
    </>
  )
}
