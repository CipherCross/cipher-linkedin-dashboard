import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import {
  fetchNeonOverviewAccountCampaigns,
  fetchNeonOverviewPerformance,
  fetchNeonOverviewSystemTotals,
  resolveReadPath,
} from '../lib/dashboardReads'
import { ALL_TIME_RANGE, rangeFromParam, rangeToParam, presetRanges, rangedCampaigns } from '../lib/leads'
import { buildOverviewAnalytics, buildOverviewSystemTotals } from '../lib/overviewAnalytics'
import type { DateRange } from '../lib/leads'
import type {
  CampaignMetrics,
  OverviewAccountCampaigns,
  OverviewPerformance,
  OverviewSystemTotals,
} from '../lib/types'
import { OverviewAnalytics } from '../components/overview/OverviewAnalytics'
import { InlineError, LinkButton, PageHeader } from '../ui'
import '../components/overview/overview.css'

type Answer<T> = { key: string; value: T }

const rangeKey = (range: DateRange) => `${range.from ?? ''}:${range.to ?? ''}`

function readyMark(section: 'system' | 'performance' | 'campaigns') {
  const mark = `dashboard_overview_${section}_available`
  const start = `dashboard_overview_${section}_start`
  globalThis.performance.mark(mark)
  try {
    globalThis.performance.measure(`dashboard_overview_${section}_ready_duration`, start, mark)
  } catch {
    // A browser may have restored a page without the matching start mark.
  }
}

function performanceForFallback(
  leads: Parameters<typeof buildOverviewAnalytics>[0],
  range: DateRange,
): OverviewPerformance {
  const analytics = buildOverviewAnalytics(leads, range)
  return {
    current: {
      invited: analytics.totals.invited,
      connected: analytics.totals.connected,
      replied: analytics.totals.replied,
    },
    previous: analytics.previous ? {
      invited: analytics.previous.invited,
      connected: analytics.previous.connected,
      replied: analytics.previous.replied,
    } : null,
    cohort: analytics.cohort,
    previousCohort: analytics.previousCohort,
    lifetime: {
      leads: analytics.lifetime.leads,
      invited: analytics.lifetime.invited,
      connected: analytics.lifetime.connected,
      messaged: analytics.lifetime.messaged,
      replied: analytics.lifetime.replied,
    },
    accounts: analytics.accounts.map((account) => ({
      instance_id: account.instance_id,
      current: {
        invited: account.totals.invited,
        connected: account.totals.connected,
        replied: account.totals.replied,
      },
      previous: account.previous ? {
        invited: account.previous.invited,
        connected: account.previous.connected,
        replied: account.previous.replied,
      } : null,
      cohort: account.cohort,
      previousCohort: account.previousCohort,
      lifetime: {
        leads: account.lifetime.leads,
        invited: account.lifetime.invited,
        connected: account.lifetime.connected,
        messaged: account.lifetime.messaged,
        replied: account.lifetime.replied,
      },
    })),
    activity: analytics.activity,
  }
}

function accountCampaignsForFallback(
  leads: Parameters<typeof buildOverviewAnalytics>[0],
  campaigns: CampaignMetrics[],
  range: DateRange,
): OverviewAccountCampaigns {
  const analytics = buildOverviewAnalytics(leads, range)
  const lifetime = new Map(
    rangedCampaigns(leads, campaigns, ALL_TIME_RANGE).map((campaign) => [campaign.campaign_id, campaign]),
  )
  const rangeRows = rangedCampaigns(leads, campaigns, range)
  const present = new Set(rangeRows.map((campaign) => campaign.campaign_id))
  for (const campaign of campaigns) {
    if (present.has(campaign.campaign_id)) continue
    const allTime = lifetime.get(campaign.campaign_id)
    rangeRows.push({
      ...campaign,
      total_leads: 0,
      leads_added: 0,
      invites_sent: 0,
      connected: 0,
      first_messages: 0,
      accepted: 0,
      replies: 0,
      acceptance_rate: null,
      reply_rate: null,
      lifetime_acceptance_rate: allTime?.acceptance_rate ?? campaign.lifetime_acceptance_rate ?? campaign.acceptance_rate ?? null,
      lifetime_reply_rate: allTime?.reply_rate ?? campaign.lifetime_reply_rate ?? campaign.reply_rate ?? null,
    })
  }
  return {
    accounts: analytics.accounts,
    campaigns: rangeRows.map((campaign) => ({
      ...campaign,
      lifetime_acceptance_rate: lifetime.get(campaign.campaign_id)?.acceptance_rate ?? campaign.lifetime_acceptance_rate ?? null,
      lifetime_reply_rate: lifetime.get(campaign.campaign_id)?.reply_rate ?? campaign.lifetime_reply_rate ?? null,
    })),
  }
}

