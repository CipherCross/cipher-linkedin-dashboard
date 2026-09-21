import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { DateRangePicker } from '../DateRangePicker'
import { Skeleton } from '../Skeleton'
import type { DateRange } from '../../lib/leads'
import { accountLabeller } from '../../lib/leads'
import { ago, comparisonLabel, num, pct, rate, shortDate } from '../../lib/format'
import { freshnessLevel } from '../../lib/freshness'
import type {
  CampaignMetrics,
  Instance,
  OverviewAccountCampaigns,
  OverviewCohortTotals,
  OverviewPerformance,
  OverviewSystemTotals,
} from '../../lib/types'
import {
  AccountIdentity,
  Button,
  Checkbox,
  IconButton,
  InlineError,
  Table,
  TableFrame,
  TableToolbar,
} from '../../ui'

type Props = {
  system: OverviewSystemTotals | null
  performance: OverviewPerformance | null
  accountCampaigns: OverviewAccountCampaigns | null
  instances: Instance[]
  systemRange: DateRange
  range: DateRange
  accountRange: DateRange
  presets: DateRange[]
  accountPresets: DateRange[]
  account: string
  onSystemRangeChange: (range: DateRange) => void
  onRangeChange: (range: DateRange) => void
  onAccountRangeChange: (range: DateRange) => void
  onAccountChange: (id: string) => void
  systemLoading: boolean
  performanceLoading: boolean
  accountCampaignsLoading: boolean
  systemError: string | null
  performanceError: string | null
  accountCampaignsError: string | null
  onSystemRetry: () => void
  onPerformanceRetry: () => void
  onAccountCampaignsRetry: () => void
}

const zeroTotals = () => ({
  leads: 0,
  invited: 0,
  connected: 0,
  messaged: 0,
  replied: 0,
  acceptedOfInvited: 0,
  repliedOfConnected: 0,
})
const zeroCohort = (): OverviewCohortTotals => ({ leads: 0, invited: 0, connected: 0, messaged: 0, replied: 0 })
const metricLabels = { invited: 'Invited', connected: 'Connected', replied: 'First replies' } as const
const chartColors = { invited: 'var(--accent)', connected: 'var(--success)', replied: 'var(--warning)' } as const

function SystemTotalsLoading() {
  return (
    <div className="ov-summary-grid ov-loading-grid" role="status" aria-label="Loading system totals">
      {Array.from({ length: 5 }).map((_, index) => (
        <div className="ov-total ov-loading-card" key={index}>
          <Skeleton width="52%" height={15} />
          <Skeleton width="38%" height={40} />
          <Skeleton width="64%" height={18} />
        </div>
      ))}
    </div>
  )
}

function PerformanceLoading() {
  return (
    <div className="ov-performance ov-loading-performance" role="status" aria-label="Loading performance analytics">
      <div>
        <div className="ov-metrics">
          {Array.from({ length: 3 }).map((_, index) => (
            <div className="ov-metric ov-loading-card" key={index}>
              <Skeleton width={72} height={11} />
              <Skeleton width={64} height={31} />
              <Skeleton width={150} height={10} />
              {index !== 0 && <Skeleton width={180} height={10} />}
            </div>
          ))}
        </div>
        <Skeleton className="ov-loading-chart" width="100%" height={280} radius={16} />
      </div>
      <aside className="ov-rates ov-loading-card">
        <Skeleton width={130} height={16} />
        <Skeleton width="100%" height={82} radius={12} />
        <Skeleton width="100%" height={82} radius={12} />
      </aside>
    </div>
  )
}

function AccountTableLoading() {
  return (
    <div className="ov-tablewrap ov-loading-table" role="status" aria-label="Loading account analytics">
      <div className="ov-loading-table-head">
        {Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} width="100%" height={12} />)}
      </div>
      {Array.from({ length: 4 }).map((_, row) => (
        <div className="ov-loading-table-row" key={row}>
          <span className="ov-loading-account"><Skeleton width={32} height={32} radius="50%" /><Skeleton width={112} height={13} /></span>
          {Array.from({ length: 6 }).map((__, column) => <Skeleton key={column} width={column > 3 ? 58 : 34} height={12} />)}
        </div>
      ))}
    </div>
  )
}

