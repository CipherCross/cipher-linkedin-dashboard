import { useMemo, useState } from 'react'
import { Archive, ArchiveRestore, Pencil, Plus, Target, Trash2, X } from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { adminPost } from '../lib/admin'
import { ChipInput } from '../components/ChipInput'
import { EmptyState } from '../components/EmptyState'
import type { Icp, IcpIndustry, IcpPersona } from '../lib/types'

// Draft rows carry an optional `id` (present = existing DB row, save is a
// partial-patch update; absent = new, save is a create) and `_new` purely so
// React has a stable key before the server assigns a real id.
interface PersonaDraft {
  _key: string
  id?: number
  kind: string
  job_titles: string[]
  age_range: string
  location: string
  background: string
  profile_status: string
  connections_note: string
  followers_note: string
}

interface IndustryDraft {
  _key: string
  id?: number
  name: string
  include_keywords: string[]
  exclude_keywords: string[]
}

interface IcpDraft {
  id?: number
  name: string
  airtable_url: string
  main_product: string
  core_sphere: string
  secondary_sphere: string
  product_stage: string
  monetization: string
  features_note: string
  purchase_triggers: string[]
  features: string[]
  company_countries: string[]
  company_headcount: string
  company_age: string
  apollo_industries: string[]
  funding: string
  dev_team_availability: string
  dev_team_location: string
  include_keywords: string[]
  exclude_keywords: string[]
  archived: boolean
  personas: PersonaDraft[]
  industries: IndustryDraft[]
}

let keySeq = 0
const nextKey = () => `k${++keySeq}`

function personaToDraft(p: IcpPersona): PersonaDraft {
  return {
    _key: nextKey(),
    id: p.id,
    kind: p.kind,
    job_titles: p.job_titles ?? [],
    age_range: p.age_range ?? '',
    location: p.location ?? '',
    background: p.background ?? '',
    profile_status: p.profile_status ?? '',
    connections_note: p.connections_note ?? '',
    followers_note: p.followers_note ?? '',
  }
}

function industryToDraft(x: IcpIndustry): IndustryDraft {
  return {
    _key: nextKey(),
    id: x.id,
    name: x.name,
    include_keywords: x.include_keywords ?? [],
    exclude_keywords: x.exclude_keywords ?? [],
  }
}

function toDraft(icp: Icp | null, personas: IcpPersona[], industries: IcpIndustry[]): IcpDraft {
  if (!icp) {
    return {
      name: '', airtable_url: '', main_product: '', core_sphere: '', secondary_sphere: '',
      product_stage: '', monetization: '', features_note: '', purchase_triggers: [], features: [],
      company_countries: [], company_headcount: '', company_age: '', apollo_industries: [],
      funding: '', dev_team_availability: '', dev_team_location: '', include_keywords: [],
      exclude_keywords: [], archived: false, personas: [], industries: [],
    }
  }
  return {
    id: icp.id,
    name: icp.name,
    airtable_url: icp.airtable_url ?? '',
    main_product: icp.main_product ?? '',
    core_sphere: icp.core_sphere ?? '',
    secondary_sphere: icp.secondary_sphere ?? '',
    product_stage: icp.product_stage ?? '',
    monetization: icp.monetization ?? '',
    features_note: icp.features_note ?? '',
    purchase_triggers: icp.purchase_triggers ?? [],
    features: icp.features ?? [],
    company_countries: icp.company_countries ?? [],
    company_headcount: icp.company_headcount ?? '',
    company_age: icp.company_age ?? '',
    apollo_industries: icp.apollo_industries ?? [],
    funding: icp.funding ?? '',
    dev_team_availability: icp.dev_team_availability ?? '',
    dev_team_location: icp.dev_team_location ?? '',
    include_keywords: icp.include_keywords ?? [],
    exclude_keywords: icp.exclude_keywords ?? [],
    archived: icp.archived,
    personas: personas.map(personaToDraft),
    industries: industries.map(industryToDraft),
  }
}

