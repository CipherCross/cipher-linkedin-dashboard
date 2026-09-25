import { useEffect, useMemo, useState } from 'react'
import { EyeOff, SearchX } from 'lucide-react'
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
import { AXIS, GRID, NO_ANIM, SERIES, TOOLTIP } from '../chartTheme'
import { DateRangePicker } from '../DateRangePicker'
import { Skeleton } from '../Skeleton'
import { RowOpenButton } from '../RowOpenButton'
import { CampaignPreviewDialog } from './CampaignPreviewDialog'
import { useCampaignPreview } from '../../lib/campaignPreview'
import { useConversation } from '../../lib/ConversationContext'
import type { DateRange } from '../../lib/leads'
import { accountLabeller } from '../../lib/leads'
import { comparisonLabel, num, pct, rate, shortDate } from '../../lib/format'
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
  EmptyState,
  InlineError,
  InitialsBadge,
  Panel,
  SectionHeader,
  SelectField,
  SortHeader,
  Table,
  TableFrame,
  TableToolbar,
  UpdatingNote,
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
const chartColors = { invited: SERIES.invite, connected: SERIES.accepted, replied: SERIES.reply } as const
const MUTED = 'text-app-text-muted text-app-meta'

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
    <div className="ov-performance" role="status" aria-label="Loading performance analytics">
      <div>
        <div className="flex gap-app-xl flex-wrap mt-0 mx-0 mb-group">
          {Array.from({ length: 3 }).map((_, index) => (
            <div className="ov-metric ov-loading-card" key={index}>
              <Skeleton width={72} height={11} />
              <Skeleton width={64} height={31} />
              <Skeleton width={150} height={10} />
              {index !== 0 && <Skeleton width={180} height={10} />}
            </div>
          ))}
        </div>
        <Skeleton width="100%" height={280} radius={16} />
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
    <div className="ov-tablewrap overflow-hidden" role="status" aria-label="Loading account analytics">
      <div className="ov-loading-table-head">
        {Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} width="100%" height={12} />)}
      </div>
      {Array.from({ length: 4 }).map((_, row) => (
        <div className="ov-loading-table-row" key={row}>
          <span className="flex items-center gap-app-sm"><Skeleton width={32} height={32} radius="50%" /><Skeleton width={112} height={13} /></span>
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

const HIDDEN_CAMPAIGNS_KEY = 'overview.hiddenCampaignIds.v1'

function readHiddenCampaignIds(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(HIDDEN_CAMPAIGNS_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function accountName(instance: Instance | undefined, fallback: string): string {
  return instance?.account_name?.trim() || fallback
}

function AccountCell({ instance, fallback }: { instance: Instance | undefined; fallback: string }) {
  const name = accountName(instance, fallback)
  const avatar = instance?.account_avatar
    ? <span className="ov-avatar" aria-hidden="true"><img src={instance.account_avatar} alt="" /></span>
    : <InitialsBadge name={name} />
  return <AccountIdentity name={name} avatar={avatar} title={name} />
}

function syncAgeLabel(timestamp: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60_000))
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

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

function sortableHeader(key: CampaignSortKey, label: string, sort: SortState, onSort: (key: CampaignSortKey) => void, numeric = false) {
  return (
    <SortHeader
      key={key}
      label={label}
      active={sort.key === key}
      direction={sort.direction}
      onSort={() => onSort(key)}
      className={numeric ? 'ui-table__num' : undefined}
    />
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
  const preview = useCampaignPreview()
  const { openConversation } = useConversation()
  const [showArchived, setShowArchived] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(readHiddenCampaignIds)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
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
  const displayed = useMemo(() => {
    const rows = eligible.filter((campaign) => hiddenIds.has(campaign.campaign_id) === showHidden)
    return rows.sort((a, b) => {
      const av = compareValue(a, sort.key, accountLabel)
      const bv = compareValue(b, sort.key, accountLabel)
      const primary = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : Number(av) - Number(bv)
      if (primary) return sort.direction === 'asc' ? primary : -primary
      return accountLabel(a.instance_id).localeCompare(accountLabel(b.instance_id)) ||
        a.campaign_name.localeCompare(b.campaign_name) || a.campaign_id.localeCompare(b.campaign_id)
    })
  }, [eligible, hiddenIds, showHidden, sort, accountLabel])
  const pages = Math.max(1, Math.ceil(displayed.length / 20))
  const pageIndex = Math.min(page, pages - 1)
  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(0, Math.ceil(displayed.length / 20) - 1)))
  }, [displayed.length])
  useEffect(() => setPage(0), [account, showArchived, showHidden, campaigns])
  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_CAMPAIGNS_KEY, JSON.stringify([...hiddenIds]))
    } catch {
      // Keep the table usable when browser storage is unavailable.
    }
  }, [hiddenIds])
  useEffect(() => setSelectedIds(new Set()), [account, showArchived, showHidden, pageIndex])
  const setSortKey = (key: CampaignSortKey) => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'account' || key === 'campaign' ? 'asc' : 'desc' })
    setPage(0)
  }
  const instanceFor = (id: string) => instances.find((instance) => instance.id === id)
  const apiEmpty = eligible.length === 0
  const clientEmpty = !apiEmpty && displayed.length === 0
  const pageRows = displayed.slice(pageIndex * 20, pageIndex * 20 + 20)
  const allPageSelected = pageRows.length > 0 && pageRows.every((campaign) => selectedIds.has(campaign.campaign_id))
  const togglePage = () => setSelectedIds((current) => {
    const next = new Set(current)
    if (allPageSelected) pageRows.forEach((campaign) => next.delete(campaign.campaign_id))
    else pageRows.forEach((campaign) => next.add(campaign.campaign_id))
    return next
  })
  const applySelection = () => {
    setHiddenIds((current) => {
      const next = new Set(current)
      selectedIds.forEach((id) => showHidden ? next.delete(id) : next.add(id))
      return next
    })
    setSelectedIds(new Set())
  }

  const open = (campaign: CampaignMetrics) => preview.open({
    campaignId: campaign.campaign_id,
    campaignName: campaign.campaign_name,
    instanceId: campaign.instance_id,
  })
  const toggleOne = (id: string) => setSelectedIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <div className="mt-section">
      <SectionHeader level="subsection" title="Campaign comparison" />
      <TableFrame
        className="ov-campaign-frame"
        scrollLabel="Campaign comparison table"
        hint="Scroll horizontally for all campaign metrics."
        toolbar={(
          <TableToolbar count={`${displayed.length} ${showHidden ? 'hidden ' : ''}campaigns`} actions={(
            <>
              {selectedIds.size > 0 && <Button variant={showHidden ? 'secondary' : 'danger'} size="sm" onClick={applySelection}>{showHidden ? 'Restore' : 'Remove'} selected ({selectedIds.size})</Button>}
              {(showHidden || hiddenCount > 0) && <Button variant="ghost" size="sm" onClick={() => setShowHidden((value) => !value)}>{showHidden ? 'Show active' : `Show removed (${hiddenCount})`}</Button>}
              <Checkbox label="Show archived" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
            </>
          )} />
        )}
      >
        {apiEmpty ? (
          <EmptyState icon={SearchX} title="No campaigns are available for this scope." />
        ) : clientEmpty ? (
          <EmptyState
            kind="no-match"
            icon={EyeOff}
            title={showHidden ? 'No removed campaigns match this scope.' : 'All campaigns are removed from comparison.'}
            hint={showHidden ? undefined : 'Show removed in the toolbar brings them back.'}
          />
        ) : (
          <Table caption="Campaign comparison">
            <thead>
              <tr>
                <th className="ui-table__select" scope="col">
                  <Checkbox label={<span className="sr-only">Select all campaigns on this page</span>} checked={allPageSelected} onChange={togglePage} />
                </th>
                {sortableHeader('account', 'Account', sort, setSortKey)}
                {sortableHeader('campaign', 'Campaign', sort, setSortKey)}
                {sortableHeader('invited', 'Invited', sort, setSortKey, true)}
                {sortableHeader('acceptance', 'Acceptance rate', sort, setSortKey, true)}
                {sortableHeader('reply', 'Reply rate', sort, setSortKey, true)}
                {sortableHeader('connected', 'Connected', sort, setSortKey, true)}
                {sortableHeader('first_messages', 'First messages', sort, setSortKey, true)}
                {sortableHeader('first_replies', 'First replies', sort, setSortKey, true)}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((campaign) => {
                const instance = instanceFor(campaign.instance_id)
                return (
                  // The row opens the campaign preview. RowOpenButton is the keyboard
                  // and screen-reader path; a pointer click focuses it first so the
                  // dialog returns focus to this row when it closes.
                  <tr
                    key={campaign.campaign_id}
                    className="relative cursor-pointer"
                    onClick={(event) => {
                      event.currentTarget.querySelector<HTMLButtonElement>('[data-row-open]')?.focus({ preventScroll: true })
                      open(campaign)
                    }}
                  >
                    <td className="ui-table__select" onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        label={<span className="sr-only">Select {campaign.campaign_name}</span>}
                        checked={selectedIds.has(campaign.campaign_id)}
                        onChange={() => toggleOne(campaign.campaign_id)}
                      />
                    </td>
                    <td>
                      <AccountCell instance={instance} fallback={accountLabel(campaign.instance_id)} />
                    </td>
                    <td className="max-w-[260px] overflow-hidden text-ellipsis text-app-text" title={campaign.campaign_name}>
                      <RowOpenButton label={`Preview ${campaign.campaign_name}`} onOpen={() => open(campaign)} />
                      {campaign.campaign_name}
                    </td>
                    <td className="ui-table__num">{num(campaign.invites_sent)}</td>
                    <td className="ui-table__num">{rate(campaign.lifetime_acceptance_rate)}</td>
                    <td className="ui-table__num">{rate(campaign.lifetime_reply_rate)}</td>
                    <td className="ui-table__num">{num(campaign.connected ?? campaign.accepted)}</td>
                    <td className="ui-table__num">{num(campaign.first_messages ?? 0)}</td>
                    <td className="ui-table__num">{num(campaign.replies)}</td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </TableFrame>
      <div className={`flex justify-between items-center gap-group flex-wrap mt-app-sm ${MUTED}`}>
        <span>{displayed.length} campaigns</span>
        <span className="flex items-center gap-app-sm">
          <Button variant="secondary" size="sm" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>Previous campaigns</Button>
          Page {pageIndex + 1} of {pages}
          <Button variant="secondary" size="sm" disabled={pageIndex + 1 >= pages} onClick={() => setPage(pageIndex + 1)}>Next campaigns</Button>
        </span>
      </div>
      {preview.state.status !== 'closed' && (
        <CampaignPreviewDialog
          state={preview.state}
          accountName={accountLabel(preview.state.instanceId)}
          onClose={preview.close}
          onRetry={preview.retry}
          onOpenLead={(lead) => openConversation(lead)}
        />
      )}
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
  const accountSortHeader = (key: typeof accountSort, label: string) => (
    <SortHeader
      label={label}
      active={accountSort === key}
      direction={accountSortDirection}
      onSort={() => setAccountSortKey(key)}
      className={key === 'name' ? undefined : 'ui-table__num'}
    />
  )
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

  const accountDescription = `${account === 'all' ? '' : 'Campaigns · '}${accountRange.label} counts and rates${accountRange.from || accountRange.to ? ' · UTC' : ''}${incompleteAccountToday ? ' · Today is in progress' : ''}`

  return (
    <>
      <Panel aria-labelledby="overview-system-title" aria-busy={systemLoading}>
        <SectionHeader
          id="overview-system-title"
          title="System totals"
          description={systemSubtitle}
          actions={(
            <>
              {systemLoading && system && <UpdatingNote />}
              <DateRangePicker ariaLabel="System totals date range" presets={presets} value={systemRange} onChange={onSystemRangeChange} />
            </>
          )}
        />
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
      </Panel>

      <Panel aria-labelledby="overview-performance-title" aria-busy={performanceLoading}>
        <SectionHeader
          id="overview-performance-title"
          title="Performance"
          description={`${range.label} · UTC${incompleteToday ? ' · Today is in progress' : ''}`}
          actions={(
            <>
              {performanceLoading && performance && <UpdatingNote />}
              <SelectField
                label="Account"
                labelHidden
                aria-label="Performance account"
                className="min-w-[200px]"
                value={account}
                onChange={(event) => onAccountChange(event.target.value)}
              >
                <option value="all">All accounts</option>
                {instances.map((instance) => <option key={instance.id} value={instance.id}>{accountLabel(instance.id)}</option>)}
              </SelectField>
              <DateRangePicker ariaLabel="Performance date range" presets={presets} value={range} onChange={onRangeChange} />
            </>
          )}
        />
        {performanceLoading && !performance ? <PerformanceLoading /> : performanceError ? (
          <InlineError title="Performance analytics could not load." detail={performanceError} onRetry={onPerformanceRetry} />
        ) : performance && accountDataAvailable ? (
          <div className="ov-performance">
            <div>
              <div className="flex gap-app-xl flex-wrap mt-0 mx-0 mb-group">
                {(['invited', 'connected', 'replied'] as const).map((key) => (
                  <div className="ov-metric" key={key}>
                    <span className="ov-dot" style={{ background: chartColors[key] }} aria-hidden="true" />
                    <span className="ov-metric__label">{metricLabels[key]}</span>
                    <strong>{num(currentTotals[key])}</strong>
                    <span>{comparisonLabel(currentTotals[key], previousTotals?.[key] ?? null, range)}</span>
                    {key === 'connected' && <small>Acceptance <b>{pct(selectedCohort.connected, selectedCohort.invited)}</b></small>}
                    {key === 'replied' && <small>Reply rate <b>{pct(selectedCohort.replied, selectedCohort.connected)}</b></small>}
                  </div>
                ))}
              </div>
              <div className="ov-plot" role="img" aria-label={`${weeklyChart ? 'Weekly' : 'Daily'} invited, connected and first replies for ${range.label}`}>
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={chart}>
                    <Area type="linear" dataKey="invited" stroke="none" fill={chartColors.invited} fillOpacity={0.08} tooltipType="none" {...NO_ANIM} />
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="day" {...AXIS} tickFormatter={(day: string) => weeklyChart ? `Week of ${day}` : shortDate(day)} />
                    <YAxis allowDecimals={false} {...AXIS} />
                    <Tooltip {...TOOLTIP} labelFormatter={(day) => weeklyChart ? `Week of ${String(day)}` : shortDate(String(day))} />
                    <Line dataKey="invited" name="Invited" stroke={chartColors.invited} strokeWidth={2.5} dot={false} {...NO_ANIM} />
                    <Line dataKey="connected" name="Connected" stroke={chartColors.connected} strokeWidth={2.5} dot={false} {...NO_ANIM} />
                    <Line dataKey="replied" name="First replies" stroke={chartColors.replied} strokeWidth={2.5} dot={false} {...NO_ANIM} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
            <aside className="ov-rates" aria-labelledby="overview-rates-title">
              <h3 id="overview-rates-title">All-time conversion</h3>
              <div className="ov-rate"><span>Acceptance rate</span><strong>{pct(lifetime.connected, lifetime.invited)}</strong></div>
              <div className="ov-rate"><span>Reply rate</span><strong>{pct(lifetime.replied, lifetime.connected)}</strong></div>
            </aside>
          </div>
        ) : <p role="status" className={MUTED}>{account === 'all' ? 'Performance data unavailable. Try refreshing the performance range.' : 'This account has no performance data for the selected range. Select another account or refresh.'}</p>}
      </Panel>

      <Panel aria-labelledby="overview-account-title" aria-busy={accountCampaignsLoading}>
        <SectionHeader
          id="overview-account-title"
          title={account === 'all' ? 'Account analytics' : `${accountLabel(account)} campaigns`}
          description={accountDescription}
          actions={(
            <>
              {accountCampaignsLoading && accountCampaigns && <UpdatingNote />}
              <DateRangePicker ariaLabel="Account analytics date range" presets={accountPresets} value={accountRange} onChange={onAccountRangeChange} />
              {account !== 'all' && <Button variant="secondary" size="sm" onClick={() => onAccountChange('all')}>← All accounts</Button>}
            </>
          )}
        />
        {accountCampaignsLoading && !accountCampaigns ? <AccountTableLoading /> : accountCampaignsError ? (
          <InlineError title="Account analytics could not load." detail={accountCampaignsError} onRetry={onAccountCampaignsRetry} />
        ) : !accountCampaigns ? <p className={MUTED}>Account analytics data is unavailable.</p> : (
          <>
            {account === 'all' ? (
              <>
                <TableFrame className="ov-account-frame" scrollLabel="Account analytics table">
                  <Table caption="Account analytics">
                    <thead>
                      <tr>
                        {accountSortHeader('name', 'Account')}
                        {accountSortHeader('invited', 'Invited')}
                        {accountSortHeader('connected', 'Connected')}
                        {accountSortHeader('replied', 'First replies')}
                        <th scope="col" className="ui-table__num">Acceptance rate</th>
                        <th scope="col" className="ui-table__num">Reply rate</th>
                        <th scope="col">Last sync</th>
                      </tr>
                    </thead>
                    <tbody>{accountRows.slice(accountPageIndex * 20, accountPageIndex * 20 + 20).map((instance) => {
                      const row = accountCampaigns.accounts.find((item) => item.instance_id === instance.id)
                      const totals = row?.totals ?? zeroTotals()
                      const syncOverdue = !instance.last_sync_at || Date.now() - new Date(instance.last_sync_at).getTime() > 3 * 3_600_000
                      return (
                        <tr key={instance.id} className="ui-table__row--identity">
                          <td>
                            <Button
                              variant="ghost"
                              className="px-0 font-normal justify-start"
                              aria-label={accountName(instance, accountLabel(instance.id))}
                              onClick={() => onAccountChange(instance.id)}
                            >
                              <AccountCell instance={instance} fallback={accountLabel(instance.id)} />
                            </Button>
                          </td>
                          <td className="ui-table__num">{num(totals.invited)}</td>
                          <td className="ui-table__num">{num(totals.connected)}</td>
                          <td className="ui-table__num">{num(totals.replied)}</td>
                          <td className="ui-table__num">{pct(totals.acceptedOfInvited, totals.invited)}</td>
                          <td className="ui-table__num">{pct(totals.repliedOfConnected, totals.connected)}</td>
                          <td>{instance.last_sync_at ? <span className={syncOverdue ? 'text-app-danger font-semibold' : undefined} title={new Date(instance.last_sync_at).toLocaleString()}>{syncAgeLabel(instance.last_sync_at)}{syncOverdue && ' · Not OK'}</span> : <span className="text-app-danger font-semibold" title="No successful sync recorded">Unknown · Not OK</span>}</td>
                        </tr>
                      )
                    })}</tbody>
                  </Table>
                </TableFrame>
                <div className={`flex justify-between items-center gap-group flex-wrap mt-app-sm ${MUTED}`}>
                  <span>{accountRange.label} account counts and rates · rates use invited → connected and connected → replies</span>
                  <span className="flex items-center gap-app-sm">
                    {accountRows.length > 20 && (
                      <>
                        <Button variant="secondary" size="sm" disabled={accountPageIndex === 0} onClick={() => setAccountPage(accountPageIndex - 1)}>Previous accounts</Button>
                        Page {accountPageIndex + 1} of {accountPages}
                        <Button variant="secondary" size="sm" disabled={accountPageIndex + 1 >= accountPages} onClick={() => setAccountPage(accountPageIndex + 1)}>Next accounts</Button>
                        {' · '}
                      </>
                    )}
                    Freshness is shown from each account’s last sync
                  </span>
                </div>
              </>
            ) : selected ? (
              <div className="pt-section border-t border-app-border" aria-label={`${accountRange.label} account totals`}>
                <SectionHeader
                  level="subsection"
                  title={`${accountRange.label} account totals`}
                  description={`Selected account${accountRange.from || accountRange.to ? ' · UTC' : ''}`}
                />
                <div className="ov-details">
                  {[['Leads', 'leads'], ['Invited', 'invited'], ['Connected', 'connected'], ['Messaged', 'messaged'], ['Replied', 'replied']].map(([label, key]) => (
                    <div key={key}><strong>{num((selectedAccount?.totals ?? zeroTotals())[key as keyof ReturnType<typeof zeroTotals>] as number)}</strong><span>{label}</span></div>
                  ))}
                </div>
              </div>
            ) : (
              <p role="alert" className={MUTED}>
                Account not found. <Button variant="ghost" size="sm" onClick={() => onAccountChange('all')}>Back to all accounts</Button>
              </p>
            )}
            <CampaignComparison campaigns={accountCampaigns.campaigns} account={account} accountLabel={accountLabel} instances={instances} />
          </>
        )}
      </Panel>
    </>
  )
}