export function Overview() {
  const { data, phase } = useData()
  const ready = data !== null
  const [params, setParams] = useSearchParams()
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10))
  const [system, setSystem] = useState<Answer<OverviewSystemTotals> | null>(null)
  const [performance, setPerformance] = useState<Answer<OverviewPerformance> | null>(null)
  const [accountCampaigns, setAccountCampaigns] = useState<Answer<OverviewAccountCampaigns> | null>(null)
  const [systemLoading, setSystemLoading] = useState(true)
  const [performanceLoading, setPerformanceLoading] = useState(true)
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [systemError, setSystemError] = useState<string | null>(null)
  const [performanceError, setPerformanceError] = useState<string | null>(null)
  const [campaignsError, setCampaignsError] = useState<string | null>(null)
  const [systemRetry, setSystemRetry] = useState(0)
  const [performanceRetry, setPerformanceRetry] = useState(0)
  const [campaignsRetry, setCampaignsRetry] = useState(0)
  const [readPath, setReadPath] = useState<'pending' | 'neon' | 'legacy' | 'error'>('pending')
  const [discoveryRetry, setDiscoveryRetry] = useState(0)
  const [criticalReadyKey, setCriticalReadyKey] = useState<string | null>(null)
  const legacy = readPath === 'legacy'

  useEffect(() => {
    const timer = setInterval(() => setToday(new Date().toISOString().slice(0, 10)), 60_000)
    return () => clearInterval(timer)
  }, [])

  const presets = useMemo(() => presetRanges(new Date(`${today}T12:00:00Z`)), [today])
  const accountPresets = useMemo(
    () => presets.map((preset) => preset.id === 'all' ? { ...preset, label: 'Lifetime' } : preset),
    [presets],
  )
  const range = useMemo(
    () => rangeFromParam(params.get('range'), presets) ?? presets[0],
    [params, presets],
  )
  const systemRange = useMemo(
    () => rangeFromParam(params.get('systemRange'), [ALL_TIME_RANGE, ...presets]) ?? ALL_TIME_RANGE,
    [params, presets],
  )
  const accountRange = useMemo(
    () => rangeFromParam(params.get('accountRange'), accountPresets) ?? accountPresets.find((preset) => preset.id === 'all') ?? ALL_TIME_RANGE,
    [accountPresets, params],
  )
  const account = params.get('account') || 'all'
  const updateParam = (name: string, value: string | null) => setParams((current) => {
    const next = new URLSearchParams(current)
    if (value == null) next.delete(name)
    else next.set(name, value)
    return next
  })
  const setRange = (next: DateRange) => updateParam('range', rangeToParam(next))
  const setSystemRange = (next: DateRange) => updateParam('systemRange', rangeToParam(next))
  const setAccountRange = (next: DateRange) => updateParam('accountRange', next.id === 'all' ? null : rangeToParam(next))
  const setAccount = (next: string) => updateParam('account', next === 'all' ? null : next)

  const systemKey = rangeKey(systemRange)
  const performanceKey = rangeKey(range)
  const campaignsKey = rangeKey(accountRange)
  const systemAttempt = `${systemKey}:${systemRetry}`
  const performanceAttempt = `${performanceKey}:${performanceRetry}`
  const campaignsAttempt = `${campaignsKey}:${campaignsRetry}`
  const criticalKey = `${systemKey}|${performanceKey}`

  useEffect(() => {
    let cancelled = false
    resolveReadPath()
      .then((path) => {
        if (!cancelled) setReadPath(path === 'neon' ? 'neon' : 'legacy')
      })
      .catch(() => {
        if (!cancelled) setReadPath('error')
      })
    return () => { cancelled = true }
  }, [discoveryRetry])

  useEffect(() => {
    if (!ready || readPath !== 'neon') return
    const controller = new AbortController()
    globalThis.performance.mark('dashboard_overview_system_start')
    setSystemLoading(true)
    setSystemError(null)
    fetchNeonOverviewSystemTotals(systemRange, undefined, controller.signal)
      .then((totals) => {
        if (controller.signal.aborted) return
        setSystem({ key: systemKey, value: totals })
      })
      .catch((error) => {
        if (!controller.signal.aborted) setSystemError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setSystemLoading(false)
          setCriticalReadyKey((current) => current === criticalKey ? current : criticalKey)
        }
      })
    return () => controller.abort()
    // `systemRange` is read for its value; the attempt key controls refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, readPath, systemAttempt])

  useEffect(() => {
    if (!ready || readPath !== 'neon') return
    const controller = new AbortController()
    globalThis.performance.mark('dashboard_overview_performance_start')
    setPerformanceLoading(true)
    setPerformanceError(null)
    fetchNeonOverviewPerformance(range, undefined, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        setPerformance({ key: performanceKey, value })
      })
      .catch((error) => {
        if (!controller.signal.aborted) setPerformanceError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setPerformanceLoading(false)
          setCriticalReadyKey((current) => current === criticalKey ? current : criticalKey)
        }
      })
    return () => controller.abort()
    // `range` is read for its value; the attempt key controls refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, readPath, performanceAttempt])

  useEffect(() => {
    if (!ready || readPath !== 'neon' || criticalReadyKey !== criticalKey) return
    const controller = new AbortController()
    globalThis.performance.mark('dashboard_overview_campaigns_start')
    setCampaignsLoading(true)
    setCampaignsError(null)
    fetchNeonOverviewAccountCampaigns(accountRange, undefined, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        setAccountCampaigns({ key: campaignsKey, value })
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCampaignsError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setCampaignsLoading(false)
      })
    return () => controller.abort()
    // `accountRange` is read for its value; the attempt key controls refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, readPath, criticalReadyKey, criticalKey, campaignsAttempt])

  const currentSystem = system?.key === systemKey ? system.value : null
  const currentPerformance = performance?.key === performanceKey ? performance.value : null
  const currentCampaigns = accountCampaigns?.key === campaignsKey ? accountCampaigns.value : null

  useEffect(() => {
    if (readPath === 'neon' && currentSystem) readyMark('system')
  }, [readPath, currentSystem, systemKey])
  useEffect(() => {
    if (readPath === 'neon' && currentPerformance) readyMark('performance')
  }, [readPath, currentPerformance, performanceKey])
  useEffect(() => {
    if (readPath === 'neon' && currentCampaigns) readyMark('campaigns')
  }, [readPath, currentCampaigns, campaignsKey])
  useEffect(() => {
    if (readPath !== 'neon' || !currentSystem || !currentPerformance) return
    globalThis.performance.mark('dashboard_overview_useful')
    try {
      globalThis.performance.measure('dashboard_overview_useful_duration', 'dashboard_overview_system_start', 'dashboard_overview_useful')
    } catch { /* see readyMark */ }
  }, [readPath, currentSystem, currentPerformance, systemKey, performanceKey])
  useEffect(() => {
    if (readPath !== 'neon' || !currentSystem || !currentPerformance || !currentCampaigns) return
    globalThis.performance.mark('dashboard_overview_interactive')
    try {
      globalThis.performance.measure('dashboard_overview_interactive_duration', 'dashboard_overview_system_start', 'dashboard_overview_interactive')
    } catch { /* see readyMark */ }
  }, [readPath, currentSystem, currentPerformance, currentCampaigns, systemKey, performanceKey, campaignsKey])

  const fallback = useMemo(() => {
    if (!legacy || phase !== 'full' || !data) return null
    return {
      system: buildOverviewSystemTotals(data.leads, systemRange),
      performance: performanceForFallback(data.leads, range),
      accountCampaigns: accountCampaignsForFallback(data.leads, data.campaigns, accountRange),
    }
  }, [legacy, phase, data, range, systemRange, accountRange])

  if (!data) return null

  const props = legacy && fallback
    ? { system: fallback.system, performance: fallback.performance, accountCampaigns: fallback.accountCampaigns }
    : { system: currentSystem, performance: currentPerformance, accountCampaigns: currentCampaigns }

  return (
    <div className="overview">
      <PageHeader
        title="Overview"
        description="Your whole outreach system, in one place."
        actions={<LinkButton variant="secondary" to="/sequences">Open sequences</LinkButton>}
      />
      {readPath === 'error' ? (
        <InlineError
          title="Analytics could not determine its data source."
          message="Nothing below is out of date — nothing loaded at all."
          onRetry={() => setDiscoveryRetry((value) => value + 1)}
          retryLabel="Try again"
        />
      ) : (
        <OverviewAnalytics
          {...props}
          instances={data.instances}
          systemRange={systemRange}
          range={range}
          accountRange={accountRange}
          presets={presets}
          accountPresets={accountPresets}
          account={account}
          onSystemRangeChange={setSystemRange}
          onRangeChange={setRange}
          onAccountRangeChange={setAccountRange}
          onAccountChange={setAccount}
          systemLoading={readPath === 'pending' || (legacy && !fallback) ? true : legacy ? false : systemLoading}
          performanceLoading={readPath === 'pending' || (legacy && !fallback) ? true : legacy ? false : performanceLoading}
          accountCampaignsLoading={readPath === 'pending' || (legacy && !fallback) ? true : legacy ? false : campaignsLoading}
          systemError={legacy ? null : systemError}
          performanceError={legacy ? null : performanceError}
          accountCampaignsError={legacy ? null : campaignsError}
          onSystemRetry={() => setSystemRetry((value) => value + 1)}
          onPerformanceRetry={() => setPerformanceRetry((value) => value + 1)}
          onAccountCampaignsRetry={() => setCampaignsRetry((value) => value + 1)}
        />
      )}
    </div>
  )
}
