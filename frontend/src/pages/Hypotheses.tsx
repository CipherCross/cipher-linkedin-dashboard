import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Archive, ArchiveRestore, FlaskConical, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { adminPost } from '../lib/admin'
import { EmptyState } from '../components/EmptyState'
import { KpiCards } from '../components/KpiCards'
import { Funnel } from '../components/Funnel'
import { DateRangePicker } from '../components/DateRangePicker'
import { num } from '../lib/format'
import {
  ALL_TIME_RANGE, hypothesisCampaignBreakdown, hypothesisTotals, instanceName,
  latestRepliesByLead, presetRanges, previousRange,
} from '../lib/leads'
import type { DateRange } from '../lib/leads'
import type {
  CampaignMetrics, Hypothesis, HypothesisCampaign, Instance, Lead, SavedSearch,
} from '../lib/types'

interface HypDraft {
  id?: number
  name: string
  icp_id: number | null
  description: string
  archived: boolean
  campaignIds: string[]
  searchIds: number[]
}

function toDraft(hyp: Hypothesis | null, campaignIds: string[], searchIds: number[]): HypDraft {
  if (!hyp) return { name: '', icp_id: null, description: '', archived: false, campaignIds: [], searchIds: [] }
  return {
    id: hyp.id,
    name: hyp.name,
    icp_id: hyp.icp_id,
    description: hyp.description ?? '',
    archived: hyp.archived,
    campaignIds,
    searchIds,
  }
}