function chartRows(performance: OverviewPerformance | null, range: DateRange, account: string) {
  if (!performance) return []
  const rows = new Map<string, { day: string; invited: number; connected: number; replied: number }>()
  for (const item of performance.activity) {
    if (account !== 'all' && item.instance_id !== account) continue
    if (!['invited', 'connected', 'replied'].includes(item.event_type)) continue
    if ((range.from && item.day < range.from) || (range.to && item.day > range.to)) continue
    const row = rows.get(item.day) ?? { day: item.day, invited: 0, connected: 0, replied: 0 }
    row[item.event_type as 'invited' | 'connected' | 'replied'] += item.cnt
    rows.set(item.day, row)
  }
  if (range.from && range.to) {
    const days: string[] = []
    const cursor = new Date(`${range.from}T00:00:00Z`)
    const end = new Date(`${range.to}T00:00:00Z`)
    while (cursor <= end && days.length <= 366) {
      days.push(cursor.toISOString().slice(0, 10))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    if (days.length <= 366) return days.map((day) => rows.get(day) ?? { day, invited: 0, connected: 0, replied: 0 })
  }
  const rowDays = [...rows.keys()].sort()
  const spanDays = rowDays.length > 1
    ? Math.floor((Date.parse(`${rowDays[rowDays.length - 1]}T00:00:00Z`) - Date.parse(`${rowDays[0]}T00:00:00Z`)) / 86_400_000) + 1
    : 0
  if ((!range.from && !range.to && spanDays <= 366) || (range.from && range.to &&
    Math.floor((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1 <= 366)) {
    return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day))
  }
  const buckets = new Map<string, { day: string; invited: number; connected: number; replied: number }>()
  for (const row of rows.values()) {
    const date = new Date(`${row.day}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    const day = date.toISOString().slice(0, 10)
    const bucket = buckets.get(day) ?? { day, invited: 0, connected: 0, replied: 0 }
    bucket.invited += row.invited
    bucket.connected += row.connected
    bucket.replied += row.replied
    buckets.set(day, bucket)
  }
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day))
}

function chartUsesWeeklyBuckets(performance: OverviewPerformance | null, range: DateRange, account: string) {
  if (!performance) return false
  if (range.from && range.to) {
    return (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 + 1 > 366
  }
  const days = performance.activity
    .filter((item) => account === 'all' || item.instance_id === account)
    .map((item) => item.day)
    .filter((day) => (!range.from || day >= range.from) && (!range.to || day <= range.to))
    .sort()
  return days.length > 1 && (Date.parse(`${days[days.length - 1]}T00:00:00Z`) - Date.parse(`${days[0]}T00:00:00Z`)) / 86_400_000 + 1 > 366
}

type CampaignSortKey = 'account' | 'campaign' | 'invited' | 'connected' | 'first_messages' | 'first_replies' | 'acceptance' | 'reply'
type SortState = { key: CampaignSortKey; direction: 'asc' | 'desc' }

function compareValue(campaign: CampaignMetrics, key: CampaignSortKey, accountLabel: (id: string) => string): string | number {
  switch (key) {
    case 'account': return accountLabel(campaign.instance_id)
    case 'campaign': return campaign.campaign_name
    case 'invited': return campaign.invites_sent
    case 'connected': return campaign.connected ?? campaign.accepted
    case 'first_messages': return campaign.first_messages ?? 0
    case 'first_replies': return campaign.replies
    case 'acceptance': return campaign.lifetime_acceptance_rate ?? -1
    case 'reply': return campaign.lifetime_reply_rate ?? -1
  }
}

function sortableHeader(key: CampaignSortKey, label: string, sort: SortState, onSort: (key: CampaignSortKey) => void) {
  const active = sort.key === key
  return (
    <th className="ov-sortable" {...(active ? { 'aria-sort': sort.direction === 'asc' ? 'ascending' : 'descending' } : {})}>
      <button type="button" onClick={() => onSort(key)} aria-label={`${label}, ${active ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'not sorted'}`}>
        {label}
      </button>
    </th>
  )
}

function CampaignComparison({
  campaigns,
  account,
  accountLabel,
  instances,
}: {
  campaigns: CampaignMetrics[]
  account: string
  accountLabel: (id: string) => string
  instances: Instance[]
}) {
  const [showArchived, setShowArchived] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<SortState>({ key: 'invited', direction: 'desc' })

  const accountScoped = useMemo(
    () => campaigns.filter((campaign) => account === 'all' || campaign.instance_id === account),
    [campaigns, account],
  )
  const eligible = useMemo(
    () => accountScoped.filter((campaign) => showArchived || campaign.is_archived !== true),
    [accountScoped, showArchived],
  )
  const hiddenCount = campaigns.reduce((count, campaign) => count + (hiddenIds.has(campaign.campaign_id) ? 1 : 0), 0)
  const visible = useMemo(() => {
    const rows = eligible.filter((campaign) => !hiddenIds.has(campaign.campaign_id))
    return rows.sort((a, b) => {
      const av = compareValue(a, sort.key, accountLabel)
      const bv = compareValue(b, sort.key, accountLabel)
      const primary = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : Number(av) - Number(bv)
      if (primary) return sort.direction === 'asc' ? primary : -primary
      return accountLabel(a.instance_id).localeCompare(accountLabel(b.instance_id)) ||
        a.campaign_name.localeCompare(b.campaign_name) || a.campaign_id.localeCompare(b.campaign_id)
    })
  }, [eligible, hiddenIds, sort, accountLabel])
  const pages = Math.max(1, Math.ceil(visible.length / 20))
  const pageIndex = Math.min(page, pages - 1)
  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(0, Math.ceil(visible.length / 20) - 1)))
  }, [visible.length])
  useEffect(() => setPage(0), [account, showArchived, campaigns])
  const setSortKey = (key: CampaignSortKey) => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'account' || key === 'campaign' ? 'asc' : 'desc' })
    setPage(0)
  }
  const instanceFor = (id: string) => instances.find((instance) => instance.id === id)
  const apiEmpty = eligible.length === 0
  const clientEmpty = !apiEmpty && visible.length === 0

  return (
    <div className="ov-campaign-comparison">
      <h3>Campaign comparison</h3>
      <TableFrame
        className="ov-campaign-frame"
        scrollLabel="Campaign comparison table"
        hint="Scroll horizontally for all campaign metrics."
        toolbar={(
          <TableToolbar count={`${visible.length} campaigns`} actions={(
            <>
              <Checkbox label="Show archived" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
              {hiddenIds.size > 0 && <span className="ov-muted">Hidden: {hiddenCount}</span>}
              {hiddenIds.size > 0 && <Button variant="ghost" size="sm" onClick={() => setHiddenIds(new Set())}>Restore all</Button>}
            </>
          )} />
        )}
      >
        {apiEmpty ? (
          <p className="ov-table-empty">No campaigns are available for this scope.</p>
        ) : clientEmpty ? (
          <div className="ov-table-empty">
            <p>All campaigns are hidden from comparison.</p>
            <Button variant="ghost" size="sm" onClick={() => setHiddenIds(new Set())}>Restore all</Button>
          </div>
        ) : (
          <Table caption="Campaign comparison">
            <thead>
              <tr>
                {sortableHeader('account', 'Account', sort, setSortKey)}
                {sortableHeader('campaign', 'Campaign', sort, setSortKey)}
                {sortableHeader('invited', 'Invited', sort, setSortKey)}
                {sortableHeader('connected', 'Connected', sort, setSortKey)}
                {sortableHeader('first_messages', 'First messages', sort, setSortKey)}
                {sortableHeader('first_replies', 'First replies', sort, setSortKey)}
                {sortableHeader('acceptance', 'Acceptance rate · lifetime', sort, setSortKey)}
                {sortableHeader('reply', 'Reply rate · lifetime', sort, setSortKey)}
                <th>Remove</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(pageIndex * 20, pageIndex * 20 + 20).map((campaign) => {
                const instance = instanceFor(campaign.instance_id)
                return (
                  <tr key={campaign.campaign_id}>
                    <td>
                      <AccountIdentity
                        name={accountLabel(campaign.instance_id)}
                        secondary={instance && instance.label !== accountLabel(campaign.instance_id) ? instance.label : undefined}
                        title={accountLabel(campaign.instance_id)}
                      />
                    </td>
                    <td className="ov-campaign-name" title={campaign.campaign_name}>{campaign.campaign_name}</td>
                    <td className="ui-table__num">{num(campaign.invites_sent)}</td>
                    <td className="ui-table__num">{num(campaign.connected ?? campaign.accepted)}</td>
                    <td className="ui-table__num">{num(campaign.first_messages ?? 0)}</td>
                    <td className="ui-table__num">{num(campaign.replies)}</td>
                    <td className="ui-table__num">{rate(campaign.lifetime_acceptance_rate)}</td>
                    <td className="ui-table__num">{rate(campaign.lifetime_reply_rate)}</td>
                    <td>
                      <IconButton
                        label={`Remove ${campaign.campaign_name} from comparison`}
                        icon={<X size={20} aria-hidden="true" />}
                        onClick={() => setHiddenIds((current) => new Set(current).add(campaign.campaign_id))}
                      />
                    </td>
                    <td><Link to={`/campaign/${encodeURIComponent(campaign.campaign_id)}`}>View leads</Link></td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </TableFrame>
      <div className="ov-bottom ov-campaign-footer">
        <span>{visible.length} campaigns</span>
        <span>
          <Button variant="secondary" size="sm" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>Previous campaigns</Button>{' '}
          Page {pageIndex + 1} of {pages}{' '}
          <Button variant="secondary" size="sm" disabled={pageIndex + 1 >= pages} onClick={() => setPage(pageIndex + 1)}>Next campaigns</Button>
        </span>
      </div>
    </div>
  )
}

export function OverviewAnalytics({
  system,
  performance,
  accountCampaigns,
  instances,
  systemRange,
  range,
  accountRange,
  presets,
  accountPresets,
  account,
  onSystemRangeChange,
  onRangeChange,
  onAccountRangeChange,
  onAccountChange,
  systemLoading,
  performanceLoading,
  accountCampaignsLoading,
  systemError,
  performanceError,
  accountCampaignsError,
  onSystemRetry,
  onPerformanceRetry,
  onAccountCampaignsRetry,
}: Props) {
  const accountLabel = useMemo(() => accountLabeller(instances), [instances])
  const selected = instances.find((item) => item.id === account)
  const selectedAccount = accountCampaigns?.accounts.find((item) => item.instance_id === account)
  // Performance reads only overview.performance. Account analytics carries its
  // own range, so borrowing its totals here would compare one range's counts
  // against another range's previous period.
  const selectedPerformance = performance?.accounts.find((item) => item.instance_id === account)
  const scopedPerformance = account === 'all' ? performance : selectedPerformance
  const currentTotals = scopedPerformance?.current ?? { invited: 0, connected: 0, replied: 0 }
  const previousTotals = scopedPerformance?.previous ?? null
  const selectedCohort = scopedPerformance?.cohort ?? zeroCohort()
  const lifetime = scopedPerformance?.lifetime ?? zeroCohort()
  const chart = useMemo(() => chartRows(performance, range, account), [performance, range, account])
  const weeklyChart = useMemo(() => chartUsesWeeklyBuckets(performance, range, account), [performance, range, account])
  const [accountSort, setAccountSort] = useState<'name' | 'invited' | 'connected' | 'replied'>('invited')
  const [accountSortDirection, setAccountSortDirection] = useState<'asc' | 'desc'>('desc')
  const [accountPage, setAccountPage] = useState(0)
  const accountRows = useMemo(() => [...instances].sort((a, b) => {
    const av = accountSort === 'name' ? accountLabel(a.id) : accountCampaigns?.accounts.find((item) => item.instance_id === a.id)?.totals[accountSort] ?? 0
    const bv = accountSort === 'name' ? accountLabel(b.id) : accountCampaigns?.accounts.find((item) => item.instance_id === b.id)?.totals[accountSort] ?? 0
    const primary = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : Number(av) - Number(bv)
    return (accountSortDirection === 'asc' ? primary : -primary) || a.id.localeCompare(b.id)
  }), [instances, accountCampaigns, accountLabel, accountSort, accountSortDirection])
  const accountPages = Math.max(1, Math.ceil(accountRows.length / 20))
  const accountPageIndex = Math.min(accountPage, accountPages - 1)
  const setAccountSortKey = (key: typeof accountSort) => {
    if (accountSort === key) setAccountSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc')
    else {
      setAccountSort(key)
      setAccountSortDirection(key === 'name' ? 'asc' : 'desc')
    }
    setAccountPage(0)
  }
  const accountSortHeader = (key: typeof accountSort, label: string) => {
    const active = accountSort === key
    return (
      <th className="ov-sortable" {...(active ? { 'aria-sort': accountSortDirection === 'asc' ? 'ascending' : 'descending' } : {})}>
        <button type="button" onClick={() => setAccountSortKey(key)} aria-label={`${label}, ${active ? accountSortDirection === 'asc' ? 'ascending' : 'descending' : 'not sorted'}`}>{label}</button>
      </th>
    )
  }
  const today = new Date().toISOString().slice(0, 10)
  const incompleteToday = range.to === today
  const incompleteAccountToday = accountRange.to === today
  const systemSubtitle = systemRange.from || systemRange.to
    ? `${systemRange.label} · Invite cohort · All accounts · UTC`
    : 'All time · Invite cohort · All accounts'
  // A rostered account with no performance row is a valid empty account, and a
  // failed Account analytics read must never blank out Performance.
  const accountDataAvailable = account === 'all' ? Boolean(performance) : Boolean(selected)

  useEffect(() => setAccountPage((current) => Math.min(current, accountPages - 1)), [accountPages])

  return (
    <>
      <section className="ov-summary" aria-labelledby="overview-system-title" aria-busy={systemLoading}>
        <div className="ov-row">
          <div><h2 id="overview-system-title">System totals</h2><p className="ov-muted">{systemSubtitle}</p></div>
          <div className="ov-controls">
            <label className="ov-muted">Dates<DateRangePicker ariaLabel="System totals date range" presets={presets} value={systemRange} onChange={onSystemRangeChange} /></label>
            {systemLoading && system && <span className="ov-muted" role="status">Refreshing…</span>}
          </div>
        </div>
        {systemLoading && !system ? <SystemTotalsLoading /> : systemError ? (
          <InlineError title="System totals could not load." detail={systemError} onRetry={onSystemRetry} />
        ) : system ? (
          <div className="ov-summary-grid">
            {([
              ['Leads', num(system.leads), systemRange.from || systemRange.to ? 'Added in selected range' : 'All leads'],
              ['Invited', num(system.invited), system.invited > 0 ? '100.0% of invited' : '—'],
              ['Connected', num(system.connected), system.invited > 0 ? `${pct(system.connected, system.invited)} of invited` : '—'],
              ['Messaged', num(system.messaged), system.connected > 0 ? `${pct(system.messaged, system.connected)} of connected` : '—'],
              ['Replied', num(system.replied), system.connected > 0 ? `${pct(system.replied, system.connected)} of connected` : '—'],
            ] as const).map(([label, value, detail]) => (
              <div className="ov-total" key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="ov-panel" aria-labelledby="overview-performance-title" aria-busy={performanceLoading}>
        <div className="ov-row">
          <div><h2 id="overview-performance-title">Performance</h2><p className="ov-muted">{range.label} · UTC{incompleteToday ? ' · Today is in progress' : ''}</p></div>
          <div className="ov-controls">
            <label className="ov-muted">Account<select aria-label="Performance account" value={account} onChange={(event) => onAccountChange(event.target.value)}><option value="all">All accounts</option>{instances.map((instance) => <option key={instance.id} value={instance.id}>{accountLabel(instance.id)}</option>)}</select></label>
            {performanceLoading && performance && <span className="ov-muted" role="status">Refreshing…</span>}
            <label className="ov-muted">Dates<DateRangePicker ariaLabel="Performance date range" presets={presets} value={range} onChange={onRangeChange} /></label>
          </div>
        </div>
        {performanceLoading && !performance ? <PerformanceLoading /> : performanceError ? (
          <InlineError title="Performance analytics could not load." detail={performanceError} onRetry={onPerformanceRetry} />
        ) : performance && accountDataAvailable ? (
          <div className="ov-performance">
            <div>
              <div className="ov-metrics">
                {(['invited', 'connected', 'replied'] as const).map((key) => (
                  <div className="ov-metric" key={key}>
                    <span className="ov-dot" style={{ color: chartColors[key] }} aria-hidden="true" />
                    <label>{metricLabels[key]}</label>
                    <strong>{num(currentTotals[key])}</strong>
                    <span>{comparisonLabel(currentTotals[key], previousTotals?.[key] ?? null, range)}</span>
                    {key === 'connected' && <small>Acceptance <b>{pct(selectedCohort.connected, selectedCohort.invited)}</b> · {num(selectedCohort.connected)} / {num(selectedCohort.invited)} invited</small>}
                    {key === 'replied' && <small>Reply rate <b>{pct(selectedCohort.replied, selectedCohort.connected)}</b> · {num(selectedCohort.replied)} / {num(selectedCohort.connected)} connected</small>}
                  </div>
                ))}
              </div>
              <div className="ov-plot" role="img" aria-label={`${weeklyChart ? 'Weekly' : 'Daily'} invited, connected and first replies for ${range.label}`}>
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={chart}>
                    <Area type="linear" dataKey="invited" stroke="none" fill={chartColors.invited} fillOpacity={0.08} tooltipType="none" isAnimationActive={false} />
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(day: string) => weeklyChart ? `Week of ${day}` : shortDate(day)} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip labelFormatter={(day) => weeklyChart ? `Week of ${String(day)}` : shortDate(String(day))} contentStyle={{ background: 'var(--surface-1)', border: '1px solid var(--border-strong)', borderRadius: 10, color: 'var(--text)' }} />
                    <Line dataKey="invited" name="Invited" stroke={chartColors.invited} strokeWidth={2.5} dot={false} isAnimationActive={false} />
                    <Line dataKey="connected" name="Connected" stroke={chartColors.connected} strokeWidth={2.5} dot={false} isAnimationActive={false} />
                    <Line dataKey="replied" name="First replies" stroke={chartColors.replied} strokeWidth={2.5} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
            <aside className="ov-rates"><h3>All-time conversion</h3><div className="ov-rate"><label>Acceptance rate</label><strong>{pct(lifetime.connected, lifetime.invited)}</strong><small>{num(lifetime.connected)} / {num(lifetime.invited)} invited</small></div><div className="ov-rate"><label>Reply rate</label><strong>{pct(lifetime.replied, lifetime.connected)}</strong><small>{num(lifetime.replied)} / {num(lifetime.connected)} connected</small></div></aside>
          </div>
        ) : <p role="status" className="ov-muted">{account === 'all' ? 'Performance data unavailable. Try refreshing the performance range.' : 'This account has no performance data for the selected range. Select another account or refresh.'}</p>}
      </section>

      <section className="ov-panel" aria-labelledby="overview-account-title" aria-busy={accountCampaignsLoading}>
        <div className="ov-row">
          <div><h2 id="overview-account-title">{account === 'all' ? 'Account analytics' : `${accountLabel(account)} campaigns`}</h2><p className="ov-muted">{account === 'all' ? `${accountRange.label} counts and rates${accountRange.from || accountRange.to ? ' · UTC' : ''}${incompleteAccountToday ? ' · Today is in progress' : ''}` : `Campaigns · ${accountRange.label} counts and rates${accountRange.from || accountRange.to ? ' · UTC' : ''}${incompleteAccountToday ? ' · Today is in progress' : ''}`}</p></div>
          <div className="ov-controls">{accountCampaignsLoading && accountCampaigns && <span className="ov-muted" role="status">Refreshing…</span>}<label className="ov-muted">Dates<DateRangePicker ariaLabel="Account analytics date range" presets={accountPresets} value={accountRange} onChange={onAccountRangeChange} /></label>{account !== 'all' && <Button variant="secondary" size="sm" onClick={() => onAccountChange('all')}>← All accounts</Button>}</div>
        </div>
        {accountCampaignsLoading && !accountCampaigns ? <AccountTableLoading /> : accountCampaignsError ? (
          <InlineError title="Account analytics could not load." detail={accountCampaignsError} onRetry={onAccountCampaignsRetry} />
        ) : !accountCampaigns ? <p className="ov-muted">Account analytics data is unavailable.</p> : (
          <>
            {account === 'all' ? (
              <>
                <TableFrame className="ov-account-frame" scrollLabel="Account analytics table">
                  <Table caption="Account analytics">
                    <thead><tr>{accountSortHeader('name', 'Account')}{accountSortHeader('invited', 'Invited')}{accountSortHeader('connected', 'Connected')}{accountSortHeader('replied', 'First replies')}<th>Acceptance rate</th><th>Reply rate</th><th>Last sync</th></tr></thead>
                    <tbody>{accountRows.slice(accountPageIndex * 20, accountPageIndex * 20 + 20).map((instance) => {
                      const row = accountCampaigns.accounts.find((item) => item.instance_id === instance.id)
                      const totals = row?.totals ?? zeroTotals()
                      return <tr key={instance.id}><td><button className="ov-name" type="button" aria-label={accountLabel(instance.id)} onClick={() => onAccountChange(instance.id)}><span className="ov-avatar" aria-hidden="true">{instance.account_avatar ? <img src={instance.account_avatar} alt="" /> : accountLabel(instance.id).slice(0, 2).toUpperCase()}</span><span>{accountLabel(instance.id)}{instance.account_name && instance.label !== instance.account_name && <small>{instance.label}</small>}</span></button></td><td className="ui-table__num">{num(totals.invited)}</td><td className="ui-table__num">{num(totals.connected)}</td><td className="ui-table__num">{num(totals.replied)}</td><td className="ui-table__num">{pct(totals.acceptedOfInvited, totals.invited)}</td><td className="ui-table__num">{pct(totals.repliedOfConnected, totals.connected)}</td><td>{instance.last_sync_at ? <span title={new Date(instance.last_sync_at).toLocaleString()}>{ago(instance.last_sync_at)} · {freshnessLevel(instance.last_sync_at)}</span> : <span title="No successful sync recorded">Unknown</span>}</td></tr>
                    })}</tbody>
                  </Table>
                </TableFrame>
                <div className="ov-bottom"><span>{accountRange.label} account counts and rates · rates use invited → connected and connected → replies</span><span>{accountRows.length > 20 && <><Button variant="secondary" size="sm" disabled={accountPageIndex === 0} onClick={() => setAccountPage(accountPageIndex - 1)}>Previous accounts</Button>{' '}Page {accountPageIndex + 1} of {accountPages}{' '}<Button variant="secondary" size="sm" disabled={accountPageIndex + 1 >= accountPages} onClick={() => setAccountPage(accountPageIndex + 1)}>Next accounts</Button>{' · '}</>}Freshness is shown from each account’s last sync</span></div>
              </>
            ) : selected ? (
              <div className="ov-detail" aria-label={`${accountRange.label} account totals`}><div className="ov-row"><h3>{accountRange.label} account totals</h3><span className="ov-muted">Selected account{accountRange.from || accountRange.to ? ' · UTC' : ''}</span></div><div className="ov-details">{[['Leads', 'leads'], ['Invited', 'invited'], ['Connected', 'connected'], ['Messaged', 'messaged'], ['Replied', 'replied']].map(([label, key]) => <div key={key}><strong>{num((selectedAccount?.totals ?? zeroTotals())[key as keyof ReturnType<typeof zeroTotals>] as number)}</strong><span>{label}</span></div>)}</div></div>
            ) : <p role="alert" className="ov-muted">Account not found. <Button variant="ghost" size="sm" onClick={() => onAccountChange('all')}>Back to all accounts</Button></p>}
            <CampaignComparison campaigns={accountCampaigns.campaigns} account={account} accountLabel={accountLabel} instances={instances} />
          </>
        )}
      </section>
    </>
  )
}
