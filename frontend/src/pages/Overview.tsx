import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import {
  fetchNeonOverviewAccountAnalytics,
  fetchNeonOverviewSummary,
  fetchNeonOverviewSystemTotals,
  resolveReadPath,
} from '../lib/dashboardReads'
import { ALL_TIME_RANGE, rangeFromParam, rangeToParam, presetRanges, rangedCampaigns } from '../lib/leads'
import { buildOverviewAnalytics } from '../lib/overviewAnalytics'
import type { DateRange } from '../lib/leads'
import type { CampaignMetrics, OverviewAnalytics as Analytics } from '../lib/types'
import { OverviewAnalytics } from '../components/overview/OverviewAnalytics'
import { InlineError, LinkButton, PageHeader } from '../ui'
import '../components/overview/overview.css'

export function Overview() {
  const { data, phase } = useData()
  // The bootstrap is complete enough to ask an analytics question. A boolean,
  // not the object: the object's identity changes on every background refresh.
  const ready = data !== null
  const [params, setParams] = useSearchParams()
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10))
  /**
   * Each answer is held together with the range it answers for.
   *
   * The page used to clear these to `null` at the start of every fetch, so a
   * background refresh — or any unrelated change to the `data` object — replaced
   * a complete Overview with skeletons for as long as the read took. Keeping the
   * range beside the value means the opposite of clearing: a refresh of the same
   * range leaves the numbers on screen, and a *changed* range stops rendering
   * the old ones without anybody having to remember to clear them, because they
   * no longer answer the question being asked.
   */
  const [system, setSystem] = useState<{ key: string; value: Analytics } | null>(null)
  const [performance, setPerformance] = useState<{ key: string; value: Analytics; campaigns: CampaignMetrics[] } | null>(null)
  const [accountAnalytics, setAccountAnalytics] = useState<{ key: string; value: Analytics; campaigns: CampaignMetrics[] } | null>(null)
  const [systemLoading, setSystemLoading] = useState(true)
  const [performanceLoading, setPerformanceLoading] = useState(true)
  const [accountAnalyticsLoading, setAccountAnalyticsLoading] = useState(true)
  const [systemError, setSystemError] = useState<string | null>(null)
  const [performanceError, setPerformanceError] = useState<string | null>(null)
  const [accountAnalyticsError, setAccountAnalyticsError] = useState<string | null>(null)
  const [systemRetry, setSystemRetry] = useState(0)
  const [performanceRetry, setPerformanceRetry] = useState(0)
  const [accountAnalyticsRetry, setAccountAnalyticsRetry] = useState(0)
  const [readPath, setReadPath] = useState<'pending' | 'neon' | 'legacy' | 'error'>('pending')
  const [discoveryRetry, setDiscoveryRetry] = useState(0)
  const legacy = readPath === 'legacy'

  useEffect(() => {
    const timer = setInterval(() => setToday(new Date().toISOString().slice(0, 10)), 60_000)
    return () => clearInterval(timer)
  }, [])

  const presets = useMemo(() => presetRanges(new Date(`${today}T12:00:00Z`)), [today])
  const accountPresets = useMemo(
    () => presets.map(preset => preset.id === 'all' ? { ...preset, label: 'Lifetime' } : preset),
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
    () => rangeFromParam(params.get('accountRange'), accountPresets) ?? accountPresets.find(preset => preset.id === 'all') ?? ALL_TIME_RANGE,
    [accountPresets, params],
  )
  const account = params.get('account') || 'all'
  const updateParam = (name: string, value: string | null) => setParams(current => {
    const next = new URLSearchParams(current)
    if (value == null) next.delete(name)
    else next.set(name, value)
    return next
  })
  const setRange = (next: DateRange) => updateParam('range', rangeToParam(next))
  const setSystemRange = (next: DateRange) => updateParam('systemRange', rangeToParam(next))
  const setAccountRange = (next: DateRange) => updateParam('accountRange', next.id === 'all' ? null : rangeToParam(next))
  const setAccount = (next: string) => updateParam('account', next === 'all' ? null : next)

  const systemKey = `${systemRange.from}:${systemRange.to}:${systemRetry}`
  const performanceKey = `${range.from}:${range.to}:${performanceRetry}`
  const accountAnalyticsKey = `${accountRange.from}:${accountRange.to}:${accountAnalyticsRetry}`
  const systemInFlight = useRef<string | null>(null)
  const performanceInFlight = useRef<string | null>(null)
  const accountAnalyticsInFlight = useRef<string | null>(null)

  /**
   * Which provider answers, resolved once.
   *
   * `data` used to be a dependency, and that was the whole of the Overview
   * defect: `DataContext` replaces the object on every load and every five
   * minute refresh, so this effect reset the path to `pending` — which is
   * rendered as a loading skeleton — and re-ran both analytics reads, for a
   * lookup that is memoized for the session and cannot change while the tab is
   * open. Discovery depends on the deployment, not on the data.
   */
  useEffect(() => {
    let cancelled = false
    resolveReadPath()
      .then(path => {
        if (!cancelled) setReadPath(path === 'neon' ? 'neon' : 'legacy')
      })
      .catch(() => {
        if (!cancelled) setReadPath('error')
      })
    return () => { cancelled = true }
  }, [discoveryRetry])

  // Ready, path, range, retry — and nothing else. `data` is deliberately absent:
  // this read is a function of the range and the signed-in tenant, and the
  // dashboard's own dataset changing is not a reason to ask again.
  useEffect(() => {
    if (!ready || readPath !== 'neon') return
    if (systemInFlight.current === systemKey) return
    systemInFlight.current = systemKey
    let cancelled = false
    setSystemLoading(true)
    setSystemError(null)
    fetchNeonOverviewSystemTotals(systemRange)
      .then(totals => {
        if (cancelled) return
        setSystem({ key: systemKey, value: { totals, previous: null, lifetime: totals, accounts: [], activity: [] } })
        globalThis.performance.mark('dashboard_overview_system_available')
      })
      .catch(error => {
        if (!cancelled) setSystemError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (cancelled) return
        systemInFlight.current = null
        setSystemLoading(false)
      })
    // The marker is *not* cleared here. A cleanup that released it would make
    // the guard above unreachable — the only way back into this effect with the
    // same key is a re-run, and a re-run is always preceded by its cleanup.
    return () => { cancelled = true }
    // `systemRange` is read for its value; `systemKey` is what decides a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, readPath, systemKey])

  useEffect(() => {
    if (!ready || readPath !== 'neon') return
    if (performanceInFlight.current === performanceKey) return
    performanceInFlight.current = performanceKey
    let cancelled = false
    setPerformanceLoading(true)
    setPerformanceError(null)
    fetchNeonOverviewSummary(range)
      .then(summary => {
        if (cancelled) return
        if (!summary.analytics) throw new Error('Performance analytics are unavailable')
        setPerformance({ key: performanceKey, value: summary.analytics, campaigns: summary.campaigns ?? [] })
        globalThis.performance.mark('dashboard_overview_performance_available')
      })
      .catch(error => {
        if (!cancelled) setPerformanceError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (cancelled) return
        performanceInFlight.current = null
        setPerformanceLoading(false)
      })
    return () => { cancelled = true }
    // `range` is read for its value; `performanceKey` is what decides a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, readPath, performanceKey])

  useEffect(() => {
    if (!ready || readPath !== 'neon') return
    if (accountAnalyticsInFlight.current === accountAnalyticsKey) return
    accountAnalyticsInFlight.current = accountAnalyticsKey
    let cancelled = false
    setAccountAnalyticsLoading(true)
    setAccountAnalyticsError(null)
    fetchNeonOverviewAccountAnalytics(accountRange)
      .then(summary => {
        if (cancelled) return
        if (!summary.analytics) throw new Error('Account analytics are unavailable')
        setAccountAnalytics({
          key: accountAnalyticsKey,
          value: summary.analytics,
          campaigns: summary.campaigns ?? [],
        })
      })
      .catch(error => {
        if (!cancelled) setAccountAnalyticsError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (cancelled) return
        accountAnalyticsInFlight.current = null
        setAccountAnalyticsLoading(false)
      })
    return () => { cancelled = true }
    // `accountRange` is read for its value; the key decides whether to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, readPath, accountAnalyticsKey])

  // Only an answer for the range on screen counts as useful.
  const currentSystem = system?.key === systemKey ? system.value : null
  const currentPerformance = performance?.key === performanceKey ? performance.value : null
  const currentAccountAnalytics = accountAnalytics?.key === accountAnalyticsKey ? accountAnalytics.value : null
  const accountCampaigns = accountAnalytics?.key === accountAnalyticsKey ? accountAnalytics.campaigns : []
  useEffect(() => {
    if (readPath === 'neon' && currentSystem && currentPerformance) {
      globalThis.performance.mark('dashboard_overview_useful')
      requestAnimationFrame(() => globalThis.performance.mark('dashboard_overview_interactive'))
    }
  }, [readPath, currentSystem, currentPerformance])

  const fallback = useMemo(() => {
    if (!legacy || phase !== 'full' || !data) return null
    const systemAnalytics = buildOverviewAnalytics(data.leads, systemRange)
    const performanceAnalytics = buildOverviewAnalytics(data.leads, range)
    const accountAnalytics = buildOverviewAnalytics(data.leads, accountRange)
    const lifetime = new Map(rangedCampaigns(data.leads, data.campaigns, ALL_TIME_RANGE).map(c => [c.campaign_id, c]))
    const campaigns = rangedCampaigns(data.leads, data.campaigns, accountRange).map(c => ({
      ...c,
      lifetime_acceptance_rate: lifetime.get(c.campaign_id)?.acceptance_rate,
      lifetime_reply_rate: lifetime.get(c.campaign_id)?.reply_rate,
    }))
    return { systemAnalytics, performanceAnalytics, accountAnalytics, campaigns }
  }, [legacy, phase, data, range, systemRange, accountRange])

  if (!data) return null

  const mergedCampaigns = data.campaigns.map(base => {
    const measured = accountCampaigns.find(row => row.campaign_id === base.campaign_id)
    return measured ?? {
      ...base,
      invites_sent: 0,
      accepted: 0,
      replies: 0,
      lifetime_acceptance_rate: null,
      lifetime_reply_rate: null,
    }
  })
  for (const measured of accountCampaigns) {
    if (!mergedCampaigns.some(row => row.campaign_id === measured.campaign_id)) mergedCampaigns.push(measured)
  }

  const props = legacy && fallback
    ? { system: fallback.systemAnalytics, performance: fallback.performanceAnalytics, accountAnalytics: fallback.accountAnalytics, campaigns: fallback.campaigns, instances: data.instances }
    : { system: currentSystem, performance: currentPerformance, accountAnalytics: currentAccountAnalytics, campaigns: mergedCampaigns, instances: data.instances }

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
          onRetry={() => setDiscoveryRetry(value => value + 1)}
          retryLabel="Try again"
        />
      ) : (
        <OverviewAnalytics
          {...props}
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
          accountAnalyticsLoading={readPath === 'pending' || (legacy && !fallback) ? true : legacy ? false : accountAnalyticsLoading}
          systemError={legacy ? null : systemError}
          performanceError={legacy ? null : performanceError}
          accountAnalyticsError={legacy ? null : accountAnalyticsError}
          onSystemRetry={() => setSystemRetry(value => value + 1)}
          onPerformanceRetry={() => setPerformanceRetry(value => value + 1)}
          onAccountAnalyticsRetry={() => setAccountAnalyticsRetry(value => value + 1)}
        />
      )}
    </div>
  )
}
