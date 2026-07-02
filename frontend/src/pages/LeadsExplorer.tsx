import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Download, SearchX, X } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useConversation } from '../lib/ConversationContext'
import { EmptyState } from '../components/EmptyState'
import type { Lead } from '../lib/types'
import {
  RISK_LABEL, STAGES, downloadCsv, instanceName, riskOf, stageMeta,
  stageOf, toCsv,
} from '../lib/leads'
import type { RiskFlag, Stage } from '../lib/leads'
import { num, shortDate } from '../lib/format'

const PAGE_SIZE = 50

type SortKey = 'full_name' | 'added_at' | 'invited_at' | 'connected_at' | 'replied_at' | 'last_action_at'

// The date/milestone columns. `added_at` is opt-in (deploy-pending on most
// notebooks, so it's mostly em-dashes today) — toggled on from the table toolbar.
const DATE_COLUMNS: Array<{ key: SortKey; label: string; optional?: boolean }> = [
  { key: 'added_at', label: 'Added', optional: true },
  { key: 'invited_at', label: 'Invited' },
  { key: 'connected_at', label: 'Accepted' },
  { key: 'replied_at', label: 'Replied' },
  { key: 'last_action_at', label: 'Last action' },
]

// Short chip labels for the active at-risk filter (the <select> text is verbose).
const RISK_CHIP: Record<RiskFlag, string> = {
  pending_2w: 'Pending 14d+',
  no_reply_2w: 'No reply 14d+',
}

export function LeadsExplorer() {
  const { data } = useData()
  const { openConversation } = useConversation()
  const [params, setParams] = useSearchParams()
  const [sortKey, setSortKey] = useState<SortKey>('last_action_at')
  const [sortAsc, setSortAsc] = useState(false)
  const [page, setPage] = useState(0)
  const [showAdded, setShowAdded] = useState(false)

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

  const clearAll = () => {
    setParams(new URLSearchParams(), { replace: true })
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

  const dateColumns = DATE_COLUMNS.filter((c) => !c.optional || showAdded)
  const colSpan = 4 + dateColumns.length

  // One removable chip per active filter, so the current view is legible at a glance.
  const activeFilters: Array<{ id: string; label: string; onClear: () => void }> = []
  if (q.trim()) activeFilters.push({ id: 'q', label: `“${q.trim()}”`, onClear: () => setFilter('q', '') })
  if (inst !== 'all')
    activeFilters.push({ id: 'inst', label: `Account: ${instanceLabel(inst)}`, onClear: () => setFilter('inst', 'all') })
  if (effCamp !== 'all')
    activeFilters.push({ id: 'camp', label: `Campaign: ${campaignName(effCamp)}`, onClear: () => setFilter('camp', 'all') })
  if (stage !== 'all')
    activeFilters.push({
      id: 'stage',
      label: `Stage: ${STAGES.find((s) => s.id === stage)?.label ?? stage}`,
      onClear: () => setFilter('stage', 'all'),
    })
  if (risk !== 'all')
    activeFilters.push({
      id: 'risk',
      label: RISK_CHIP[risk as RiskFlag] ?? risk,
      onClear: () => setFilter('risk', 'all'),
    })

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
          added_at: l.added_at,
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
            Filters are kept in the URL, so any view here is shareable.
          </div>
        </div>
      </header>

      <div className="filter-bar card">
        <label className="filter-field filter-field-grow">
          <span className="filter-label">Search</span>
          <input
            type="search"
            placeholder="Name, headline, company…"
            value={q}
            onChange={(e) => setFilter('q', e.target.value)}
          />
        </label>
        <label className="filter-field">
          <span className="filter-label">Account</span>
          <select value={inst} onChange={(e) => setFilter('inst', e.target.value)}>
            <option value="all">All accounts</option>
            {data.instances.map((i) => (
              <option key={i.id} value={i.id}>{instanceName(i)}</option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span className="filter-label">Campaign</span>
          <select value={effCamp} onChange={(e) => setFilter('camp', e.target.value)}>
            <option value="all">All campaigns</option>
            {campaignOptions.map((c) => (
              <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span className="filter-label">Stage</span>
          <select value={stage} onChange={(e) => setFilter('stage', e.target.value)}>
            <option value="all">All stages</option>
            {STAGES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span className="filter-label">Status</span>
          <select value={risk} onChange={(e) => setFilter('risk', e.target.value)}>
            <option value="all">Any status</option>
            <option value="pending_2w">At risk: pending 14d+ (withdraw?)</option>
            <option value="no_reply_2w">At risk: no reply 14d+ (follow up)</option>
          </select>
        </label>
      </div>

      {activeFilters.length > 0 && (
        <div className="active-filters">
          {activeFilters.map((f) => (
            <button key={f.id} className="filter-chip" onClick={f.onClear}>
              {f.label}
              <X size={13} />
            </button>
          ))}
          <button className="filter-chip-clear" onClick={clearAll}>
            Clear all
          </button>
        </div>
      )}

      <div className="card">
        <div className="table-toolbar">
          <span className="muted small">
            {num(filtered.length)} of {num(data.leads.length)} leads
          </span>
          <div className="table-toolbar-actions">
            <label className="col-toggle">
              <input
                type="checkbox"
                checked={showAdded}
                onChange={(e) => setShowAdded(e.target.checked)}
              />
              Added date
            </label>
            <button className="btn sm" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download size={14} /> Export CSV
            </button>
          </div>
        </div>
        <div className="table-scroll tall">
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => onSort('full_name')}>
                Lead{arrow('full_name')}
              </th>
              <th>Headline</th>
              <th>Campaign</th>
              <th>Stage</th>
              {dateColumns.map((c) => (
                <th key={c.key} className="sortable" onClick={() => onSort(c.key)}>
                  {c.label}{arrow(c.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((l) => (
              <tr
                key={l.id}
                className="row-clickable"
                tabIndex={0}
                role="button"
                aria-label={`Open conversation with ${l.full_name || 'lead'}`}
                onClick={() => openConversation(l)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openConversation(l)
                  }
                }}
              >
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
                {dateColumns.map((c) => (
                  <td key={c.key} className="muted col-date">
                    {shortDate(l[c.key] as string | null)}
                  </td>
                ))}
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={colSpan}>
                  <EmptyState
                    icon={SearchX}
                    title="No leads match these filters"
                    hint={
                      activeFilters.length > 0
                        ? 'Adjust or clear the filters to see more leads.'
                        : 'Leads appear here once your accounts sync.'
                    }
                    action={
                      activeFilters.length > 0 ? (
                        <button className="link-btn" onClick={clearAll}>Clear filters</button>
                      ) : undefined
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
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
      <span className={`badge stage-${stage.id}`}>{stage.label}</span>
      {risk && <span className="badge risk">{RISK_LABEL[risk]}</span>}
    </>
  )
}

const riskLabel = (l: Lead) => {
  const r = riskOf(l)
  return r ? RISK_LABEL[r] : null
}