export function Icp() {
  const { data, upsertIcp, removeIcp, upsertIcpPersona, removeIcpPersona, upsertIcpIndustry, removeIcpIndustry } =
    useData()
  const toast = useToast()
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<Icp | 'new' | null>(null)

  const icps = data?.icps ?? []
  const personas = data?.icpPersonas ?? []
  const industries = data?.icpIndustries ?? []
  const hypotheses = data?.hypotheses ?? []

  const visible = useMemo(
    () => icps.filter((i) => showArchived || !i.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [icps, showArchived],
  )
  const archivedCount = useMemo(() => icps.filter((i) => i.archived).length, [icps])

  const setArchived = async (icp: Icp, archived: boolean) => {
    try {
      const res = await adminPost('/api/playbook', { action: 'save_icp', icp: { id: icp.id, archived } })
      const j = await res.json().catch(() => ({}))
      if (res.status === 401) return toast.error('Wrong admin secret.')
      if (!res.ok) return toast.error(`Couldn't update: ${j.error ?? res.status}`)
      upsertIcp(j.icp)
      toast.success(archived ? 'ICP archived.' : 'ICP restored.')
    } catch (e) {
      toast.error(`Couldn't update: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const del = async (icp: Icp) => {
    const hypCount = hypotheses.filter((h) => h.icp_id === icp.id).length
    const warn = hypCount > 0
      ? ` ${hypCount} hypothesis${hypCount === 1 ? '' : 'es'} using it will become unassigned.`
      : ''
    if (!window.confirm(`Delete "${icp.name}"? This can't be undone.${warn}`)) return
    try {
      const res = await adminPost('/api/playbook', { action: 'delete_icp', id: icp.id })
      const j = await res.json().catch(() => ({}))
      if (res.status === 401) return toast.error('Wrong admin secret.')
      if (!res.ok) return toast.error(`Couldn't delete: ${j.error ?? res.status}`)
      removeIcp(icp.id)
      toast.success('ICP deleted.')
    } catch (e) {
      toast.error(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <>
      <header>
        <div>
          <h1>ICPs</h1>
          <div className="muted small">
            Ideal Customer Profiles — company criteria, keywords, and buyer personas that
            hypotheses target.
          </div>
        </div>
        <div className="controls">
          <button className="btn accent sm" onClick={() => setEditing('new')}>
            <Plus size={14} /> New ICP
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
            icon={Target}
            title={icps.length === 0 ? 'No ICPs yet' : 'No ICPs match this filter'}
            hint={
              icps.length === 0
                ? 'Define an Ideal Customer Profile so hypotheses have something to target.'
                : 'Toggle "Show archived" to see retired ICPs.'
            }
            action={
              icps.length === 0 ? (
                <button className="link-btn" onClick={() => setEditing('new')}>New ICP</button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="search-grid">
          {visible.map((icp) => (
            <IcpCard
              key={icp.id}
              icp={icp}
              personaCount={personas.filter((p) => p.icp_id === icp.id).length}
              industryCount={industries.filter((x) => x.icp_id === icp.id).length}
              hypothesisCount={hypotheses.filter((h) => h.icp_id === icp.id).length}
              onEdit={() => setEditing(icp)}
              onArchive={() => setArchived(icp, !icp.archived)}
              onDelete={() => del(icp)}
            />
          ))}
        </div>
      )}

      {editing && (
        <IcpEditor
          icp={editing === 'new' ? null : editing}
          personas={editing === 'new' ? [] : personas.filter((p) => p.icp_id === editing.id)}
          industries={editing === 'new' ? [] : industries.filter((x) => x.icp_id === editing.id)}
          onClose={() => setEditing(null)}
          onSaved={(icp) => {
            upsertIcp(icp)
            setEditing(null)
          }}
          upsertIcpPersona={upsertIcpPersona}
          removeIcpPersona={removeIcpPersona}
          upsertIcpIndustry={upsertIcpIndustry}
          removeIcpIndustry={removeIcpIndustry}
        />
      )}
    </>
  )
}

function IcpCard({
  icp,
  personaCount,
  industryCount,
  hypothesisCount,
  onEdit,
  onArchive,
  onDelete,
}: {
  icp: Icp
  personaCount: number
  industryCount: number
  hypothesisCount: number
  onEdit: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const context = [icp.main_product, icp.core_sphere].filter(Boolean)
  return (
    <article className={`card search-card${icp.archived ? ' archived' : ''}`}>
      <div className="search-card-head">
        <div className="search-card-title">
          <span className="search-card-name">{icp.name}</span>
          {icp.archived && <span className="badge">Archived</span>}
        </div>
        <div className="search-card-actions">
          <button className="icon-only-btn" title="Edit" onClick={onEdit}>
            <Pencil size={14} />
          </button>
          <button
            className="icon-only-btn"
            title={icp.archived ? 'Restore' : 'Archive'}
            onClick={onArchive}
          >
            {icp.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </button>
          <button className="icon-only-btn danger" title="Delete" onClick={onDelete}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {context.length > 0 && <p className="search-card-desc small">{context.join(' — ')}</p>}
      <div className="muted small">
        {personaCount} persona{personaCount === 1 ? '' : 's'} · {industryCount} industr
        {industryCount === 1 ? 'y' : 'ies'} · {hypothesisCount} hypothesis
        {hypothesisCount === 1 ? '' : 'es'}
      </div>
    </article>
  )
}

// --- Editor -----------------------------------------------------------------

function IcpEditor({
  icp,
  personas,
  industries,
  onClose,
  onSaved,
  upsertIcpPersona,
  removeIcpPersona,
  upsertIcpIndustry,
  removeIcpIndustry,
}: {
  icp: Icp | null
  personas: IcpPersona[]
  industries: IcpIndustry[]
  onClose: () => void
  onSaved: (icp: Icp) => void
  upsertIcpPersona: (p: IcpPersona) => void
  removeIcpPersona: (id: number) => void
  upsertIcpIndustry: (x: IcpIndustry) => void
  removeIcpIndustry: (id: number) => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState<IcpDraft>(() => toDraft(icp, personas, industries))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof IcpDraft>(key: K, value: IcpDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const setPersona = (key: string, patch: Partial<PersonaDraft>) =>
    setDraft((d) => ({
      ...d,
      personas: d.personas.map((p) => (p._key === key ? { ...p, ...patch } : p)),
    }))

  const setIndustry = (key: string, patch: Partial<IndustryDraft>) =>
    setDraft((d) => ({
      ...d,
      industries: d.industries.map((x) => (x._key === key ? { ...x, ...patch } : x)),
    }))

  const save = async () => {
    if (!draft.name.trim()) {
      setError('Name is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const icpPayload = {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        airtable_url: draft.airtable_url.trim() || null,
        main_product: draft.main_product.trim() || null,
        core_sphere: draft.core_sphere.trim() || null,
        secondary_sphere: draft.secondary_sphere.trim() || null,
        product_stage: draft.product_stage.trim() || null,
        monetization: draft.monetization.trim() || null,
        features_note: draft.features_note.trim() || null,
        purchase_triggers: draft.purchase_triggers,
        features: draft.features,
        company_countries: draft.company_countries,
        company_headcount: draft.company_headcount.trim() || null,
        company_age: draft.company_age.trim() || null,
        apollo_industries: draft.apollo_industries,
        funding: draft.funding.trim() || null,
        dev_team_availability: draft.dev_team_availability.trim() || null,
        dev_team_location: draft.dev_team_location.trim() || null,
        include_keywords: draft.include_keywords,
        exclude_keywords: draft.exclude_keywords,
        archived: draft.archived,
      }
      const res = await adminPost('/api/playbook', { action: 'save_icp', icp: icpPayload })
      const j = await res.json().catch(() => ({}))
      if (res.status === 409) return setError('An ICP with this name already exists.')
      if (res.status === 401) return setError('Admin secret is required (or was wrong) to save.')
      if (!res.ok) return setError(j.error ?? `Save failed (${res.status}).`)
      const savedIcp = j.icp as Icp

      // Personas: delete ones removed from the draft, then save the rest
      // (create if no id, partial-patch update if it has one).
      const keptPersonaIds = new Set(draft.personas.filter((p) => p.id).map((p) => p.id))
      for (const original of personas) {
        if (!keptPersonaIds.has(original.id)) {
          const r = await adminPost('/api/playbook', { action: 'delete_icp_persona', id: original.id })
          if (r.ok) removeIcpPersona(original.id)
        }
      }
      for (const p of draft.personas) {
        if (!p.kind.trim()) continue
        const payload = {
          ...(p.id ? { id: p.id } : {}),
          icp_id: savedIcp.id,
          kind: p.kind.trim(),
          job_titles: p.job_titles,
          age_range: p.age_range.trim() || null,
          location: p.location.trim() || null,
          background: p.background.trim() || null,
          profile_status: p.profile_status.trim() || null,
          connections_note: p.connections_note.trim() || null,
          followers_note: p.followers_note.trim() || null,
        }
        const r = await adminPost('/api/playbook', { action: 'save_icp_persona', persona: payload })
        const rj = await r.json().catch(() => ({}))
        if (r.ok) upsertIcpPersona(rj.persona)
      }

      // Industries: same delete-then-save pattern.
      const keptIndustryIds = new Set(draft.industries.filter((x) => x.id).map((x) => x.id))
      for (const original of industries) {
        if (!keptIndustryIds.has(original.id)) {
          const r = await adminPost('/api/playbook', { action: 'delete_icp_industry', id: original.id })
          if (r.ok) removeIcpIndustry(original.id)
        }
      }
      for (const x of draft.industries) {
        if (!x.name.trim()) continue
        const payload = {
          ...(x.id ? { id: x.id } : {}),
          icp_id: savedIcp.id,
          name: x.name.trim(),
          include_keywords: x.include_keywords,
          exclude_keywords: x.exclude_keywords,
        }
        const r = await adminPost('/api/playbook', { action: 'save_icp_industry', industry: payload })
        const rj = await r.json().catch(() => ({}))
        if (r.ok) upsertIcpIndustry(rj.industry)
      }

      onSaved(savedIcp)
      toast.success('ICP saved.')
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
        aria-label={draft.id ? 'Edit ICP' : 'New ICP'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pipe-modal-head">
          <span>{draft.id ? 'Edit ICP' : 'New ICP'}</span>
          <button className="conv-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="search-form">
          <div className="search-form-grid">
            <label className="filter-field">
              <span className="filter-label">Name</span>
              <input
                autoFocus
                value={draft.name}
                placeholder="e.g. Web 2 Mob"
                onChange={(e) => set('name', e.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="filter-label">Airtable URL</span>
              <input
                value={draft.airtable_url}
                placeholder="https://airtable.com/…"
                onChange={(e) => set('airtable_url', e.target.value)}
              />
            </label>
          </div>

          <h3 className="search-group-head">Product context</h3>
          <div className="search-form-grid">
            <label className="filter-field">
              <span className="filter-label">Main product</span>
              <input value={draft.main_product} onChange={(e) => set('main_product', e.target.value)} />
            </label>
            <label className="filter-field">
              <span className="filter-label">Product stage</span>
              <input value={draft.product_stage} onChange={(e) => set('product_stage', e.target.value)} />
            </label>
            <label className="filter-field">
              <span className="filter-label">Core sphere</span>
              <input value={draft.core_sphere} onChange={(e) => set('core_sphere', e.target.value)} />
            </label>
            <label className="filter-field">
              <span className="filter-label">Secondary sphere</span>
              <input value={draft.secondary_sphere} onChange={(e) => set('secondary_sphere', e.target.value)} />
            </label>
            <label className="filter-field">
              <span className="filter-label">Monetization</span>
              <input value={draft.monetization} onChange={(e) => set('monetization', e.target.value)} />
            </label>
            <label className="filter-field">
              <span className="filter-label">Funding</span>
              <input value={draft.funding} onChange={(e) => set('funding', e.target.value)} />
            </label>
          </div>
          <label className="filter-field">
            <span className="filter-label">Features note</span>
            <textarea rows={2} value={draft.features_note} onChange={(e) => set('features_note', e.target.value)} />
          </label>
          <label className="filter-field">
            <span className="filter-label">Features</span>
            <ChipInput values={draft.features} onChange={(v) => set('features', v)} placeholder="Type a feature, press Enter" />
          </label>
          <label className="filter-field">
            <span className="filter-label">Purchase triggers</span>
            <ChipInput
              values={draft.purchase_triggers}
              onChange={(v) => set('purchase_triggers', v)}
              placeholder="Why they buy — type one, press Enter"
            />
          </label>

          <h3 className="search-group-head">Company criteria</h3>
          <label className="filter-field">
            <span className="filter-label">Countries</span>
            <ChipInput
              values={draft.company_countries}
              onChange={(v) => set('company_countries', v)}
              placeholder="Type a country, press Enter"
            />
          </label>
          <div className="search-form-grid">
            <label className="filter-field">
              <span className="filter-label">Headcount</span>
              <input value={draft.company_headcount} onChange={(e) => set('company_headcount', e.target.value)} />
            </label>
            <label className="filter-field">
              <span className="filter-label">Company age</span>
              <input value={draft.company_age} onChange={(e) => set('company_age', e.target.value)} />
            </label>
            <label className="filter-field">
              <span className="filter-label">Dev team availability</span>
              <input
                value={draft.dev_team_availability}
                onChange={(e) => set('dev_team_availability', e.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="filter-label">Dev team location</span>
              <input
                value={draft.dev_team_location}
                onChange={(e) => set('dev_team_location', e.target.value)}
              />
            </label>
          </div>
          <label className="filter-field">
            <span className="filter-label">Apollo industries</span>
            <ChipInput
              values={draft.apollo_industries}
              onChange={(v) => set('apollo_industries', v)}
              placeholder="Type an industry, press Enter"
            />
          </label>

          <h3 className="search-group-head">ICP-wide keywords</h3>
          <div className="muted small">
            Distinct from each industry's own keywords below — the two are never merged.
          </div>
          <label className="filter-field">
            <span className="filter-label">Include keywords</span>
            <ChipInput
              values={draft.include_keywords}
              variant="include"
              onChange={(v) => set('include_keywords', v)}
              placeholder="Type a keyword, press Enter"
            />
          </label>
          <label className="filter-field">
            <span className="filter-label">Exclude keywords</span>
            <ChipInput
              values={draft.exclude_keywords}
              variant="exclude"
              onChange={(v) => set('exclude_keywords', v)}
              placeholder="Type a keyword, press Enter"
            />
          </label>

          <h3 className="search-group-head">Buyer personas</h3>
          <div className="kv-editor">
            {draft.personas.map((p) => (
              <div className="card icp-subentity" key={p._key}>
                <div className="icp-subentity-head">
                  <input
                    className="icp-subentity-title"
                    value={p.kind}
                    placeholder="Persona name (e.g. management)"
                    onChange={(e) => setPersona(p._key, { kind: e.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-only-btn danger"
                    aria-label="Remove persona"
                    onClick={() => set('personas', draft.personas.filter((x) => x._key !== p._key))}
                  >
                    <X size={13} />
                  </button>
                </div>
                <label className="filter-field">
                  <span className="filter-label">Job titles</span>
                  <ChipInput
                    values={p.job_titles}
                    onChange={(v) => setPersona(p._key, { job_titles: v })}
                    placeholder="Type a title, press Enter"
                  />
                </label>
                <div className="search-form-grid">
                  <label className="filter-field">
                    <span className="filter-label">Age range</span>
                    <input value={p.age_range} onChange={(e) => setPersona(p._key, { age_range: e.target.value })} />
                  </label>
                  <label className="filter-field">
                    <span className="filter-label">Location</span>
                    <input value={p.location} onChange={(e) => setPersona(p._key, { location: e.target.value })} />
                  </label>
                  <label className="filter-field">
                    <span className="filter-label">Connections</span>
                    <input
                      value={p.connections_note}
                      onChange={(e) => setPersona(p._key, { connections_note: e.target.value })}
                    />
                  </label>
                  <label className="filter-field">
                    <span className="filter-label">Followers</span>
                    <input
                      value={p.followers_note}
                      onChange={(e) => setPersona(p._key, { followers_note: e.target.value })}
                    />
                  </label>
                </div>
                <label className="filter-field">
                  <span className="filter-label">Background</span>
                  <input value={p.background} onChange={(e) => setPersona(p._key, { background: e.target.value })} />
                </label>
                <label className="filter-field">
                  <span className="filter-label">LinkedIn profile status</span>
                  <input
                    value={p.profile_status}
                    onChange={(e) => setPersona(p._key, { profile_status: e.target.value })}
                  />
                </label>
              </div>
            ))}
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                set('personas', [
                  ...draft.personas,
                  {
                    _key: nextKey(), kind: '', job_titles: [], age_range: '', location: '',
                    background: '', profile_status: '', connections_note: '', followers_note: '',
                  },
                ])
              }
            >
              <Plus size={13} /> Add persona
            </button>
          </div>

          <h3 className="search-group-head">Industries</h3>
          <div className="muted small">
            Per-industry keyword refinements — start empty; not merged with the ICP-wide list above.
          </div>
          <div className="kv-editor">
            {draft.industries.map((x) => (
              <div className="card icp-subentity" key={x._key}>
                <div className="icp-subentity-head">
                  <input
                    className="icp-subentity-title"
                    value={x.name}
                    placeholder="Industry name"
                    onChange={(e) => setIndustry(x._key, { name: e.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-only-btn danger"
                    aria-label="Remove industry"
                    onClick={() => set('industries', draft.industries.filter((y) => y._key !== x._key))}
                  >
                    <X size={13} />
                  </button>
                </div>
                <label className="filter-field">
                  <span className="filter-label">Include keywords</span>
                  <ChipInput
                    values={x.include_keywords}
                    variant="include"
                    onChange={(v) => setIndustry(x._key, { include_keywords: v })}
                    placeholder="Type a keyword, press Enter"
                  />
                </label>
                <label className="filter-field">
                  <span className="filter-label">Exclude keywords</span>
                  <ChipInput
                    values={x.exclude_keywords}
                    variant="exclude"
                    onChange={(v) => setIndustry(x._key, { exclude_keywords: v })}
                    placeholder="Type a keyword, press Enter"
                  />
                </label>
              </div>
            ))}
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                set('industries', [
                  ...draft.industries,
                  { _key: nextKey(), name: '', include_keywords: [], exclude_keywords: [] },
                ])
              }
            >
              <Plus size={13} /> Add industry
            </button>
          </div>
        </div>

        {error && <div className="banner conv-error">{error}</div>}

        <div className="pipe-modal-actions">
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          <button className="btn accent sm" onClick={save} disabled={saving || !draft.name.trim()}>
            {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Create ICP'}
          </button>
        </div>
      </div>
    </div>
  )
}
