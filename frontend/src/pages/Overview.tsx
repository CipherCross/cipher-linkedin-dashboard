import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronDown, Loader2, Users } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { useConversation } from '../lib/ConversationContext'
import {
  fetchNeonOverviewSummary, fetchNeonSequenceHub, resolveReadPath,
} from '../lib/dashboardReads'
import {
  latestRepliesByLead, leadKey, leadsToActivity, presetRanges, previousRange, rangeFromParam,
  rangeToParam, rangeTotals, replyIntentMetrics, tsInRange,
} from '../lib/leads'
import type { DateRange, ReplyIntentMetrics } from '../lib/leads'
import { createSequenceDocument } from '../lib/sequenceBuilder'
import { createSequence } from '../lib/sequenceBuilderApi'
import type {
  CampaignMetrics, DailyActivity, Lead, OverviewAccountSummary,
  OverviewIntentSummary, OverviewSummary, SequenceHubReplyPreview, SequenceHubSnapshot,
} from '../lib/types'
import { KpiCards } from '../components/KpiCards'
import { Funnel } from '../components/Funnel'
import { AccountCard } from '../components/AccountCard'
import { ImportCalloutCard } from '../components/ImportCalloutCard'
import { FollowUpCalloutCard } from '../components/FollowUpCalloutCard'
import { DateRangePicker } from '../components/DateRangePicker'
import { EmptyState } from '../components/EmptyState'
import { ActiveSequences } from '../components/overview/ActiveSequences'
import { NewReplies } from '../components/overview/NewReplies'
import { GlobalSummary } from '../components/overview/GlobalSummary'

const STALE_HOURS = 24
const NO_LEADS: Lead[] = []
const EMPTY_HUB: SequenceHubSnapshot = { items: [], newestReplies: [] }

function intentMetrics(value: OverviewIntentSummary): ReplyIntentMetrics {
  const rate = (n: number, d: number) => (d > 0 ? (100 * n) / d : null)
  return {
    ...value,
    p3BookingRate: rate(value.p3Booked, value.p3),
    matureP3BookingRate: rate(value.matureP3Booked, value.matureP3),
    p3GhostingRate: rate(value.p3Ghosted, value.p3),
  }
}

