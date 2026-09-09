import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import { fetchNeonOverviewSummary, fetchNeonOverviewSystemTotals, resolveReadPath } from '../lib/dashboardReads'
import { ALL_TIME_RANGE, rangeFromParam, rangeToParam, presetRanges, rangedCampaigns } from '../lib/leads'
import { buildOverviewAnalytics } from '../lib/overviewAnalytics'
import type { DateRange } from '../lib/leads'
import type { CampaignMetrics, OverviewAnalytics as Analytics } from '../lib/types'
import { OverviewAnalytics } from '../components/overview/OverviewAnalytics'
import '../components/overview/overview-glass.css'

export function Overview() {
  const { data, phase } = useData()
  const [params, setParams] = useSearchParams()
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10))
  const [system, setSystem] = useState<Analytics | null>(null)
  const [performance, setPerformance] = useState<Analytics | null>(null)
  const [performanceCampaigns, setPerformanceCampaigns] = useState<CampaignMetrics[]>([])
  const [systemLoading, setSystemLoading] = useState(true)
  const [performanceLoading, setPerformanceLoading] = useState(true)
  const [systemError, setSystemError] = useState<string | null>(null)
  const [performanceError, setPerformanceError] = useState<string | null>(null)
  const [systemRetry, setSystemRetry] = useState(0)
  const [performanceRetry, setPerformanceRetry] = useState(0)
  const [readPath, setReadPath] = useState<'pending' | 'neon' | 'legacy' | 'error'>('pending')
  const [discoveryRetry, setDiscoveryRetry] = useState(0)
  const legacy = readPath === 'legacy'

  useEffect(() => {
    const timer = setInterval(() => setToday(new Date().toISOString().slice(0, 10)), 60_000)
    return () => clearInterval(timer)
  }, [])

  const presets = useMemo(() => presetRanges(new Date(`${today}T12:00:00Z`)), [today])
  const range = useMemo(
    () => rangeFromParam(params.get('range'), presets) ?? presets[0],
    [params, presets],
  )
  const systemRange = useMemo(
    () => rangeFromParam(params.get('systemRange'), [ALL_TIME_RANGE, ...presets]) ?? ALL_TIME_RANGE,
    [params, presets],
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
  const setAccount = (next: string) => updateParam('account', next === 'all' ? null : next)

  useEffect(() => {
    let cancelled = false
    setReadPath('pending')
    resolveReadPath()
      .then(path => {
        if (!cancelled) setReadPath(path === 'neon' ? 'neon' : 'legacy')
      })
      .catch(() => {
        if (!cancelled) setReadPath('error')
      })
    return () => { cancelled = true }
  }, [data, discoveryRetry])

  useEffect(() => {
    if (!data || readPath !== 'neon') return
    let cancelled = false
    setSystemLoading(true)
    setSystemError(null)
    setSystem(null)
    fetchNeonOverviewSystemTotals(systemRange)
      .then(totals => {
        if (cancelled) return
        setSystem({ totals, previous: null, lifetime: totals, accounts: [], activity: [] })
        globalThis.performance.mark('dashboard_overview_system_available')
      })
      .catch(error => {
        if (!cancelled) setSystemError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setSystemLoading(false)
      })
    return () => { cancelled = true }
  }, [data, readPath, systemRange.from, systemRange.to, systemRetry])

  useEffect(() => {
    if (!data || readPath !== 'neon') return
    let cancelled = false
    setPerformanceLoading(true)
    setPerformanceError(null)
    setPerformance(null)
    setPerformanceCampaigns([])
    fetchNeonOverviewSummary(range)
      .then(summary => {
        if (cancelled) return
        if (!summary.analytics) throw new Error('Performance analytics are unavailable')
        setPerformance(summary.analytics)
        setPerformanceCampaigns(summary.campaigns ?? [])
        globalThis.performance.mark('dashboard_overview_performance_available')
      })
      .catch(error => {
        if (!cancelled) setPerformanceError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setPerformanceLoading(false)
      })
    return () => { cancelled = true }
  }, [data, readPath, range.from, range.to, performanceRetry])

  useEffect(() => {
    if (readPath === 'neon' && system && performance) {
      globalThis.performance.mark('dashboard_overview_useful')
      requestAnimationFrame(() => globalThis.performance.mark('dashboard_overview_interactive'))
    }
  }, [readPath, system, performance])

  const fallback = useMemo(() => {
    if (!legacy || phase !== 'full' || !data) return null
    const systemAnalytics = buildOverviewAnalytics(data.leads, systemRange)
    const performanceAnalytics = buildOverviewAnalytics(data.leads, range)
    const lifetime = new Map(rangedCampaigns(data.leads, data.campaigns, ALL_TIME_RANGE).map(c => [c.campaign_id, c]))
    const campaigns = rangedCampaigns(data.leads, data.campaigns, range).map(c => ({
      ...c,
      lifetime_acceptance_rate: lifetime.get(c.campaign_id)?.acceptance_rate,
      lifetime_reply_rate: lifetime.get(c.campaign_id)?.reply_rate,
    }))
    return { systemAnalytics, performanceAnalytics, campaigns }
  }, [legacy, phase, data, range, systemRange])

  if (!data) return null

  const mergedCampaigns = data.campaigns.map(base => {
    const measured = performanceCampaigns.find(row => row.campaign_id === base.campaign_id)
    return measured ?? {
      ...base,
      invites_sent: 0,
      accepted: 0,
      replies: 0,
      lifetime_acceptance_rate: null,
      lifetime_reply_rate: null,
    }
  })
  for (const measured of performanceCampaigns) {
    if (!mergedCampaigns.some(row => row.campaign_id === measured.campaign_id)) mergedCampaigns.push(measured)
  }

  const props = legacy && fallback
    ? { system: fallback.systemAnalytics, performance: fallback.performanceAnalytics, campaigns: fallback.campaigns, instances: data.instances }
    : { system, performance, campaigns: mergedCampaigns, instances: data.instances }

  return (
    <div className="overview-glass">
      <header className="sa-header">
        <div><h1>Overview</h1><p className="sa-muted">Your whole outreach system, in one place.</p></div>
        <Link className="link-btn" to="/sequences">Open sequences</Link>
      </header>
      {readPath === 'error' ? (
        <div className="card error-state" role="alert">
          <strong>Analytics could not determine its data source.</strong>
          <button onClick={() => setDiscoveryRetry(value => value + 1)}>Try again</button>
        </div>
      ) : (
        <OverviewAnalytics
          {...props}
          systemRange={systemRange}
          range={range}
          presets={presets}
          account={account}
          onSystemRangeChange={setSystemRange}
          onRangeChange={setRange}
          onAccountChange={setAccount}
          systemLoading={readPath === 'pending' || (legacy && !fallback) ? true : legacy ? false : systemLoading}
          performanceLoading={readPath === 'pending' || (legacy && !fallback) ? true : legacy ? false : performanceLoading}
          systemError={legacy ? null : systemError}
          performanceError={legacy ? null : performanceError}
          onSystemRetry={() => setSystemRetry(value => value + 1)}
          onPerformanceRetry={() => setPerformanceRetry(value => value + 1)}
        />
      )}
    </div>
  )
}
