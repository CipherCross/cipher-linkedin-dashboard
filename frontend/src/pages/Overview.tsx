import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Users } from 'lucide-react'
import { useData } from '../lib/DataContext'
import {
  latestRepliesByLead, leadsToActivity, presetRanges, previousRange, rangeFromParam,
  rangeToParam, rangeTotals, replyIntentMetrics, tsInRange,
} from '../lib/leads'
import type { DateRange } from '../lib/leads'
import type { Lead } from '../lib/types'
import { KpiCards } from '../components/KpiCards'
import { Funnel } from '../components/Funnel'
import { AccountCard } from '../components/AccountCard'
import { BriefingCard } from '../components/BriefingCard'
import { ImportCalloutCard } from '../components/ImportCalloutCard'
import { FollowUpCalloutCard } from '../components/FollowUpCalloutCard'
import { DateRangePicker } from '../components/DateRangePicker'
import { EmptyState } from '../components/EmptyState'

const STALE_HOURS = 24

// Shared empty-leads reference for instances with no leads, so the AccountCard
// `leads` prop stays reference-equal across refreshes instead of a fresh `[]`.
const NO_LEADS: Lead[] = []

export function Overview() {
  const { data } = useData()
  const [params, setParams] = useSearchParams()
  const RANGES = useMemo(() => presetRanges(), [])
  const rangeParam = params.get('range')
  const range = useMemo<DateRange>(
    () =>
      rangeFromParam(rangeParam, RANGES) ??
      RANGES.find((r) => r.id === '3_months') ??
      RANGES[RANGES.length - 1],
    [rangeParam, RANGES],
  )
  const setRange = (r: DateRange) => {
    const next = new URLSearchParams(params)
    next.set('range', rangeToParam(r))
    setParams(next, { replace: true })
  }

  // Each derivation is keyed on the exact data slice(s) it reads (not the whole
  // `data`, whose identity changes every 5-min refresh) and each slice is now
  // reference-stable across a no-op refresh (see DataContext). So on a no-op tick
  // these memos return their cached values, every AccountCard prop stays identical,
  // and React.memo skips the whole grid — the periodic-refresh target.

  // Buckets keyed on data.leads only, so an instance-only change (e.g. a
  // last_sync_at bump) doesn't hand AccountCard fresh per-instance arrays.
  const leadsByInstance = useMemo(() => {
    const map = new Map<string, Lead[]>()
    for (const l of data?.leads ?? []) {
      const arr = map.get(l.instance_id)
      if (arr) arr.push(l)
      else map.set(l.instance_id, [l])
    }
    return map
  }, [data?.leads])

  // Fresh accounts first, then by pipeline size.
  const instances = useMemo(() => {
    if (!data) return []
    const staleCutoff = Date.now() - STALE_HOURS * 3_600_000
    return [...data.instances].sort((a, b) => {
      const freshA = a.last_sync_at ? new Date(a.last_sync_at).getTime() > staleCutoff : false
      const freshB = b.last_sync_at ? new Date(b.last_sync_at).getTime() > staleCutoff : false
      if (freshA !== freshB) return freshA ? -1 : 1
      return (leadsByInstance.get(b.id)?.length ?? 0) - (leadsByInstance.get(a.id)?.length ?? 0)
    })
  }, [data?.instances, leadsByInstance])

  const latest = useMemo(() => latestRepliesByLead(data?.messages ?? []), [data?.messages])
  const intentByInstance = useMemo(() => {
    const map = new Map<string, ReturnType<typeof replyIntentMetrics>>()
    if (!data) return map
    for (const inst of data.instances) {
      map.set(
        inst.id,
        replyIntentMetrics(data.leads, data.messages, data.pipelineEvents, range, {
          instanceId: inst.id,
          intentRows: data.conversationReplyIntents,
        }),
      )
    }
    return map
  }, [
    data?.instances,
    data?.leads,
    data?.messages,
    data?.pipelineEvents,
    data?.conversationReplyIntents,
    range,
  ])

  // KPI / funnel aggregates (not consumed by AccountCard).
  const kpis = useMemo(() => {
    if (!data) return null
    const prevRange = previousRange(range)
    return {
      totals: rangeTotals(data.leads, range, latest),
      prevTotals: prevRange ? rangeTotals(data.leads, prevRange, latest) : undefined,
      intent: replyIntentMetrics(data.leads, data.messages, data.pipelineEvents, range, {
        intentRows: data.conversationReplyIntents,
      }),
      intentPrev: prevRange
        ? replyIntentMetrics(data.leads, data.messages, data.pipelineEvents, prevRange, {
            intentRows: data.conversationReplyIntents,
          })
        : undefined,
      added: data.leads.filter((l) => tsInRange(l.added_at, range)).length,
      addedPrev: prevRange
        ? data.leads.filter((l) => tsInRange(l.added_at, prevRange)).length
        : undefined,
      activity: leadsToActivity(data.leads),
    }
  }, [
    data?.leads,
    data?.messages,
    data?.pipelineEvents,
    data?.conversationReplyIntents,
    range,
    latest,
  ])

  if (!data || !kpis) return null

  return (
    <>
      <header>
        <div>
          <h1>Overview</h1>
          <div className="muted small">
            All LinkedIn accounts at a glance · {data.instances.length} Linked Helper instances
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
        intent={kpis.intent}
        intentPrev={kpis.intentPrev}
        added={kpis.added}
        addedPrev={kpis.addedPrev}
        velocityLeads={data.leads}
      />

      <BriefingCard />

      <FollowUpCalloutCard />

      <ImportCalloutCard />

      {instances.length === 0 ? (
        <EmptyState
          className="card"
          icon={Users}
          title="No accounts yet"
          hint="Run the sync agent on a notebook to register your first LinkedIn account."
          action={<Link className="link-btn" to="/health">Open Sync health</Link>}
        />
      ) : (
        <div className="account-grid">
          {instances.map((inst) => (
            <AccountCard
              key={inst.id}
              inst={inst}
              // Shared stable empty ref for zero-lead instances so the prop stays
              // reference-equal across refreshes (keeps React.memo skipping).
              leads={leadsByInstance.get(inst.id) ?? NO_LEADS}
              campaignsMeta={data.campaigns}
              range={range}
              latest={latest}
              intent={intentByInstance.get(inst.id)}
            />
          ))}
        </div>
      )}

      {/* Global funnel across every account — its Manual-pipeline section is
          self-hiding when no lead has been staged, so this is a no-op until the
          team starts using the pipeline board. */}
      <Funnel leads={data.leads} showPipeline />
    </>
  )
}
