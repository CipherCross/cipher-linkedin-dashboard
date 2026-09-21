import { useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { FileQuestion } from 'lucide-react'
import { useData } from '../lib/DataContext'
import {
  WEEKLY_ADD_LIMIT, instanceName, latestRepliesByLead, leadsToActivity, presetRanges,
  previousRange, rangeFromParam, rangeTotals, rangeToParam, replyIntentMetrics, weeklyAdded,
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
import { PageHeader, Panel, SectionHeader } from '../ui'

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
      intent: data
        ? replyIntentMetrics(data.leads, data.messages, data.pipelineEvents, range, {
            instanceId: id,
            intentRows: data.conversationReplyIntents,
          })
        : undefined,
      intentPrev: data && prev
        ? replyIntentMetrics(data.leads, data.messages, data.pipelineEvents, prev, {
            instanceId: id,
            intentRows: data.conversationReplyIntents,
          })
        : undefined,
      activity: leadsToActivity(leads),
    }
  }, [data, id, leads, range, latest])

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
  const addedThisWeek = weeklyAdded(leads, inst.id)
  const remaining = Math.max(0, WEEKLY_ADD_LIMIT - addedThisWeek)
  const addedFrac = addedThisWeek / WEEKLY_ADD_LIMIT
  const capTone = addedFrac >= 1 ? 'danger' : addedFrac >= 0.7 ? 'warning' : 'success'

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Overview', to: '/' }, { label: 'Account' }]}
        title={
          <span className="flex items-center gap-app-lg">
            <Avatar inst={inst} size={44} />
            {instanceName(inst)}
          </span>
        }
        context={
          <span className="muted small">
            {inst.account_url && (
              <>
                <a className="row-link muted" href={inst.account_url} target="_blank" rel="noreferrer">
                  LinkedIn profile ↗
                </a>
                {' · '}
              </>
            )}
            {inst.account_name && inst.label && `${inst.label} · `}
            {inst.last_sync_at ? `Synced ${ago(inst.last_sync_at)}` : 'Never synced'} ·{' '}
            {campaigns.length} campaigns · {num(leads.length)} leads
          </span>
        }
        actions={<DateRangePicker presets={RANGES} value={range} onChange={setRange} />}
      />

      <KpiCards
        totals={kpis.totals}
        prev={kpis.prevTotals}
        activity={kpis.activity}
        range={range}
        flowLabel={range.label}
        intent={kpis.intent}
        intentPrev={kpis.intentPrev}
      />

      <Panel>
        <SectionHeader
          title="Added this week"
          actions={<strong className="tabular">{num(addedThisWeek)} / {WEEKLY_ADD_LIMIT}</strong>}
        />
        {/* A meter is data, so it keeps its status hue — and it is always read
            out in words underneath, never by colour alone. */}
        <div
          className="h-2.5 mt-app-md mb-app-sm rounded-pill overflow-hidden [&>span]:block [&>span]:h-full [&>span]:rounded-[inherit] [&>span]:transition-[width]"
          role="meter"
          aria-valuenow={addedThisWeek}
          aria-valuemin={0}
          aria-valuemax={WEEKLY_ADD_LIMIT}
          aria-label="Leads added this week against the weekly limit"
          style={{ background: `var(--${capTone}-subtle)` }}
        >
          <span
            style={{
              width: `${Math.min(100, addedFrac * 100)}%`,
              background: `var(--${capTone})`,
            }}
          />
        </div>
        <div className="muted small">
          {remaining > 0 ? `${num(remaining)} more can be added this week` : 'Weekly add limit reached'}
          {' · '}~200/week keeps the account safe.
        </div>
      </Panel>

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