export function Overview() {
  const { data, phase } = useData()
  const navigate = useNavigate()
  const toast = useToast()
  const { openConversation } = useConversation()
  const [params, setParams] = useSearchParams()
  const ranges = useMemo(() => presetRanges(), [])
  const rangeParam = params.get('range')
  const range = useMemo<DateRange>(
    () =>
      rangeFromParam(rangeParam, ranges) ??
      ranges.find((item) => item.id === '3_months') ??
      ranges[ranges.length - 1],
    [rangeParam, ranges],
  )
  const setRange = (nextRange: DateRange) => {
    const next = new URLSearchParams(params)
    next.set('range', rangeToParam(nextRange))
    setParams(next, { replace: true })
  }

  const [summary, setSummary] = useState<OverviewSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [legacyPath, setLegacyPath] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSummaryLoading(true)
    setSummaryError(null)
    ;(async () => {
      try {
        const path = await resolveReadPath()
        if (cancelled) return
        if (path !== 'neon') {
          setLegacyPath(true)
          setSummary(null)
          return
        }
        setLegacyPath(false)
        const next = await fetchNeonOverviewSummary(range)
        if (cancelled) return
        setSummary(next)
        performance.mark('dashboard_overview_useful')
        requestAnimationFrame(() => performance.mark('dashboard_overview_interactive'))
      } catch (error) {
        if (cancelled) return
        setSummaryError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) {
          setSummaryLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [range, data?.campaigns])

  // The operational top of the page. One bounded aggregate: sequence, deployment
  // and reply *previews*, never lead or message collections — full threads stay
  // on the drawer's own on-demand fetch. It is date-range independent by design;
  // "what is running right now" does not narrow with the analytics picker.
  const [hub, setHub] = useState<SequenceHubSnapshot | null>(null)
  const [hubSupported, setHubSupported] = useState(true)
  const [hubLoading, setHubLoading] = useState(true)
  const [hubError, setHubError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setHubLoading(true)
    setHubError(null)
    ;(async () => {
      try {
        const path = await resolveReadPath()
        if (cancelled) return
        if (path !== 'neon') {
          setHubSupported(false)
          setHub(null)
          return
        }
        setHubSupported(true)
        const next = await fetchNeonSequenceHub()
        if (!cancelled) setHub(next)
      } catch (error) {
        if (!cancelled) setHubError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setHubLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [data?.campaigns])

  const [creating, setCreating] = useState(false)
  const [analyticsOpen, setAnalyticsOpen] = useState(() => {
    try { return localStorage.getItem('overview-analytics-open') !== 'false' } catch { return true }
  })
  const toggleAnalytics = useCallback(() => {
    setAnalyticsOpen((prev) => {
      const next = !prev
      try { localStorage.setItem('overview-analytics-open', String(next)) } catch { /* noop */ }
      return next
    })
  }, [])
  const createDraft = async () => {
    setCreating(true)
    try {
      const sequence = await createSequence('Untitled sequence', createSequenceDocument())
      navigate(`/sequences/${sequence.id}`)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not create sequence.')
    } finally {
      setCreating(false)
    }
  }

  // Reply previews carry an account-scoped thread key, not a lead row. The drawer
  // needs the lead, so it is looked up in the snapshot already in memory — no
  // extra read, and a lead that has not loaded falls back to its campaign.
  const leadsByThread = useMemo(() => {
    const map = new Map<string, Lead>()
    for (const lead of data?.leads ?? []) {
      map.set(leadKey(lead.instance_id, lead.profile_url), lead)
    }
    return map
  }, [data?.leads])
  const resolveLead = useCallback(
    (reply: SequenceHubReplyPreview) =>
      leadsByThread.get(leadKey(reply.instance_id, reply.profile_url)) ?? null,
    [leadsByThread],
  )

  // Legacy fallback remains exact for the owner's not-yet-cut-over deployment.
  // It runs only after that path's complete snapshot is ready.
  const leadsByInstance = useMemo(() => {
    const map = new Map<string, Lead[]>()
    if (!legacyPath) return map
    for (const lead of data?.leads ?? []) {
      const rows = map.get(lead.instance_id)
      if (rows) rows.push(lead)
      else map.set(lead.instance_id, [lead])
    }
    return map
  }, [data?.leads, legacyPath])

  const accountSummary = useMemo(
    () => new Map((summary?.accounts ?? []).map((row) => [row.instance_id, row])),
    [summary?.accounts],
  )
  const summaryCampaigns = useMemo(() => {
    const map = new Map<string, CampaignMetrics[]>()
    for (const campaign of summary?.campaigns ?? []) {
      const rows = map.get(campaign.instance_id)
      if (rows) rows.push(campaign)
      else map.set(campaign.instance_id, [campaign])
    }
    return map
  }, [summary?.campaigns])
  const summaryActivity = useMemo(() => {
    const map = new Map<string, DailyActivity[]>()
    for (const row of summary?.activity ?? []) {
      const rows = map.get(row.instance_id)
      if (rows) rows.push(row)
      else map.set(row.instance_id, [row])
    }
    return map
  }, [summary?.activity])

  const instances = useMemo(() => {
    if (!data) return []
    const staleCutoff = Date.now() - STALE_HOURS * 3_600_000
    return [...data.instances].sort((a, b) => {
      const freshA = a.last_sync_at ? Date.parse(a.last_sync_at) > staleCutoff : false
      const freshB = b.last_sync_at ? Date.parse(b.last_sync_at) > staleCutoff : false
      if (freshA !== freshB) return freshA ? -1 : 1
      const countA = summary
        ? accountSummary.get(a.id)?.totals.leads ?? 0
        : leadsByInstance.get(a.id)?.length ?? 0
      const countB = summary
        ? accountSummary.get(b.id)?.totals.leads ?? 0
        : leadsByInstance.get(b.id)?.length ?? 0
      return countB - countA
    })
  }, [data?.instances, summary, accountSummary, leadsByInstance])

  const legacy = useMemo(() => {
    if (!legacyPath || !data || phase !== 'full') return null
    const latest = latestRepliesByLead(data.messages)
    const previous = previousRange(range)
    const intent = replyIntentMetrics(data.leads, data.messages, data.pipelineEvents, range, {
      intentRows: data.conversationReplyIntents,
    })
    return {
      latest,
      totals: rangeTotals(data.leads, range, latest),
      prevTotals: previous ? rangeTotals(data.leads, previous, latest) : undefined,
      intent,
      intentPrev: previous
        ? replyIntentMetrics(data.leads, data.messages, data.pipelineEvents, previous, {
            intentRows: data.conversationReplyIntents,
          })
        : undefined,
      added: data.leads.filter((lead) => tsInRange(lead.added_at, range)).length,
      addedPrev: previous
        ? data.leads.filter((lead) => tsInRange(lead.added_at, previous)).length
        : undefined,
      activity: leadsToActivity(data.leads),
    }
  }, [legacyPath, data, phase, range])

  if (!data) return null

  const metricsReady = summary !== null || legacy !== null
  const globalIntent = summary ? intentMetrics(summary.intent) : legacy?.intent
  const globalIntentPrev = summary?.intentPrev
    ? intentMetrics(summary.intentPrev)
    : legacy?.intentPrev
  const totals = summary?.totals ?? legacy?.totals
  const snapshot = hub ?? EMPTY_HUB

  return (
    <>
      <header>
        <div>
          <h1>Overview</h1>
          <div className="muted small">
            What is running now · {data.instances.length} Linked Helper instances
          </div>
        </div>
        <div className="controls">
          <DateRangePicker presets={ranges} value={range} onChange={setRange} />
        </div>
      </header>

      {hubSupported && (
        <div className="overview-operations">
          <ActiveSequences
            items={snapshot.items}
            loading={hubLoading}
            error={hubError}
            onCreate={createDraft}
            creating={creating}
          />
          <NewReplies
            replies={snapshot.newestReplies}
            loading={hubLoading}
            error={hubError}
            resolveLead={resolveLead}
            onOpen={openConversation}
          />
        </div>
      )}

      {summaryError && !legacy && (
        <div className="card error-state">
          <strong>Overview metrics could not load.</strong>
          <div className="muted small">{summaryError}</div>
        </div>
      )}

      {!metricsReady ? (
        <div className="card empty-state">
          <Loader2 size={20} className="spin" />
          <div>{summaryLoading ? 'Loading exact metrics…' : 'Metrics are not available yet.'}</div>
        </div>
      ) : (
        <GlobalSummary
          totals={totals!}
          intent={globalIntent}
          rangeLabel={range.label}
          accounts={data.instances.length}
        />
      )}

      {phase === 'full' && <FollowUpCalloutCard />}
      {phase === 'full' && <ImportCalloutCard />}

      <section className="overview-section" aria-labelledby="fleet-health-title">
        <h2 id="fleet-health-title" className="overview-section-title">Fleet health</h2>
        {instances.length === 0 ? (
          <EmptyState
            className="card"
            icon={Users}
            title="No accounts yet"
            hint="Run the sync agent on a notebook to register your first LinkedIn account."
            action={<Link className="link-btn" to="/health">Open Sync health</Link>}
          />
        ) : metricsReady ? (
          <div className="account-grid">
            {instances.map((instance) => {
              const account = accountSummary.get(instance.id)
              const legacyLeads = leadsByInstance.get(instance.id) ?? NO_LEADS
              const accountIntent = account
                ? intentMetrics(account.intent)
                : legacy
                  ? replyIntentMetrics(data.leads, data.messages, data.pipelineEvents, range, {
                      instanceId: instance.id,
                      intentRows: data.conversationReplyIntents,
                    })
                  : undefined
              return (
                <AccountCard
                  key={instance.id}
                  inst={instance}
                  leads={summary ? undefined : legacyLeads}
                  campaignsMeta={data.campaigns}
                  range={range}
                  latest={legacy?.latest}
                  intent={accountIntent}
                  summary={account as OverviewAccountSummary | undefined}
                  summaryActivity={summaryActivity.get(instance.id)}
                  summaryCampaigns={summaryCampaigns.get(instance.id)}
                />
              )
            })}
          </div>
        ) : null}
      </section>

      {metricsReady && (
        <section className="overview-section" aria-labelledby="analytics-title">
          <button
            id="analytics-title"
            className="overview-section-title overview-section-toggle"
            aria-expanded={analyticsOpen}
            aria-controls="analytics-content"
            onClick={toggleAnalytics}
          >
            <ChevronDown size={14} className="overview-section-chevron" aria-hidden />
            Analytics
          </button>
          <div id="analytics-content" hidden={!analyticsOpen}>
            <KpiCards
              totals={totals!}
              prev={summary?.prevTotals ?? legacy?.prevTotals}
              activity={summary?.activity ?? legacy!.activity}
              range={range}
              flowLabel={range.label}
              intent={globalIntent}
              intentPrev={globalIntentPrev}
              added={summary?.totals.added ?? legacy!.added}
              addedPrev={summary?.prevTotals?.added ?? legacy?.addedPrev}
              velocityLeads={summary ? undefined : data.leads}
              velocitySummary={summary ? {
                buckets: summary.velocity,
                undated: summary.velocityUndated,
              } : undefined}
            />
            <Funnel
              leads={summary ? undefined : data.leads}
              showPipeline
              summary={summary?.funnel}
            />
          </div>
        </section>
      )}
    </>
  )
}
