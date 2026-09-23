import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Archive, ArchiveRestore, ExternalLink, FlaskConical, Pencil, Plus, Trash2,
} from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { authPost } from '../lib/api'
import { CopyButton } from '../components/CopyButton'
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
  CampaignMetrics, Hypothesis, HypothesisCampaign, Icp, Instance, Lead, SavedSearch,
} from '../lib/types'
import {
  Badge, Button, Checkbox, Dialog, EmptyState, IconButton, InlineError, PageHeader, Panel, SectionHeader,
  SelectField, Table, TableFrame, TextField, TextareaField, Toolbar, useDirtyGuard,
} from '../ui'
import { COPY } from '../ui/labels'

type SortKey = 'name' | 'campaigns' | 'leads' | 'connect' | 'reply'

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
  const [sortKey, setSortKey] = useState<SortKey>('leads')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const hypotheses = data?.hypotheses ?? []
  const icps = data?.icps ?? []
  const hypCampaigns = data?.hypothesisCampaigns ?? []
  const campaigns = data?.campaigns ?? []
  const leads = data?.leads ?? []
  const savedSearches = data?.savedSearches ?? []
  const latest = useMemo(() => latestRepliesByLead(data?.messages ?? []), [data])

  const icpNameById = useMemo(() => new Map(icps.map((i) => [i.id, i.name])), [icps])
  const icpById = useMemo(() => new Map(icps.map((i) => [i.id, i])), [icps])

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

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('desc') }
  }

  const sortHead = (key: SortKey, label: string, numeric = false) => {
    const active = sortKey === key
    const direction = active ? sortDir : undefined
    return (
      <th
        scope="col"
        className={numeric ? 'text-right' : undefined}
        aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => toggleSort(key)}
          aria-label={`${label}, ${active ? (direction === 'asc' ? 'ascending' : 'descending') : 'not sorted'}`}
        >
          {label}
          <span aria-hidden="true">
            {active ? (direction === 'asc' ? '↑' : '↓') : ''}
          </span>
        </Button>
      </th>
    )
  }

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
      const res = await authPost('/api/playbook', {
        action: 'save_hypothesis',
        hypothesis: { id: hyp.id, archived },
      })
      const j = await res.json().catch(() => ({}))
      if (res.status === 401 || res.status === 403) return toast.error('Admin access required.')
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
      const res = await authPost('/api/playbook', { action: 'delete_hypothesis', id: hyp.id })
      const j = await res.json().catch(() => ({}))
      if (res.status === 401 || res.status === 403) return toast.error('Admin access required.')
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
      <PageHeader
        title="Hypotheses"
        description="Group campaigns under an ICP to test a go-to-market hypothesis and compare results."
        actions={
          <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={() => setEditing('new')}>
            New hypothesis
          </Button>
        }
      />

      <Toolbar>
        <Checkbox
          label={`Show archived${archivedCount ? ` (${archivedCount})` : ''}`}
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
      </Toolbar>

      {visible.length === 0 ? (
        <Panel>
          <EmptyState
            kind={hypotheses.length === 0 ? 'empty' : 'no-match'}
            icon={FlaskConical}
            title={hypotheses.length === 0 ? 'No hypotheses yet' : 'No hypotheses match this filter'}
            hint={
              hypotheses.length === 0
                ? 'Group campaigns under an ICP to start comparing go-to-market bets.'
                : 'Toggle "Show archived" to see retired hypotheses.'
            }
            action={
              hypotheses.length === 0 ? (
                <Button variant="primary" onClick={() => setEditing('new')}>New hypothesis</Button>
              ) : undefined
            }
          />
        </Panel>
      ) : (
        <Panel>
          <SectionHeader title="Comparison" />
          <TableFrame
            scrollLabel="Hypothesis comparison"
            hint="Deduped by person across each hypothesis's campaigns — a shared lead counts once. Recent invite cohorts are still maturing; treat their rates as provisional."
          >
            <Table caption="Hypothesis comparison">
              <thead>
                <tr>
                  {sortHead('name', 'Hypothesis')}
                  <th scope="col">ICP</th>
                  {sortHead('campaigns', 'Campaigns', true)}
                  {sortHead('leads', 'Leads', true)}
                  {sortHead('connect', 'Connect %', true)}
                  {sortHead('reply', 'Reply %', true)}
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => (
                  <tr
                    key={r.hyp.id}
                    className="relative"
                    style={{ background: selectedId === r.hyp.id ? 'var(--surface-3)' : undefined }}
                  >
                    <td>
                      <button
                        type="button"
                        className="p-0 border-0 bg-transparent text-left font-semibold text-app-text cursor-pointer focus-visible:outline-none after:absolute after:inset-0 after:content-['']"
                        onClick={() => select(selectedId === r.hyp.id ? null : r.hyp.id)}
                        aria-label={`Open ${r.hyp.name}`}
                        aria-expanded={selectedId === r.hyp.id}
                      >
                        {r.hyp.name}
                      </button>
                      {r.hyp.archived && <Badge className="ml-1.5">Archived</Badge>}
                    </td>
                    <td className="text-app-text-secondary">{r.icpName}</td>
                    <td className="text-right tabular-nums">{num(r.campaigns)}</td>
                    <td className="text-right tabular-nums">{num(r.leads)}</td>
                    <td className="text-right tabular-nums">{r.connect == null ? '—' : r.connect.toFixed(1) + '%'}</td>
                    <td className="text-right tabular-nums">{r.reply == null ? '—' : r.reply.toFixed(1) + '%'}</td>
                    <td className="relative z-10 text-right whitespace-nowrap">
                      {/* Icon-only so all three stay inside the frame at 1280. */}
                      <span className="inline-flex">
                        <IconButton
                          label={`Edit ${r.hyp.name}`}
                          icon={<Pencil size={20} aria-hidden="true" />}
                          onClick={() => setEditing(r.hyp)}
                        />
                        <IconButton
                          label={`${r.hyp.archived ? 'Restore' : 'Archive'} ${r.hyp.name}`}
                          icon={r.hyp.archived ? <ArchiveRestore size={20} aria-hidden="true" /> : <Archive size={20} aria-hidden="true" />}
                          onClick={() => setArchived(r.hyp, !r.hyp.archived)}
                        />
                        <IconButton
                          label={`Delete ${r.hyp.name}`}
                          tone="danger"
                          icon={<Trash2 size={20} aria-hidden="true" />}
                          onClick={() => del(r.hyp)}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFrame>
        </Panel>
      )}

      {selected && (
        <HypothesisViewer
          key={selected.id}
          hyp={selected}
          hypCampaigns={hypCampaigns}
          campaigns={campaigns}
          leads={leads}
          latest={latest}
          instances={data?.instances ?? []}
          icp={selected.icp_id != null ? icpById.get(selected.icp_id) ?? null : null}
          searches={savedSearches.filter((s) => s.hypothesis_id === selected.id)}
          onClose={() => select(null)}
          onEdit={() => {
            select(null)
            setEditing(selected)
          }}
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

// --- Read-only viewer: all linked data for one hypothesis -------------------

function hypToText(
  hyp: Hypothesis,
  icpName: string | null,
  breakdown: CampaignMetrics[],
  searches: SavedSearch[],
): string {
  const lines: string[] = [hyp.name]
  if (icpName) lines.push(`ICP: ${icpName}`)
  if (hyp.description) lines.push(`Description: ${hyp.description}`)
  if (breakdown.length) {
    lines.push('', 'Campaigns:')
    for (const c of breakdown) lines.push(`  ${c.campaign_name}`)
  }
  if (searches.length) {
    lines.push('', 'Searches:')
    for (const s of searches) lines.push(`  ${s.name} (${s.platform})`)
  }
  return lines.join('\n')
}

function HypothesisViewer({
  hyp, hypCampaigns, campaigns, leads, latest, instances, icp, searches, onClose, onEdit,
}: {
  hyp: Hypothesis
  hypCampaigns: HypothesisCampaign[]
  campaigns: CampaignMetrics[]
  leads: Lead[]
  latest: ReturnType<typeof latestRepliesByLead>
  instances: Instance[]
  icp: Icp | null
  searches: SavedSearch[]
  onClose: () => void
  onEdit: () => void
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
  const instanceOfCampaign = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of campaigns) {
      m.set(c.campaign_id, instanceName(instances.find((i) => i.id === c.instance_id), c.instance_id))
    }
    return m
  }, [campaigns, instances])

  return (
    <Dialog
      size="lg"
      title={<>{hyp.name}{hyp.archived && <Badge className="ml-2">Archived</Badge>}</>}
      onRequestClose={onClose}
      footer={<>
        <CopyButton text={hypToText(hyp, icp?.name ?? null, breakdown, searches)} title="Copy all fields" />
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button variant="primary" icon={<Pencil size={16} aria-hidden="true" />} onClick={onEdit}>
          Edit hypothesis
        </Button>
      </>}
    >
      <div className="flex flex-col gap-app-lg">
        <dl className="m-0 flex flex-col gap-app-md">
          <div className="flex items-start justify-between gap-app-sm">
            <div>
              <dt className="text-app-meta text-app-text-muted">ICP</dt>
              <dd className="m-0 mt-0.5">
                {icp ? (
                  <Link to="/icp" className="inline-flex items-center gap-1" onClick={onClose}>
                    {icp.name}
                    <ExternalLink size={12} aria-hidden="true" />
                  </Link>
                ) : (
                  <span className="text-app-text-muted">Unassigned</span>
                )}
              </dd>
            </div>
            {icp && <CopyButton text={icp.name} title="Copy ICP name" />}
          </div>

          {hyp.description && (
            <div className="flex items-start justify-between gap-app-sm">
              <div>
                <dt className="text-app-meta text-app-text-muted">Description</dt>
                <dd className="m-0 mt-0.5">{hyp.description}</dd>
              </div>
              <CopyButton text={hyp.description} title="Copy description" />
            </div>
          )}
        </dl>

        <SectionHeader
          level="subsection"
          title="Results"
          actions={<DateRangePicker presets={RANGES} value={range} onChange={setRange} />}
        />
        <KpiCards totals={totals} prev={prevTotals} />
        <Funnel leads={scopedLeads} />

        <SectionHeader level="subsection" title="Per-campaign breakdown" />
        {breakdown.length === 0 ? (
          <p className="m-0 text-app-meta text-app-text-muted">No campaigns assigned to this hypothesis yet.</p>
        ) : (
          <TableFrame scrollLabel="Per-campaign breakdown">
            <Table caption="Per-campaign breakdown">
              <thead>
                <tr>
                  <th scope="col">Campaign</th>
                  <th scope="col">Account</th>
                  <th scope="col" className="text-right">Invites</th>
                  <th scope="col" className="text-right">Accepted</th>
                  <th scope="col" className="text-right">Replies</th>
                  <th scope="col" className="text-right">Accept %</th>
                  <th scope="col" className="text-right">Reply %</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((c) => (
                  <tr key={c.campaign_id}>
                    <td>
                      <Link to={`/campaign/${encodeURIComponent(c.campaign_id)}`} onClick={onClose}>
                        {c.campaign_name}
                      </Link>
                    </td>
                    <td className="text-app-text-secondary">{instanceOfCampaign.get(c.campaign_id) ?? '—'}</td>
                    <td className="text-right tabular-nums">{num(c.invites_sent)}</td>
                    <td className="text-right tabular-nums">{num(c.accepted)}</td>
                    <td className="text-right tabular-nums">{num(c.replies)}</td>
                    <td className="text-right tabular-nums">{c.acceptance_rate == null ? '—' : c.acceptance_rate.toFixed(1) + '%'}</td>
                    <td className="text-right tabular-nums">{c.reply_rate == null ? '—' : c.reply_rate.toFixed(1) + '%'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFrame>
        )}

        <SectionHeader
          level="subsection"
          title={`Linked searches${searches.length ? ` (${searches.length})` : ''}`}
          actions={searches.length > 0 && (
            <CopyButton
              text={searches.map((s) => `${s.name} (${s.platform})`).join('\n')}
              title="Copy searches"
            />
          )}
        />
        {searches.length === 0 ? (
          <p className="m-0 text-app-meta text-app-text-muted">No saved searches attached to this hypothesis.</p>
        ) : (
          <TableFrame scrollLabel="Linked searches">
            <Table caption="Linked searches">
              <thead>
                <tr>
                  <th scope="col">Search</th>
                  <th scope="col">Platform</th>
                </tr>
              </thead>
              <tbody>
                {searches.map((s) => (
                  <tr key={s.id}>
                    <td><Link to="/searches" onClick={onClose}>{s.name}</Link></td>
                    <td className="text-app-text-secondary">{s.platform}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFrame>
        )}

        <p className="m-0 text-app-meta text-app-text-muted">
          Deduped by person across this hypothesis's campaigns — a shared lead counts once.
          Replies lag invites by days to weeks; treat the most recent invite cohorts' rates as
          still maturing, not a verdict on this hypothesis.
        </p>
      </div>
    </Dialog>
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
  // Frozen once at mount, like the draft itself — the source props are fresh
  // array literals on every parent render, so re-deriving this from them (a
  // useMemo keyed on those arrays) would silently reset the dirty baseline.
  const [initial] = useState<HypDraft>(() => toDraft(hyp, campaignIds, searchIds))
  const [draft, setDraft] = useState<HypDraft>(initial)
  const [campaignFilter, setCampaignFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const { guard, prompt } = useDirtyGuard(dirty)

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
      const res = await authPost('/api/playbook', { action: 'save_hypothesis', hypothesis: hypPayload })
      const j = await res.json().catch(() => ({}))
      if (res.status === 409) return setError('A hypothesis with this name already exists.')
      if (res.status === 401 || res.status === 403) return setError('Admin access is required to save.')
      if (!res.ok) return setError(j.error ?? `Save failed (${res.status}).`)
      const savedHyp = j.hypothesis as Hypothesis

      const cRes = await authPost('/api/playbook', {
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
        const sRes = await authPost('/api/playbook', {
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
    <>
      {prompt}
      <Dialog
        size="lg"
        title={draft.id ? 'Edit hypothesis' : 'New hypothesis'}
        description="Nothing is saved until you press the button in the footer."
        onRequestClose={() => guard(onClose)}
        busy={saving}
        footerNote={error ? undefined : dirty ? COPY.unsavedChanges : undefined}
        footer={<>
          <Button variant="secondary" onClick={() => guard(onClose)} disabled={saving}>{COPY.cancel}</Button>
          <Button
            variant="primary"
            onClick={save}
            loading={saving}
            loadingLabel="Saving the hypothesis"
            disabled={!draft.name.trim()}
          >
            {draft.id ? 'Save changes' : 'Create hypothesis'}
          </Button>
        </>}
      >
        {error && <div className="mb-app-lg"><InlineError title="Could not save the hypothesis." message={error} /></div>}
        <div className="flex flex-col gap-app-lg">
          <TextField
            label="Name"
            required
            value={draft.name}
            placeholder="e.g. Web 2 Mob — US wellness founders"
            onChange={(e) => set('name', e.target.value)}
          />

          <SelectField
            label="ICP"
            value={draft.icp_id ?? ''}
            onChange={(e) => set('icp_id', e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Unassigned</option>
            {icps.map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </SelectField>

          <TextareaField
            label="Description"
            rows={2}
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
          />

          <fieldset className="m-0 p-0 border-0 flex flex-col gap-app-sm">
            <legend className="mb-app-xs text-app-table font-semibold">
              Campaigns ({draft.campaignIds.length} selected)
            </legend>
            <TextField
              label="Filter campaigns"
              labelHidden
              type="search"
              placeholder="Filter campaigns…"
              value={campaignFilter}
              onChange={(e) => setCampaignFilter(e.target.value)}
            />
            <div className="flex flex-col max-h-[220px] overflow-y-auto border border-app-border rounded-sm bg-app-surface">
              {filteredCampaigns.map((c) => {
                const acct = instanceName(
                  instances.find((i) => i.id === c.instance_id),
                  c.instance_id,
                )
                return (
                  <Checkbox
                    key={c.campaign_id}
                    className="px-2.5 py-1.5 border-b border-app-border last:border-b-0"
                    label={c.campaign_name}
                    hint={acct}
                    checked={draft.campaignIds.includes(c.campaign_id)}
                    onChange={() => toggleCampaign(c.campaign_id)}
                  />
                )
              })}
              {filteredCampaigns.length === 0 && (
                <p className="m-0 px-2.5 py-1.5 text-app-meta text-app-text-muted">No campaigns match.</p>
              )}
            </div>
          </fieldset>

          <fieldset className="m-0 p-0 border-0 flex flex-col gap-app-sm">
            <legend className="mb-app-xs text-app-table font-semibold">
              Searches ({draft.searchIds.length} attached)
            </legend>
            <div className="flex flex-col max-h-[220px] overflow-y-auto border border-app-border rounded-sm bg-app-surface">
              {savedSearches.map((s) => (
                <Checkbox
                  key={s.id}
                  className="px-2.5 py-1.5 border-b border-app-border last:border-b-0"
                  label={s.name}
                  hint={s.platform}
                  checked={draft.searchIds.includes(s.id)}
                  onChange={() => toggleSearch(s.id)}
                />
              ))}
              {savedSearches.length === 0 && (
                <p className="m-0 px-2.5 py-1.5 text-app-meta text-app-text-muted">No saved searches yet.</p>
              )}
            </div>
          </fieldset>
        </div>
      </Dialog>
    </>
  )
}
