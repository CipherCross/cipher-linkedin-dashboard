import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import {
  fetchNeonOverviewAccountCampaigns,
  fetchNeonOverviewPerformance,
  fetchNeonOverviewSystemTotals,
} from '../lib/dashboardReads'
import { ALL_TIME_RANGE, rangeFromParam, rangeToParam, presetRanges } from '../lib/leads'
import type { DateRange } from '../lib/leads'
import type {
  OverviewAccountCampaigns,
  OverviewPerformance,
  OverviewSystemTotals,
} from '../lib/types'
import { OverviewAnalytics } from '../components/overview/OverviewAnalytics'
import { LinkButton, PageHeader } from '../ui'

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

export function Overview() {
  const { data } = useData()
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
  // Campaigns waits for the first critical read to settle. This is a one-way
  // latch: once Overview has yielded a connection, a later System or
  // Performance range change must not re-queue the Account analytics read.
  const [criticalSettled, setCriticalSettled] = useState(false)

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

  useEffect(() => {
    if (!ready) return
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
          setCriticalSettled(true)
        }
      })
    return () => controller.abort()
    // `systemRange` is read for its value; the attempt key controls refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, systemAttempt])

  useEffect(() => {
    if (!ready) return
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
          setCriticalSettled(true)
        }
      })
    return () => controller.abort()
    // `range` is read for its value; the attempt key controls refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, performanceAttempt])

  useEffect(() => {
    if (!ready || !criticalSettled) return
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
  }, [ready, criticalSettled, campaignsAttempt])

  const currentSystem = system?.key === systemKey ? system.value : null
  const currentPerformance = performance?.key === performanceKey ? performance.value : null
  const currentCampaigns = accountCampaigns?.key === campaignsKey ? accountCampaigns.value : null

  useEffect(() => {
    if (currentSystem) readyMark('system')
  }, [currentSystem, systemKey])
  useEffect(() => {
    if (currentPerformance) readyMark('performance')
  }, [currentPerformance, performanceKey])
  useEffect(() => {
    if (currentCampaigns) readyMark('campaigns')
  }, [currentCampaigns, campaignsKey])
  useEffect(() => {
    if (!currentSystem || !currentPerformance) return
    globalThis.performance.mark('dashboard_overview_useful')
    try {
      globalThis.performance.measure('dashboard_overview_useful_duration', 'dashboard_overview_system_start', 'dashboard_overview_useful')
    } catch { /* see readyMark */ }
  }, [currentSystem, currentPerformance, systemKey, performanceKey])
  useEffect(() => {
    if (!currentSystem || !currentPerformance || !currentCampaigns) return
    globalThis.performance.mark('dashboard_overview_interactive')
    try {
      globalThis.performance.measure('dashboard_overview_interactive_duration', 'dashboard_overview_system_start', 'dashboard_overview_interactive')
    } catch { /* see readyMark */ }
  }, [currentSystem, currentPerformance, currentCampaigns, systemKey, performanceKey, campaignsKey])

  if (!data) return null

  return (
    <div className="overview">
      <PageHeader
        title="Overview"
        description="Your whole outreach system, in one place."
        actions={<LinkButton variant="secondary" to="/sequences">Open sequences</LinkButton>}
      />
      <OverviewAnalytics
          system={currentSystem}
          performance={currentPerformance}
          accountCampaigns={currentCampaigns}
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
          systemLoading={systemLoading}
          performanceLoading={performanceLoading}
          accountCampaignsLoading={campaignsLoading}
          systemError={systemError}
          performanceError={performanceError}
          accountCampaignsError={campaignsError}
          onSystemRetry={() => setSystemRetry((value) => value + 1)}
          onPerformanceRetry={() => setPerformanceRetry((value) => value + 1)}
          onAccountCampaignsRetry={() => setCampaignsRetry((value) => value + 1)}
        />
    </div>
  )
}
