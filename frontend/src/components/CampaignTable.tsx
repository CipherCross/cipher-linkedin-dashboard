import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { CampaignMetrics, Instance } from '../lib/types'
import { instanceName } from '../lib/leads'
import { ago, num, rate } from '../lib/format'
import {
  CAMPAIGN_RUNTIME_STATUSES,
  campaignRuntimeLabel,
  parseCampaignRuntimeStatus,
} from '../lib/campaignRuntime'
import { CampaignRuntimeStatusView } from './CampaignRuntimeStatus'

interface Props {
  campaigns: CampaignMetrics[]
  instances: Instance[]
  title?: string
}

type SortKey =
  | 'campaign_name' | 'total_leads' | 'invites_sent' | 'accepted'
  | 'acceptance_rate' | 'replies' | 'reply_rate' | 'last_activity_at'
  | 'runtime_status' | 'is_archived'

const accessor: Record<SortKey, (c: CampaignMetrics) => number | string> = {
  campaign_name: (c) => c.campaign_name.toLowerCase(),
  total_leads: (c) => c.total_leads,
  invites_sent: (c) => c.invites_sent,
  accepted: (c) => c.accepted,
  acceptance_rate: (c) => c.acceptance_rate ?? -1,
  replies: (c) => c.replies,
  reply_rate: (c) => c.reply_rate ?? -1,
  last_activity_at: (c) => c.last_activity_at ?? '',
  runtime_status: (c) => campaignRuntimeLabel(c.runtime_status),
  is_archived: (c) => c.is_archived === true ? 1 : c.is_archived === false ? 0 : -1,
}

export function CampaignTable({ campaigns, instances, title = 'Campaigns' }: Props) {
  const navigate = useNavigate()
  const [sortKey, setSortKey] = useState<SortKey>('invites_sent')
  const [sortAsc, setSortAsc] = useState(false)
  const [statusFilter, setStatusFilter] = useState('any')
  const [archiveFilter, setArchiveFilter] = useState<'current' | 'all' | 'archived'>('current')

  const label = (id: string) => instanceName(instances.find((i) => i.id === id), id)

  const rows = useMemo(() => {
    const get = accessor[sortKey]
    return campaigns.filter((campaign) => {
      if (archiveFilter === 'current' && campaign.is_archived !== false) return false
      if (archiveFilter === 'archived' && campaign.is_archived !== true) return false
      const normalized = parseCampaignRuntimeStatus(campaign.runtime_status) ?? 'unknown'
      return statusFilter === 'any' || normalized === statusFilter
    }).sort((a, b) => {
      const av = get(a)
      const bv = get(b)
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
      return sortAsc ? cmp : -cmp
    })
  }, [campaigns, sortKey, sortAsc, statusFilter, archiveFilter])

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(!sortAsc)
    else {
      setSortKey(key)
      setSortAsc(key === 'campaign_name')
    }
  }
  const sortInd = (key: SortKey) => (
    <span className="sort-ind">{key === sortKey ? (sortAsc ? '↑' : '↓') : ''}</span>
  )
  const head = (key: SortKey, text: string, cls = '') => (
    <th className={`sortable ${cls}`.trim()} onClick={() => onSort(key)}>{text}{sortInd(key)}</th>
  )

  const open = (id: string) => navigate(`/campaign/${encodeURIComponent(id)}`)

  return (
    <div className="card">
      <div className="campaign-table-head">
        <h2>{title}</h2>
        <div className="campaign-table-filters" aria-label="Campaign filters">
          <label>
            <span>Status</span>
            <select aria-label="Filter campaigns by runtime status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="any">All statuses</option>
              {CAMPAIGN_RUNTIME_STATUSES.map((status) => (
                <option key={status} value={status}>{campaignRuntimeLabel(status)}</option>
              ))}
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label>
            <span>Archive</span>
            <select aria-label="Filter campaigns by archive state" value={archiveFilter} onChange={(event) => setArchiveFilter(event.target.value as typeof archiveFilter)}>
              <option value="current">Current</option>
              <option value="all">All</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {head('campaign_name', 'Campaign')}
              <th>Account</th>
              {head('runtime_status', 'Linked Helper status')}
              {head('is_archived', 'Archived')}
              {head('total_leads', 'Leads', 'num')}
              {head('invites_sent', 'Invites', 'num')}
              {head('accepted', 'Accepted', 'num')}
              {head('acceptance_rate', 'Accept %', 'num')}
              {head('replies', 'Replies', 'num')}
              {head('reply_rate', 'Reply %', 'num')}
              {head('last_activity_at', 'Last activity')}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.campaign_id}
                className="row-clickable"
                tabIndex={0}
                role="button"
                aria-label={`Open campaign ${c.campaign_name}`}
                onClick={() => open(c.campaign_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    open(c.campaign_id)
                  }
                }}
              >
                <td>
                  <div className="ellipsis" title={c.campaign_name}>{c.campaign_name}</div>
                </td>
                <td className="muted">
                  <Link
                    className="row-link muted"
                    to={`/account/${encodeURIComponent(c.instance_id)}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {label(c.instance_id)}
                  </Link>
                </td>
                <td><CampaignRuntimeStatusView campaign={c} compact showArchive={false} /></td>
                <td>
                  {c.is_archived === true
                    ? <span className="badge archive-yes">Archived</span>
                    : c.is_archived === false
                      ? <span className="muted small">No</span>
                      : <span className="badge archive-unknown">Unknown</span>}
                </td>
                <td className="num">{num(c.total_leads)}</td>
                <td className="num">{num(c.invites_sent)}</td>
                <td className="num">{num(c.accepted)}</td>
                <td className="num">{rate(c.acceptance_rate)}</td>
                <td className="num">{num(c.replies)}</td>
                <td className="num">{rate(c.reply_rate)}</td>
                <td className="muted">{ago(c.last_activity_at)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={11} className="muted">
                {campaigns.length === 0 ? 'No campaigns synced yet.' : 'No campaigns match these filters.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
