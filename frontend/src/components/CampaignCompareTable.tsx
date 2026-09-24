import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CampaignMetrics, Instance } from '../lib/types'
import { instanceName } from '../lib/leads'
import { Panel, SectionHeader, SortHeader, Table, TableFrame } from '../ui'
import { SERIES } from './chartTheme'

/** Fewer leads than this and the rates are too noisy to trust. */
const SMALL_SAMPLE = 30

type SortKey =
  | 'campaign_name' | 'total_leads' | 'invites_sent' | 'accepted'
  | 'acceptance_rate' | 'replies' | 'reply_rate'

const accessor: Record<SortKey, (c: CampaignMetrics) => number | string> = {
  campaign_name: (c) => c.campaign_name.toLowerCase(),
  total_leads: (c) => c.total_leads,
  invites_sent: (c) => c.invites_sent,
  accepted: (c) => c.accepted,
  acceptance_rate: (c) => c.acceptance_rate ?? -1,
  replies: (c) => c.replies,
  reply_rate: (c) => c.reply_rate ?? -1,
}

export function CampaignCompareTable({
  campaigns, instances,
}: { campaigns: CampaignMetrics[]; instances: Instance[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('reply_rate')
  const [sortAsc, setSortAsc] = useState(false)

  const maxAccept = Math.max(1, ...campaigns.map((c) => c.acceptance_rate ?? 0))
  const maxReply = Math.max(1, ...campaigns.map((c) => c.reply_rate ?? 0))

  const rows = useMemo(() => {
    const get = accessor[sortKey]
    return [...campaigns].sort((a, b) => {
      const av = get(a)
      const bv = get(b)
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
      return sortAsc ? cmp : -cmp
    })
  }, [campaigns, sortKey, sortAsc])

  const avg = useMemo(() => {
    const n = campaigns.length || 1
    const mean = (f: (c: CampaignMetrics) => number) =>
      campaigns.reduce((s, c) => s + f(c), 0) / n
    return {
      leads: mean((c) => c.total_leads),
      invites: mean((c) => c.invites_sent),
      accepted: mean((c) => c.accepted),
      accept: weightedRate(campaigns, (c) => c.accepted, (c) => c.invites_sent),
      replies: mean((c) => c.replies),
      reply: weightedRate(campaigns, (c) => c.replies, (c) => c.accepted),
    }
  }, [campaigns])

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(!sortAsc)
    else {
      setSortKey(key)
      setSortAsc(key === 'campaign_name')
    }
  }
  const sortHeader = (key: SortKey, label: string, numeric = false) => (
    <SortHeader
      label={label}
      active={key === sortKey}
      direction={sortAsc ? 'asc' : 'desc'}
      onSort={() => onSort(key)}
      className={numeric ? 'ui-table__num' : undefined}
    />
  )

  return (
    <Panel>
      <SectionHeader title="Campaign comparison" />
      <TableFrame scrollLabel="Campaign comparison">
        <Table caption="Campaign comparison">
          <thead>
            <tr>
              {sortHeader('campaign_name', 'Campaign')}
              <th scope="col">Account</th>
              {sortHeader('total_leads', 'Leads', true)}
              {sortHeader('invites_sent', 'Invites', true)}
              {sortHeader('accepted', 'Accepted', true)}
              {sortHeader('acceptance_rate', 'Accept %', true)}
              {sortHeader('replies', 'Replies', true)}
              {sortHeader('reply_rate', 'Reply %', true)}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const small = c.total_leads < SMALL_SAMPLE
              return (
                <tr key={c.campaign_id}>
                  <td>
                    <Link
                      className="text-app-text no-underline hover:text-app-accent hover:underline"
                      to={`/campaign/${encodeURIComponent(c.campaign_id)}`}
                    >
                      {c.campaign_name}
                    </Link>
                    {small && (
                      <span className="text-app-warning cursor-help" title={`Only ${c.total_leads} leads — rates are unreliable`}> ⚠</span>
                    )}
                  </td>
                  <td className="text-app-text-muted">{instanceName(instances.find((i) => i.id === c.instance_id), c.instance_id)}</td>
                  <td className="ui-table__num">{c.total_leads.toLocaleString('en-US')}</td>
                  <td className="ui-table__num">{c.invites_sent.toLocaleString('en-US')}</td>
                  <td className="ui-table__num">{c.accepted.toLocaleString('en-US')}</td>
                  <td className="ui-table__num">{rateCell(c.acceptance_rate, maxAccept, SERIES.accepted)}</td>
                  <td className="ui-table__num">{c.replies.toLocaleString('en-US')}</td>
                  <td className="ui-table__num">{rateCell(c.reply_rate, maxReply, SERIES.reply)}</td>
                </tr>
              )
            })}
          </tbody>
          {campaigns.length > 1 && (
            <tfoot>
              <tr className="[&>td]:border-t [&>td]:border-app-border [&>td]:text-app-text-muted [&>td]:font-semibold">
                <td>Average</td>
                <td />
                <td className="ui-table__num">{Math.round(avg.leads).toLocaleString('en-US')}</td>
                <td className="ui-table__num">{Math.round(avg.invites).toLocaleString('en-US')}</td>
                <td className="ui-table__num">{Math.round(avg.accepted).toLocaleString('en-US')}</td>
                <td className="ui-table__num">{fmtRate(avg.accept)}</td>
                <td className="ui-table__num">{Math.round(avg.replies).toLocaleString('en-US')}</td>
                <td className="ui-table__num">{fmtRate(avg.reply)}</td>
              </tr>
            </tfoot>
          )}
        </Table>
      </TableFrame>
      <p className="text-app-meta text-app-text-muted mt-app-md">
        ⚠ = under {SMALL_SAMPLE} leads, rate is noisy. Averages are
        pooled (totals ÷ totals), not a mean of the per-campaign rates.
      </p>
    </Panel>
  )
}

function rateCell(rate: number | null, max: number, color: string) {
  if (rate == null) return <span className="text-app-text-muted">—</span>
  return (
    <div className="flex flex-col items-end gap-[3px]">
      <span className="tabular-nums">{rate.toFixed(1)}%</span>
      <div className="w-[72px] h-[5px] bg-app-surface-2 rounded-[var(--radius-xs)] overflow-hidden">
        <span
          className="block h-full rounded-[var(--radius-xs)]"
          style={{ width: `${Math.min(100, (100 * rate) / max)}%`, background: color }}
        />
      </div>
    </div>
  )
}

/** Pooled rate across campaigns: Σnum ÷ Σden (so big campaigns dominate, which
 *  is the honest team-wide figure). */
function weightedRate(
  cs: CampaignMetrics[], num: (c: CampaignMetrics) => number, den: (c: CampaignMetrics) => number,
): number | null {
  const d = cs.reduce((s, c) => s + den(c), 0)
  return d > 0 ? (100 * cs.reduce((s, c) => s + num(c), 0)) / d : null
}

const fmtRate = (r: number | null) => (r == null ? '—' : r.toFixed(1) + '%')
