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
import {
  Badge, Panel, SectionHeader, Select, SortHeader, Table, TableFrame,
} from '../ui'

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
  const sortProps = (key: SortKey) => ({
    active: sortKey === key,
    direction: (sortAsc ? 'asc' : 'desc') as 'asc' | 'desc',
    onSort: () => onSort(key),
  })

  const open = (id: string) => navigate(`/campaign/${encodeURIComponent(id)}`)

  return (
    <Panel>
      <SectionHeader
        title={title}
        actions={
          <div className="flex flex-wrap items-end gap-inline" aria-label="Campaign filters">
            <label className="grid gap-app-xs text-app-meta text-app-text-secondary">
              <span>Status</span>
              <Select
                aria-label="Filter campaigns by runtime status"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="any">All statuses</option>
                {CAMPAIGN_RUNTIME_STATUSES.map((status) => (
                  <option key={status} value={status}>{campaignRuntimeLabel(status)}</option>
                ))}
                <option value="unknown">Unknown</option>
              </Select>
            </label>
            <label className="grid gap-app-xs text-app-meta text-app-text-secondary">
              <span>Archive</span>
              <Select
                aria-label="Filter campaigns by archive state"
                value={archiveFilter}
                onChange={(event) => setArchiveFilter(event.target.value as typeof archiveFilter)}
              >
                <option value="current">Current</option>
                <option value="all">All</option>
                <option value="archived">Archived</option>
              </Select>
            </label>
          </div>
        }
      />
      <TableFrame scrollLabel={`${title} table`}>
        <Table caption={title}>
          <thead>
            <tr>
              <SortHeader label="Campaign" {...sortProps('campaign_name')} />
              <th scope="col">Account</th>
              <SortHeader label="Linked Helper status" {...sortProps('runtime_status')} />
              <SortHeader label="Archived" {...sortProps('is_archived')} />
              <SortHeader label="Leads" className="ui-table__num" {...sortProps('total_leads')} />
              <SortHeader label="Invites" className="ui-table__num" {...sortProps('invites_sent')} />
              <SortHeader label="Accepted" className="ui-table__num" {...sortProps('accepted')} />
              <SortHeader label="Accept %" className="ui-table__num" {...sortProps('acceptance_rate')} />
              <SortHeader label="Replies" className="ui-table__num" {...sortProps('replies')} />
              <SortHeader label="Reply %" className="ui-table__num" {...sortProps('reply_rate')} />
              <SortHeader label="Last activity" {...sortProps('last_activity_at')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.campaign_id}
                className="cursor-pointer hover:bg-app-surface-3"
                // The pointer path; the keyboard/screen-reader path is the
                // campaign-name link in the first cell.
                onClick={() => open(c.campaign_id)}
              >
                <td>
                  <Link
                    className="block overflow-hidden text-ellipsis whitespace-nowrap text-app-text no-underline hover:text-app-accent hover:underline"
                    to={`/campaign/${encodeURIComponent(c.campaign_id)}`}
                    title={c.campaign_name}
                  >
                    {c.campaign_name}
                  </Link>
                </td>
                <td className="text-app-text-muted">
                  <Link
                    className="text-app-text-muted no-underline hover:text-app-accent hover:underline"
                    to={`/account/${encodeURIComponent(c.instance_id)}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {label(c.instance_id)}
                  </Link>
                </td>
                <td><CampaignRuntimeStatusView campaign={c} compact showArchive={false} /></td>
                <td>
                  {c.is_archived === true
                    ? <Badge tone="neutral">Archived</Badge>
                    : c.is_archived === false
                      ? <span className="text-app-text-muted text-app-meta">No</span>
                      : <Badge tone="warning">Unknown</Badge>}
                </td>
                <td className="ui-table__num">{num(c.total_leads)}</td>
                <td className="ui-table__num">{num(c.invites_sent)}</td>
                <td className="ui-table__num">{num(c.accepted)}</td>
                <td className="ui-table__num">{rate(c.acceptance_rate)}</td>
                <td className="ui-table__num">{num(c.replies)}</td>
                <td className="ui-table__num">{rate(c.reply_rate)}</td>
                <td className="text-app-text-muted">{ago(c.last_activity_at)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={11} className="text-app-text-muted">
                {campaigns.length === 0 ? 'No campaigns synced yet.' : 'No campaigns match these filters.'}
              </td></tr>
            )}
          </tbody>
        </Table>
      </TableFrame>
    </Panel>
  )
}