export function Hypotheses() {
  const {
    data, upsertHypothesis, removeHypothesis, assignCampaigns, upsertSavedSearch,
  } = useData()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<Hypothesis | 'new' | null>(null)
  const [sortKey, setSortKey] = useState<'name' | 'campaigns' | 'leads' | 'connect' | 'reply'>('leads')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const hypotheses = data?.hypotheses ?? []
  const icps = data?.icps ?? []
  const hypCampaigns = data?.hypothesisCampaigns ?? []
  const campaigns = data?.campaigns ?? []
  const leads = data?.leads ?? []
  const savedSearches = data?.savedSearches ?? []
  const latest = useMemo(() => latestRepliesByLead(data?.messages ?? []), [data])

  const icpNameById = useMemo(() => new Map(icps.map((i) => [i.id, i.name])), [icps])

  const visible = useMemo(
    () => hypotheses.filter((h) => showArchived || !h.archived),
    [hypotheses, showArchived],
  )
  const archivedCount = useMemo(() => hypotheses.filter((h) => h.archived).length, [hypotheses])

  // Comparison rows: one per visible hypothesis, deduped funnel totals.
  const rows = useMemo(() => {
    return visible.map((h) => {
      const campaignCount = hypCampaigns.filter((hc) => hc.hypothesis_id === h.id).length
      const totals = hypothesisTotals(h, hypCampaigns, leads, ALL_TIME_RANGE, latest)
      return {
        hyp: h,
        icpName: h.icp_id != null ? icpNameById.get(h.icp_id) ?? '—' : '—',
        campaigns: campaignCount,
        leads: totals.leads,
        connect: totals.invites > 0 ? (100 * totals.acceptedOfInvited) / totals.invites : null,
        reply: totals.accepted > 0 ? (100 * totals.repliedOfConnected) / totals.accepted : null,
      }
    })
  }, [visible, hypCampaigns, leads, latest, icpNameById])

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const val = (r: (typeof rows)[number]) => {
      switch (sortKey) {
        case 'name': return r.hyp.name.toLowerCase()
        case 'campaigns': return r.campaigns
        case 'leads': return r.leads
        case 'connect': return r.connect ?? -1
        case 'reply': return r.reply ?? -1
      }
    }
    return [...rows].sort((a, b) => {
      const av = val(a)
      const bv = val(b)
      if (av === bv) return 0
      return av! > bv! ? dir : -dir
    })
  }, [rows, sortKey, sortDir])

  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('desc') }
  }
  const sortInd = (key: typeof sortKey) => (
    <span className="sort-ind">{key === sortKey ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span>
  )
  const sortHead = (key: typeof sortKey, text: string, cls = '') => (
    <th className={`sortable ${cls}`.trim()} onClick={() => toggleSort(key)}>
      {text}
      {sortInd(key)}
    </th>
  )

  const selectedId = params.get('h') ? Number(params.get('h')) : null
  const selected = selectedId != null ? hypotheses.find((h) => h.id === selectedId) ?? null : null
  const select = (id: number | null) => {
    const next = new URLSearchParams(params)
    if (id == null) next.delete('h')
    else next.set('h', String(id))
    setParams(next, { replace: true })
  }

  const setArchived = async (hyp: Hypothesis, archived: boolean) => {
    try {
      const res = await adminPost('/api/playbook', {
        action: 'save_hypothesis',
        hypothesis: { id: hyp.id, archived },
      })
      const j = await res.json().catch(() => ({}))
      if (res.status === 401) return toast.error('Wrong admin secret.')
      if (!res.ok) return toast.error(`Couldn't update: ${j.error ?? res.status}`)
      upsertHypothesis(j.hypothesis)
      toast.success(archived ? 'Hypothesis archived.' : 'Hypothesis restored.')
    } catch (e) {
      toast.error(`Couldn't update: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const del = async (hyp: Hypothesis) => {
    if (!window.confirm(`Delete "${hyp.name}"? This can't be undone.`)) return
    try {
      const res = await adminPost('/api/playbook', { action: 'delete_hypothesis', id: hyp.id })
      const j = await res.json().catch(() => ({}))
      if (res.status === 401) return toast.error('Wrong admin secret.')
      if (!res.ok) return toast.error(`Couldn't delete: ${j.error ?? res.status}`)
      removeHypothesis(hyp.id)
      if (selectedId === hyp.id) select(null)
      toast.success('Hypothesis deleted.')
    } catch (e) {
      toast.error(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <>
      <header>
        <div>
          <h1>Hypotheses</h1>
          <div className="muted small">
            Group campaigns under an ICP to test a go-to-market hypothesis and compare results.
          </div>
        </div>
        <div className="controls">
          <button className="btn accent sm" onClick={() => setEditing('new')}>
            <Plus size={14} /> New hypothesis
          </button>
        </div>
      </header>

      <div className="filter-bar card">
        <div className="filter-field">
          <span className="filter-label">Archived</span>
          <label className="col-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived{archivedCount ? ` (${archivedCount})` : ''}
          </label>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={FlaskConical}
            title={hypotheses.length === 0 ? 'No hypotheses yet' : 'No hypotheses match this filter'}
            hint={
              hypotheses.length === 0
                ? 'Group campaigns under an ICP to start comparing go-to-market bets.'
                : 'Toggle "Show archived" to see retired hypotheses.'
            }
            action={
              hypotheses.length === 0 ? (
                <button className="link-btn" onClick={() => setEditing('new')}>New hypothesis</button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="card">
          <h2>Comparison</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {sortHead('name', 'Hypothesis')}
                  <th>ICP</th>
                  {sortHead('campaigns', 'Campaigns', 'num')}
                  {sortHead('leads', 'Leads', 'num')}
                  {sortHead('connect', 'Connect %', 'num')}
                  {sortHead('reply', 'Reply %', 'num')}
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => (
                  <tr
                    key={r.hyp.id}
                    className="row-clickable"
                    tabIndex={0}
                    role="button"
                    aria-label={`Show ${r.hyp.name} funnel`}
                    style={{ background: selectedId === r.hyp.id ? 'var(--surface-3)' : undefined }}
                    onClick={() => select(selectedId === r.hyp.id ? null : r.hyp.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        select(selectedId === r.hyp.id ? null : r.hyp.id)
                      }
                    }}
                  >
                    <td>{r.hyp.name}{r.hyp.archived && <span className="badge" style={{ marginLeft: 6 }}>Archived</span>}</td>
                    <td className="muted">{r.icpName}</td>
                    <td className="num">{num(r.campaigns)}</td>
                    <td className="num">{num(r.leads)}</td>
                    <td className="num">{r.connect == null ? '—' : r.connect.toFixed(1) + '%'}</td>
                    <td className="num">{r.reply == null ? '—' : r.reply.toFixed(1) + '%'}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="search-card-actions">
                        <button className="icon-only-btn" title="Edit" onClick={() => setEditing(r.hyp)}>
                          <Pencil size={14} />
                        </button>
                        <button
                          className="icon-only-btn"
                          title={r.hyp.archived ? 'Restore' : 'Archive'}
                          onClick={() => setArchived(r.hyp, !r.hyp.archived)}
                        >
                          {r.hyp.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                        </button>
                        <button className="icon-only-btn danger" title="Delete" onClick={() => del(r.hyp)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            Deduped by person across each hypothesis's campaigns — a shared lead counts once.
            Recent invite cohorts are still maturing; treat their rates as provisional.
          </div>
        </div>
      )}

      {selected && (
        <HypothesisDetail
          hyp={selected}
          hypCampaigns={hypCampaigns}
          campaigns={campaigns}
          leads={leads}
          latest={latest}
          icpName={selected.icp_id != null ? icpNameById.get(selected.icp_id) ?? null : null}
        />
      )}

      {editing && (
        <HypothesisEditor
          hyp={editing === 'new' ? null : editing}
          campaignIds={
            editing === 'new'
              ? []
              : hypCampaigns.filter((hc) => hc.hypothesis_id === editing.id).map((hc) => hc.campaign_id)
          }
          searchIds={
            editing === 'new'
              ? []
              : savedSearches.filter((s) => s.hypothesis_id === editing.id).map((s) => s.id)
          }
          icps={icps}
          campaigns={campaigns}
          instances={data?.instances ?? []}
          savedSearches={savedSearches}
          onClose={() => setEditing(null)}
          onSaved={(hyp) => {
            upsertHypothesis(hyp)
            setEditing(null)
          }}
          assignCampaigns={assignCampaigns}
          upsertSavedSearch={upsertSavedSearch}
        />
      )}
    </>
  )
}

// --- Detail: funnel + per-campaign breakdown for one hypothesis -------------

function HypothesisDetail({
  hyp, hypCampaigns, campaigns, leads, latest, icpName,
}: {
  hyp: Hypothesis
  hypCampaigns: HypothesisCampaign[]
  campaigns: CampaignMetrics[]
  leads: Lead[]
  latest: ReturnType<typeof latestRepliesByLead>
  icpName: string | null
}) {
  const RANGES = useMemo(() => presetRanges(), [])
  const [range, setRange] = useState<DateRange>(ALL_TIME_RANGE)

  const scopedCampaignIds = useMemo(
    () => new Set(hypCampaigns.filter((hc) => hc.hypothesis_id === hyp.id).map((hc) => hc.campaign_id)),
    [hypCampaigns, hyp.id],
  )
  const scopedLeads = useMemo(
    () => leads.filter((l) => scopedCampaignIds.has(l.campaign_id)),
    [leads, scopedCampaignIds],
  )
  const totals = useMemo(
    () => hypothesisTotals(hyp, hypCampaigns, leads, range, latest),
    [hyp, hypCampaigns, leads, range, latest],
  )
  const prevRange = previousRange(range)
  const prevTotals = useMemo(
    () => (prevRange ? hypothesisTotals(hyp, hypCampaigns, leads, prevRange, latest) : undefined),
    [hyp, hypCampaigns, leads, prevRange, latest],
  )
  const breakdown = useMemo(
    () => hypothesisCampaignBreakdown(hyp, hypCampaigns, leads, campaigns, range),
    [hyp, hypCampaigns, leads, campaigns, range],
  )

  return (
    <div className="card">
      <div className="card-head">
        <h2>{hyp.name}{icpName ? <span className="muted"> · {icpName}</span> : ''}</h2>
        <DateRangePicker presets={RANGES} value={range} onChange={setRange} />
      </div>
      {hyp.description && <p className="muted small">{hyp.description}</p>}

      <KpiCards totals={totals} prev={prevTotals} />
      <Funnel leads={scopedLeads} />

      <h3 className="search-group-head">Per-campaign breakdown</h3>
      {breakdown.length === 0 ? (
        <p className="muted small">No campaigns assigned to this hypothesis yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th className="num">Invites</th>
                <th className="num">Accepted</th>
                <th className="num">Replies</th>
                <th className="num">Accept %</th>
                <th className="num">Reply %</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((c) => (
                <tr key={c.campaign_id}>
                  <td>{c.campaign_name}</td>
                  <td className="num">{num(c.invites_sent)}</td>
                  <td className="num">{num(c.accepted)}</td>
                  <td className="num">{num(c.replies)}</td>
                  <td className="num">{c.acceptance_rate == null ? '—' : c.acceptance_rate.toFixed(1) + '%'}</td>
                  <td className="num">{c.reply_rate == null ? '—' : c.reply_rate.toFixed(1) + '%'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 8 }}>
        Replies lag invites by days to weeks — treat the most recent invite cohorts' rates as
        still maturing, not a verdict on this hypothesis.
      </p>
    </div>
  )
}

// --- Editor -----------------------------------------------------------------

function HypothesisEditor({
  hyp, campaignIds, searchIds, icps, campaigns, instances, savedSearches, onClose, onSaved,
  assignCampaigns, upsertSavedSearch,
}: {
  hyp: Hypothesis | null
  campaignIds: string[]
  searchIds: number[]
  icps: { id: number; name: string }[]
  campaigns: CampaignMetrics[]
  instances: Instance[]
  savedSearches: SavedSearch[]
  onClose: () => void
  onSaved: (hyp: Hypothesis) => void
  assignCampaigns: (hypothesisId: number, campaignIds: string[]) => void
  upsertSavedSearch: (s: SavedSearch) => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState<HypDraft>(() => toDraft(hyp, campaignIds, searchIds))
  const [campaignFilter, setCampaignFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof HypDraft>(key: K, value: HypDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const toggleCampaign = (id: string) =>
    setDraft((d) => ({
      ...d,
      campaignIds: d.campaignIds.includes(id)
        ? d.campaignIds.filter((c) => c !== id)
        : [...d.campaignIds, id],
    }))

  const toggleSearch = (id: number) =>
    setDraft((d) => ({
      ...d,
      searchIds: d.searchIds.includes(id) ? d.searchIds.filter((s) => s !== id) : [...d.searchIds, id],
    }))

  const filteredCampaigns = useMemo(() => {
    const needle = campaignFilter.trim().toLowerCase()
    return campaigns
      .filter((c) => !needle || c.campaign_name.toLowerCase().includes(needle))
      .sort((a, b) => a.campaign_name.localeCompare(b.campaign_name))
  }, [campaigns, campaignFilter])

  const save = async () => {
    if (!draft.name.trim()) {
      setError('Name is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const hypPayload = {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        icp_id: draft.icp_id,
        description: draft.description.trim() || null,
        archived: draft.archived,
      }
      const res = await adminPost('/api/playbook', { action: 'save_hypothesis', hypothesis: hypPayload })
      const j = await res.json().catch(() => ({}))
      if (res.status === 409) return setError('A hypothesis with this name already exists.')
      if (res.status === 401) return setError('Admin secret is required (or was wrong) to save.')
      if (!res.ok) return setError(j.error ?? `Save failed (${res.status}).`)
      const savedHyp = j.hypothesis as Hypothesis

      const cRes = await adminPost('/api/playbook', {
        action: 'set_hypothesis_campaigns',
        hypothesis_id: savedHyp.id,
        campaign_ids: draft.campaignIds,
      })
      if (cRes.ok) assignCampaigns(savedHyp.id, draft.campaignIds)
      else {
        const cj = await cRes.json().catch(() => ({}))
        toast.error(`Hypothesis saved, but campaign assignment failed: ${cj.error ?? cRes.status}`)
      }

      const originalSearchIds = new Set(searchIds)
      const nextSearchIds = new Set(draft.searchIds)
      for (const sid of new Set([...originalSearchIds, ...nextSearchIds])) {
        const wasIn = originalSearchIds.has(sid)
        const nowIn = nextSearchIds.has(sid)
        if (wasIn === nowIn) continue
        const sRes = await adminPost('/api/playbook', {
          action: 'assign_search',
          search_id: sid,
          hypothesis_id: nowIn ? savedHyp.id : null,
        })
        const sj = await sRes.json().catch(() => ({}))
        if (sRes.ok) upsertSavedSearch(sj.search)
      }

      onSaved(savedHyp)
      toast.success('Hypothesis saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="pipe-modal-overlay" onClick={onClose}>
      <div
        className="pipe-modal search-modal"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? 'Edit hypothesis' : 'New hypothesis'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pipe-modal-head">
          <span>{draft.id ? 'Edit hypothesis' : 'New hypothesis'}</span>
          <button className="conv-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="search-form">
          <label className="filter-field">
            <span className="filter-label">Name</span>
            <input
              autoFocus
              value={draft.name}
              placeholder="e.g. Web 2 Mob — US wellness founders"
              onChange={(e) => set('name', e.target.value)}
            />
          </label>

          <label className="filter-field">
            <span className="filter-label">ICP</span>
            <select
              value={draft.icp_id ?? ''}
              onChange={(e) => set('icp_id', e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Unassigned</option>
              {icps.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </label>

          <label className="filter-field">
            <span className="filter-label">Description</span>
            <textarea
              rows={2}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </label>

          <div className="filter-field">
            <span className="filter-label">Campaigns ({draft.campaignIds.length} selected)</span>
            <input
              type="search"
              placeholder="Filter campaigns…"
              value={campaignFilter}
              onChange={(e) => setCampaignFilter(e.target.value)}
            />
            <div className="icp-checklist">
              {filteredCampaigns.map((c) => {
                const acct = instanceName(
                  instances.find((i) => i.id === c.instance_id),
                  c.instance_id,
                )
                return (
                  <label className="icp-checklist-row" key={c.campaign_id}>
                    <input
                      type="checkbox"
                      checked={draft.campaignIds.includes(c.campaign_id)}
                      onChange={() => toggleCampaign(c.campaign_id)}
                    />
                    <span>{c.campaign_name}</span>
                    <span className="muted small">{acct}</span>
                  </label>
                )
              })}
              {filteredCampaigns.length === 0 && <p className="muted small">No campaigns match.</p>}
            </div>
          </div>

          <div className="filter-field">
            <span className="filter-label">Searches ({draft.searchIds.length} attached)</span>
            <div className="icp-checklist">
              {savedSearches.map((s) => (
                <label className="icp-checklist-row" key={s.id}>
                  <input
                    type="checkbox"
                    checked={draft.searchIds.includes(s.id)}
                    onChange={() => toggleSearch(s.id)}
                  />
                  <span>{s.name}</span>
                  <span className="muted small">{s.platform}</span>
                </label>
              ))}
              {savedSearches.length === 0 && <p className="muted small">No saved searches yet.</p>}
            </div>
          </div>
        </div>

        {error && <div className="banner conv-error">{error}</div>}

        <div className="pipe-modal-actions">
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          <button className="btn accent sm" onClick={save} disabled={saving || !draft.name.trim()}>
            {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Create hypothesis'}
          </button>
        </div>
      </div>
    </div>
  )
}
