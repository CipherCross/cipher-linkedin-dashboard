import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import { useConversation } from '../lib/ConversationContext'
import type { Lead } from '../lib/types'
import {
  RISK_LABEL, STAGES, downloadCsv, instanceName, riskOf, shortDate, stageMeta,
  stageOf, toCsv,
} from '../lib/leads'
import type { RiskFlag, Stage } from '../lib/leads'

const PAGE_SIZE = 50

type SortKey = 'full_name' | 'invited_at' | 'connected_at' | 'replied_at' | 'last_action_at'

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'invited_at', label: 'Invited' },
  { key: 'connected_at', label: 'Accepted' },
  { key: 'replied_at', label: 'Replied' },
  { key: 'last_action_at', label: 'Last action' },
]

export function LeadsExplorer() {
  const { data } = useData()
  const { openConversation } = useConversation()
  const [params, setParams] = useSearchParams()
  const [sortKey, setSortKey] = useState<SortKey>('last_action_at')
  const [sortAsc, setSortAsc] = useState(false)
  const [page, setPage] = useState(0)

  const inst = params.get('inst') ?? 'all'
  const camp = params.get('camp') ?? 'all'
  const stage = params.get('stage') ?? 'all'
  const risk = params.get('risk') ?? 'all'
  const q = params.get('q') ?? ''

  // A `camp` from the URL can name a campaign in a different account than the
  // selected `inst` (e.g. a shared link). Ignore it then instead of rendering an
  // empty list with a stale campaign still selected in the dropdown.
  const campInstance = data?.campaigns.find((c) => c.campaign_id === camp)?.instance_id
  const effCamp =
    camp !== 'all' && inst !== 'all' && campInstance && campInstance !== inst ? 'all' : camp

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value === 'all' || value === '') next.delete(key)
    else next.set(key, value)
    if (key === 'inst') next.delete('camp')
    setParams(next, { replace: true })
    setPage(0)
  }

  const filtered = useMemo(() => {
    if (!data) return []
    const needle = q.trim().toLowerCase()
    const rows = data.leads.filter((l) => {
      if (inst !== 'all' && l.instance_id !== inst) return false
      if (effCamp !== 'all' && l.campaign_id !== effCamp) return false
      if (stage !== 'all' && stageOf(l) !== (stage as Stage)) return false
      if (risk !== 'all' && riskOf(l) !== (risk as RiskFlag)) return false
      if (needle) {
        const hay = `${l.full_name ?? ''} ${l.headline ?? ''} ${l.company ?? ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
    rows.sort((a, b) => {
      const av = a[sortKey] ?? ''
      const bv = b[sortKey] ?? ''
      if (av === bv) return 0
      if (av === '') return 1 // nulls last regardless of direction
      if (bv === '') return -1
      return sortAsc ? (av < bv ? -1 : 1) : av < bv ? 1 : -1
    })
    return rows
  }, [data, inst, effCamp, stage, risk, q, sortKey, sortAsc])

  if (!data) return null

  const campaignName = (id: string) =>
    data.campaigns.find((c) => c.campaign_id === id)?.campaign_name ?? id
  const instanceLabel = (id: string) =>
    instanceName(data.instances.find((i) => i.id === id), id)

  const campaignOptions = data.campaigns.filter(
    (c) => inst === 'all' || c.instance_id === inst,
  )
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc(!sortAsc)
    else {
      setSortKey(key)
      setSortAsc(key === 'full_name')
    }
    setPage(0)
  }
  const arrow = (key: SortKey) => (key === sortKey ? (sortAsc ? ' ↑' : ' ↓') : '')

  const exportCsv = () =>
    downloadCsv(
      `leads-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        filtered.map((l) => ({
          name: l.full_name,
          profile_url: l.profile_url,
          headline: l.headline,
          company: l.company,
          campaign: campaignName(l.campaign_id),
          instance: instanceLabel(l.instance_id),
          stage: stageOf(l),
          risk: riskLabel(l),
          invited_at: l.invited_at,
          connected_at: l.connected_at,
          replied_at: l.replied_at,
          last_action_at: l.last_action_at,
        })),
      ),
    )

  return (
    <>
      <header>
        <div>
          <h1>Leads</h1>
          <div className="muted small">
            {filtered.length.toLocaleString('en-US')} of{' '}
            {data.leads.length.toLocaleString('en-US')} leads match — filters are
            in the URL, so views are shareable.
          </div>
        </div>
        <div className="controls">
          <button className="btn" onClick={exportCsv} disabled={filtered.length === 0}>
            Export CSV ({filtered.length})
          </button>
        </div>
      </header>

      <div className="filter-bar card">
        <input
          type="search"
          placeholder="Search name, headline, company…"
          value={q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <select value={inst} onChange={(e) => setFilter('inst', e.target.value)}>
          <option value="all">All accounts</option>
          {data.instances.map((i) => (
            <option key={i.id} value={i.id}>{instanceName(i)}</option>
          ))}
        </select>
        <select value={effCamp} onChange={(e) => setFilter('camp', e.target.value)}>
          <option value="all">All campaigns</option>
          {campaignOptions.map((c) => (
            <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>
          ))}
        </select>
        <select value={stage} onChange={(e) => setFilter('stage', e.target.value)}>
          <option value="all">All stages</option>
          {STAGES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <select value={risk} onChange={(e) => setFilter('risk', e.target.value)}>
          <option value="all">Any status</option>
          <option value="pending_2w">At risk: pending 14d+ (withdraw?)</option>
          <option value="no_reply_2w">At risk: no reply 14d+ (follow up)</option>
        </select>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => onSort('full_name')}>
                Lead{arrow('full_name')}
              </th>
              <th>Headline</th>
              <th>Campaign</th>
              <th>Stage</th>
              {COLUMNS.map((c) => (
                <th key={c.key} className="sortable" onClick={() => onSort(c.key)}>
                  {c.label}{arrow(c.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((l) => (
              <tr key={l.id} className="row-clickable" onClick={() => openConversation(l)}>
                <td>
                  <a
                    className="row-link"
                    href={l.profile_url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {l.full_name || l.profile_url.replace('https://www.linkedin.com/in/', '')}
                  </a>
                  {l.company && <div className="muted small">{l.company}</div>}
                </td>
                <td className="muted ellipsis" title={l.headline ?? ''}>{l.headline ?? '—'}</td>
                <td className="muted small">{campaignName(l.campaign_id)}</td>
                <td><StageBadge lead={l} /></td>
                <td className="muted">{shortDate(l.invited_at)}</td>
                <td className="muted">{shortDate(l.connected_at)}</td>
                <td className="muted">{shortDate(l.replied_at)}</td>
                <td className="muted">{shortDate(l.last_action_at)}</td>
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr><td colSpan={8} className="muted">No leads match these filters.</td></tr>
            )}
          </tbody>
        </table>
        {pages > 1 && (
          <div className="pager">
            <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>
              ← Prev
            </button>
            <span className="muted small">page {page + 1} / {pages}</span>
            <button className="btn" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
              Next →
            </button>
          </div>
        )}
      </div>
    </>
  )
}

function StageBadge({ lead }: { lead: Lead }) {
  const stage = stageMeta(stageOf(lead))
  const risk = riskOf(lead)
  return (
    <>
      <span className="badge" style={{ color: stage.color, borderColor: stage.color + '66' }}>
        {stage.label}
      </span>
      {risk && <span className="badge risk">{RISK_LABEL[risk]}</span>}
    </>
  )
}

const riskLabel = (l: Lead) => {
  const r = riskOf(l)
  return r ? RISK_LABEL[r] : null
}
