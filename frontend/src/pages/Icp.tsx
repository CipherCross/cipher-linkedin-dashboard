import { useMemo, useRef, useState } from 'react'
import {
  Archive, ArchiveRestore, ChevronDown, ChevronUp, ExternalLink, Pencil, Plus, Target, Trash2, X,
} from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { authPost } from '../lib/api'
import { ChipInput } from '../components/ChipInput'
import { CopyButton } from '../components/CopyButton'
import { Chip, LibraryCard } from '../components/library'
import type { Icp, IcpIndustry, IcpPersona } from '../lib/types'
import {
  Badge, Button, Checkbox, Dialog, EmptyState, IconButton, InlineError, PageHeader, Panel,
  SectionHeader, TextField, TextareaField, Toolbar, useDirtyGuard,
} from '../ui'
import { COPY } from '../ui/labels'

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
  }
}

function toDraft(icp: Icp | null, personas: IcpPersona[], industries: IcpIndustry[]): IcpDraft {
  if (!icp) {
    return {
      name: '', airtable_url: '', main_product: '', core_sphere: '', secondary_sphere: '',
      product_stage: '', monetization: '', features_note: '', purchase_triggers: [], features: [],
      company_countries: [], company_headcount: '', company_age: '', apollo_industries: [],
      funding: '', dev_team_availability: '', dev_team_location: '',
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
  const [viewingId, setViewingId] = useState<number | null>(null)

  const icps = data?.icps ?? []
  const personas = data?.icpPersonas ?? []
  const industries = data?.icpIndustries ?? []
  const hypotheses = data?.hypotheses ?? []

  // Derive the viewed ICP from live data (not a click-time snapshot) so an edit
  // elsewhere / the 5-min refetch keeps the open viewer consistent, and it
  // self-closes if the ICP is deleted.
  const viewing = viewingId != null ? icps.find((i) => i.id === viewingId) ?? null : null

  const visible = useMemo(
    () => icps.filter((i) => showArchived || !i.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [icps, showArchived],
  )
  const archivedCount = useMemo(() => icps.filter((i) => i.archived).length, [icps])

  const setArchived = async (icp: Icp, archived: boolean) => {
    try {
      const res = await authPost('/api/playbook', { action: 'save_icp', icp: { id: icp.id, archived } })
      const j = await res.json().catch(() => ({}))
      if (res.status === 401 || res.status === 403) return toast.error('Admin access required.')
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
      const res = await authPost('/api/playbook', { action: 'delete_icp', id: icp.id })
      const j = await res.json().catch(() => ({}))
      if (res.status === 401 || res.status === 403) return toast.error('Admin access required.')
      if (!res.ok) return toast.error(`Couldn't delete: ${j.error ?? res.status}`)
      removeIcp(icp.id)
      toast.success('ICP deleted.')
    } catch (e) {
      toast.error(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <>
      <PageHeader
        title="ICPs"
        description="Ideal Customer Profiles — company criteria, keywords and buyer personas that hypotheses target."
        actions={
          <Button variant="primary" icon={<Plus aria-hidden="true" />} onClick={() => setEditing('new')}>
            New ICP
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
            kind={icps.length === 0 ? 'empty' : 'no-match'}
            icon={Target}
            title={icps.length === 0 ? 'No ICPs yet' : 'No ICPs match this filter'}
            hint={
              icps.length === 0
                ? 'Define an Ideal Customer Profile so hypotheses have something to target.'
                : 'Toggle "Show archived" to see retired ICPs.'
            }
            action={
              icps.length === 0 ? (
                <Button variant="primary" onClick={() => setEditing('new')}>New ICP</Button>
              ) : undefined
            }
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-app-lg">
          {visible.map((icp) => (
            <IcpCard
              key={icp.id}
              icp={icp}
              personaCount={personas.filter((p) => p.icp_id === icp.id).length}
              industryCount={industries.filter((x) => x.icp_id === icp.id).length}
              hypothesisCount={hypotheses.filter((h) => h.icp_id === icp.id).length}
              onView={() => setViewingId(icp.id)}
              onEdit={() => setEditing(icp)}
              onArchive={() => setArchived(icp, !icp.archived)}
              onDelete={() => del(icp)}
            />
          ))}
        </div>
      )}

      {viewing && (
        <IcpViewer
          icp={viewing}
          personas={personas.filter((p) => p.icp_id === viewing.id)}
          industries={industries.filter((x) => x.icp_id === viewing.id)}
          hypothesisCount={hypotheses.filter((h) => h.icp_id === viewing.id).length}
          onClose={() => setViewingId(null)}
          onEdit={() => {
            setEditing(viewing)
            setViewingId(null)
          }}
        />
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
  onView,
  onEdit,
  onArchive,
  onDelete,
}: {
  icp: Icp
  personaCount: number
  industryCount: number
  hypothesisCount: number
  onView: () => void
  onEdit: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const context = [icp.main_product, icp.core_sphere].filter(Boolean)
  return (
    <LibraryCard
      title={icp.name}
      openLabel={`Open ICP ${icp.name}`}
      onOpen={onView}
      archived={icp.archived}
      actions={<>
        <IconButton label="Edit" icon={<Pencil aria-hidden="true" />} onClick={onEdit} />
        <IconButton
          label={icp.archived ? 'Restore' : 'Archive'}
          icon={icp.archived ? <ArchiveRestore size={20} aria-hidden="true" /> : <Archive size={20} aria-hidden="true" />}
          onClick={onArchive}
        />
        <IconButton label="Delete" tone="danger" icon={<Trash2 aria-hidden="true" />} onClick={onDelete} />
      </>}
      footer={<>
        {personaCount} persona{personaCount === 1 ? '' : 's'} · {industryCount} industr
        {industryCount === 1 ? 'y' : 'ies'} · {hypothesisCount} hypothesis
        {hypothesisCount === 1 ? '' : 'es'}
      </>}
    >
      {context.length > 0 && <p className="m-0 text-app-table text-app-text-secondary">{context.join(' — ')}</p>}
    </LibraryCard>
  )
}

// --- Read-only viewer -------------------------------------------------------

// A labelled scalar value with a copy button. Renders nothing when empty so the
// viewer only shows fields that are actually filled in.
function ViewField({
  label,
  value,
  link,
}: {
  label: string
  value: string | null | undefined
  link?: boolean
}) {
  if (!value || !value.trim()) return null
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-app-meta font-medium text-app-text-muted">{label}</span>
      <div className="flex items-start justify-between gap-2 min-w-0">
        {link ? (
          <a
            href={value}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 min-w-0 [word-break:break-all] text-app-accent hover:underline"
          >
            {value}
            <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
          </a>
        ) : (
          <span className="min-w-0 [word-break:break-word] whitespace-pre-wrap">{value}</span>
        )}
        <CopyButton text={value} title={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  )
}

// A labelled string-array shown as read-only chips, copyable as a comma list.
// Long keyword lists (the ICP-wide exclude list runs into the dozens) are
// collapsed to the first COLLAPSED_CHIPS by default; a chevron toggle reveals
// the rest inline so the viewer isn't dominated by one field.
const COLLAPSED_CHIPS = 12

function ViewChips({
  label,
  values,
  variant,
}: {
  label: string
  values: string[]
  variant?: 'include' | 'exclude'
}) {
  const [expanded, setExpanded] = useState(false)
  if (!values || values.length === 0) return null
  const collapsible = values.length > COLLAPSED_CHIPS
  const shown = collapsible && !expanded ? values.slice(0, COLLAPSED_CHIPS) : values
  const hidden = values.length - shown.length
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-app-meta font-medium text-app-text-muted">{label}</span>
        {collapsible && <span className="text-app-meta text-app-text-muted">{values.length}</span>}
        <CopyButton text={values.join(', ')} title={`Copy ${label.toLowerCase()}`} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((v) => (
          <Chip tone={variant ?? 'include'} key={v}>{v}</Chip>
        ))}
        {collapsible && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? (
              <>
                Show less <ChevronUp size={12} aria-hidden="true" />
              </>
            ) : (
              <>
                +{hidden} more <ChevronDown size={12} aria-hidden="true" />
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

// Plaintext dump of the whole ICP for the header "Copy all" button.
function icpToText(icp: Icp, personas: IcpPersona[], industries: IcpIndustry[]): string {
  const lines: string[] = []
  const field = (label: string, value: string | null | undefined) => {
    if (value && value.trim()) lines.push(`${label}: ${value.trim()}`)
  }
  const list = (label: string, values: string[]) => {
    if (values && values.length) lines.push(`${label}: ${values.join(', ')}`)
  }
  lines.push(icp.name)
  field('Airtable URL', icp.airtable_url)
  field('Main product', icp.main_product)
  field('Product stage', icp.product_stage)
  field('Core sphere', icp.core_sphere)
  field('Secondary sphere', icp.secondary_sphere)
  field('Monetization', icp.monetization)
  field('Funding', icp.funding)
  field('Features note', icp.features_note)
  list('Features', icp.features)
  list('Purchase triggers', icp.purchase_triggers)
  list('Countries', icp.company_countries)
  field('Headcount', icp.company_headcount)
  field('Company age', icp.company_age)
  field('Dev team availability', icp.dev_team_availability)
  field('Dev team location', icp.dev_team_location)
  list('Apollo industries', icp.apollo_industries)
  list('Exclude keywords', icp.exclude_keywords)
  for (const p of personas) {
    lines.push('', `Persona — ${p.kind}`)
    list('  Job titles', p.job_titles)
    field('  Age range', p.age_range)
    field('  Location', p.location)
    field('  Connections', p.connections_note)
    field('  Followers', p.followers_note)
    field('  Background', p.background)
    field('  Profile status', p.profile_status)
  }
  for (const x of industries) {
    lines.push('', `Industry — ${x.name}`)
    list('  Include keywords', x.include_keywords)
  }
  return lines.join('\n')
}

function IcpViewer({
  icp,
  personas,
  industries,
  hypothesisCount,
  onClose,
  onEdit,
}: {
  icp: Icp
  personas: IcpPersona[]
  industries: IcpIndustry[]
  hypothesisCount: number
  onClose: () => void
  onEdit: () => void
}) {
  const hasProduct =
    icp.main_product || icp.product_stage || icp.core_sphere || icp.secondary_sphere ||
    icp.monetization || icp.funding || icp.features_note ||
    icp.features.length || icp.purchase_triggers.length
  const hasCompany =
    icp.company_countries.length || icp.company_headcount || icp.company_age ||
    icp.dev_team_availability || icp.dev_team_location || icp.apollo_industries.length
  const hasKeywords = icp.exclude_keywords.length

  return (
    <Dialog
      size="xl"
      title={<>
        {icp.name}
        {icp.archived && <Badge className="ml-2">Archived</Badge>}
      </>}
      description={<>
        {personas.length} persona{personas.length === 1 ? '' : 's'} · {industries.length} industr
        {industries.length === 1 ? 'y' : 'ies'} · {hypothesisCount} hypothesis
        {hypothesisCount === 1 ? '' : 'es'}
      </>}
      onRequestClose={onClose}
      footer={<>
        <CopyButton text={icpToText(icp, personas, industries)} title="Copy all fields" />
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button variant="primary" icon={<Pencil aria-hidden="true" />} onClick={onEdit}>
          Edit ICP
        </Button>
      </>}
    >
      <div className="flex flex-col gap-app-lg">
        <ViewField label="Airtable URL" value={icp.airtable_url} link />

        {hasProduct ? (
          <>
            <SectionHeader title="Product context" level="subsection" />
            <div className="grid grid-cols-2 gap-app-lg max-[560px]:grid-cols-1">
              <ViewField label="Main product" value={icp.main_product} />
              <ViewField label="Product stage" value={icp.product_stage} />
              <ViewField label="Core sphere" value={icp.core_sphere} />
              <ViewField label="Secondary sphere" value={icp.secondary_sphere} />
              <ViewField label="Monetization" value={icp.monetization} />
              <ViewField label="Funding" value={icp.funding} />
            </div>
            <ViewField label="Features note" value={icp.features_note} />
            <ViewChips label="Features" values={icp.features} />
            <ViewChips label="Purchase triggers" values={icp.purchase_triggers} />
          </>
        ) : null}

        {hasCompany ? (
          <>
            <SectionHeader title="Company criteria" level="subsection" />
            <ViewChips label="Countries" values={icp.company_countries} />
            <div className="grid grid-cols-2 gap-app-lg max-[560px]:grid-cols-1">
              <ViewField label="Headcount" value={icp.company_headcount} />
              <ViewField label="Company age" value={icp.company_age} />
              <ViewField label="Dev team availability" value={icp.dev_team_availability} />
              <ViewField label="Dev team location" value={icp.dev_team_location} />
            </div>
            <ViewChips label="Apollo industries" values={icp.apollo_industries} />
          </>
        ) : null}

        {hasKeywords ? (
          <>
            <SectionHeader title="ICP-wide exclude keywords" level="subsection" />
            <ViewChips label="Exclude keywords" values={icp.exclude_keywords} variant="exclude" />
          </>
        ) : null}

        {personas.length > 0 && (
          <>
            <SectionHeader title="Buyer personas" level="subsection" />
            <div className="flex flex-col gap-app-sm">
              {personas.map((p) => (
                <div className="flex flex-col gap-app-sm p-2.5 border border-app-border rounded-card bg-app-surface-2" key={p.id}>
                  <div className="flex items-center gap-app-sm">
                    <span className="flex-1 min-w-0 font-semibold break-words">{p.kind}</span>
                    <CopyButton text={`Persona — ${p.kind}`} title="Copy persona name" />
                  </div>
                  <ViewChips label="Job titles" values={p.job_titles} />
                  <div className="grid grid-cols-2 gap-app-lg max-[560px]:grid-cols-1">
                    <ViewField label="Age range" value={p.age_range} />
                    <ViewField label="Location" value={p.location} />
                    <ViewField label="Connections" value={p.connections_note} />
                    <ViewField label="Followers" value={p.followers_note} />
                  </div>
                  <ViewField label="Background" value={p.background} />
                  <ViewField label="LinkedIn profile status" value={p.profile_status} />
                </div>
              ))}
            </div>
          </>
        )}

        {industries.length > 0 && (
          <>
            <SectionHeader title="Industries" level="subsection" />
            <div className="flex flex-col gap-app-sm">
              {industries.map((x) => (
                <div className="flex flex-col gap-app-sm p-2.5 border border-app-border rounded-card bg-app-surface-2" key={x.id}>
                  <div className="flex items-center gap-app-sm">
                    <span className="flex-1 min-w-0 font-semibold break-words">{x.name}</span>
                  </div>
                  <ViewChips label="Include keywords" values={x.include_keywords} variant="include" />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Dialog>
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
  // Captured once, from the same initial value `draft` was seeded with above —
  // never recomputed, so a background refetch of `personas`/`industries` (new
  // array identity, same content) can't make a clean draft read as dirty.
  const initialRef = useRef(draft)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialRef.current)
  const { guard, prompt } = useDirtyGuard(dirty)
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
        exclude_keywords: draft.exclude_keywords,
        archived: draft.archived,
      }
      const res = await authPost('/api/playbook', { action: 'save_icp', icp: icpPayload })
      const j = await res.json().catch(() => ({}))
      if (res.status === 409) return setError('An ICP with this name already exists.')
      if (res.status === 401 || res.status === 403) return setError('Admin access is required to save.')
      if (!res.ok) return setError(j.error ?? `Save failed (${res.status}).`)
      const savedIcp = j.icp as Icp

      // Personas: delete ones removed from the draft, then save the rest
      // (create if no id, partial-patch update if it has one).
      const keptPersonaIds = new Set(draft.personas.filter((p) => p.id).map((p) => p.id))
      for (const original of personas) {
        if (!keptPersonaIds.has(original.id)) {
          const r = await authPost('/api/playbook', { action: 'delete_icp_persona', id: original.id })
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
        const r = await authPost('/api/playbook', { action: 'save_icp_persona', persona: payload })
        const rj = await r.json().catch(() => ({}))
        if (r.ok) upsertIcpPersona(rj.persona)
      }

      // Industries: same delete-then-save pattern.
      const keptIndustryIds = new Set(draft.industries.filter((x) => x.id).map((x) => x.id))
      for (const original of industries) {
        if (!keptIndustryIds.has(original.id)) {
          const r = await authPost('/api/playbook', { action: 'delete_icp_industry', id: original.id })
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
        }
        const r = await authPost('/api/playbook', { action: 'save_icp_industry', industry: payload })
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
    <>
      {prompt}
      <Dialog
        size="xl"
        title={draft.id ? 'Edit ICP' : 'New ICP'}
        onRequestClose={() => guard(onClose)}
        busy={saving}
        footerNote={error ? undefined : dirty ? COPY.unsavedChanges : undefined}
        footer={<>
          <Button variant="secondary" onClick={() => guard(onClose)} disabled={saving}>{COPY.cancel}</Button>
          <Button
            variant="primary"
            onClick={save}
            loading={saving}
            loadingLabel="Saving the ICP"
            disabled={!draft.name.trim()}
          >
            {draft.id ? 'Save changes' : 'Create ICP'}
          </Button>
        </>}
      >
        {error && <div className="mb-app-lg"><InlineError title="Could not save the ICP." message={error} /></div>}
        <div className="flex flex-col gap-app-lg">
          <div className="grid grid-cols-2 gap-app-lg max-[560px]:grid-cols-1">
            <TextField
              label="Name"
              required
              autoFocus
              value={draft.name}
              placeholder="e.g. Web 2 Mob"
              onChange={(e) => set('name', e.target.value)}
            />
            <TextField
              label="Airtable URL"
              value={draft.airtable_url}
              placeholder="https://airtable.com/…"
              onChange={(e) => set('airtable_url', e.target.value)}
            />
          </div>

          <SectionHeader title="Product context" level="subsection" />
          <div className="grid grid-cols-2 gap-app-lg max-[560px]:grid-cols-1">
            <TextField label="Main product" value={draft.main_product} onChange={(e) => set('main_product', e.target.value)} />
            <TextField label="Product stage" value={draft.product_stage} onChange={(e) => set('product_stage', e.target.value)} />
            <TextField label="Core sphere" value={draft.core_sphere} onChange={(e) => set('core_sphere', e.target.value)} />
            <TextField
              label="Secondary sphere"
              value={draft.secondary_sphere}
              onChange={(e) => set('secondary_sphere', e.target.value)}
            />
            <TextField label="Monetization" value={draft.monetization} onChange={(e) => set('monetization', e.target.value)} />
            <TextField label="Funding" value={draft.funding} onChange={(e) => set('funding', e.target.value)} />
          </div>
          <TextareaField
            label="Features note"
            rows={2}
            value={draft.features_note}
            onChange={(e) => set('features_note', e.target.value)}
          />
          <ChipInput
            label="Features"
            values={draft.features}
            onChange={(v) => set('features', v)}
            placeholder="Type a feature, press Enter"
          />
          <ChipInput
            label="Purchase triggers"
            values={draft.purchase_triggers}
            onChange={(v) => set('purchase_triggers', v)}
            placeholder="Why they buy — type one, press Enter"
          />

          <SectionHeader title="Company criteria" level="subsection" />
          <ChipInput
            label="Countries"
            values={draft.company_countries}
            onChange={(v) => set('company_countries', v)}
            placeholder="Type a country, press Enter"
          />
          <div className="grid grid-cols-2 gap-app-lg max-[560px]:grid-cols-1">
            <TextField
              label="Headcount"
              value={draft.company_headcount}
              onChange={(e) => set('company_headcount', e.target.value)}
            />
            <TextField label="Company age" value={draft.company_age} onChange={(e) => set('company_age', e.target.value)} />
            <TextField
              label="Dev team availability"
              value={draft.dev_team_availability}
              onChange={(e) => set('dev_team_availability', e.target.value)}
            />
            <TextField
              label="Dev team location"
              value={draft.dev_team_location}
              onChange={(e) => set('dev_team_location', e.target.value)}
            />
          </div>
          <ChipInput
            label="Apollo industries"
            values={draft.apollo_industries}
            onChange={(v) => set('apollo_industries', v)}
            placeholder="Type an industry, press Enter"
          />

          <SectionHeader
            title="ICP-wide exclude keywords"
            level="subsection"
            description="One exclude list for the whole ICP. Include keywords are set per sub-industry below."
          />
          <ChipInput
            label="Exclude keywords"
            values={draft.exclude_keywords}
            variant="exclude"
            onChange={(v) => set('exclude_keywords', v)}
            placeholder="Type a keyword, press Enter"
          />

          <fieldset className="m-0 p-0 border-0 flex flex-col gap-app-sm">
            <legend className="mb-app-xs text-app-table font-semibold">Buyer personas</legend>
            {draft.personas.map((p, i) => (
              <div className="flex flex-col gap-app-sm p-2.5 border border-app-border rounded-card bg-app-surface-2" key={p._key}>
                <div className="flex items-center gap-app-sm">
                  <TextField
                    className="flex-1 min-w-0"
                    label={`Persona ${i + 1} name`}
                    labelHidden
                    value={p.kind}
                    placeholder="Persona name (e.g. management)"
                    onChange={(e) => setPersona(p._key, { kind: e.target.value })}
                  />
                  <IconButton
                    label="Remove persona"
                    tone="danger"
                    icon={<X aria-hidden="true" />}
                    onClick={() => set('personas', draft.personas.filter((x) => x._key !== p._key))}
                  />
                </div>
                <ChipInput
                  label="Job titles"
                  values={p.job_titles}
                  onChange={(v) => setPersona(p._key, { job_titles: v })}
                  placeholder="Type a title, press Enter"
                />
                <div className="grid grid-cols-2 gap-app-lg max-[560px]:grid-cols-1">
                  <TextField label="Age range" value={p.age_range} onChange={(e) => setPersona(p._key, { age_range: e.target.value })} />
                  <TextField label="Location" value={p.location} onChange={(e) => setPersona(p._key, { location: e.target.value })} />
                  <TextField
                    label="Connections"
                    value={p.connections_note}
                    onChange={(e) => setPersona(p._key, { connections_note: e.target.value })}
                  />
                  <TextField
                    label="Followers"
                    value={p.followers_note}
                    onChange={(e) => setPersona(p._key, { followers_note: e.target.value })}
                  />
                </div>
                <TextField label="Background" value={p.background} onChange={(e) => setPersona(p._key, { background: e.target.value })} />
                <TextField
                  label="LinkedIn profile status"
                  value={p.profile_status}
                  onChange={(e) => setPersona(p._key, { profile_status: e.target.value })}
                />
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              icon={<Plus aria-hidden="true" />}
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
              Add persona
            </Button>
          </fieldset>

          <fieldset className="m-0 p-0 border-0 flex flex-col gap-app-sm">
            <legend className="mb-app-xs text-app-table font-semibold">Industries</legend>
            <p className="m-0 text-app-meta text-app-text-muted">
              Set include keywords per sub-industry — start empty. The ICP-wide exclude list above applies to all.
            </p>
            {draft.industries.map((x, i) => (
              <div className="flex flex-col gap-app-sm p-2.5 border border-app-border rounded-card bg-app-surface-2" key={x._key}>
                <div className="flex items-center gap-app-sm">
                  <TextField
                    className="flex-1 min-w-0"
                    label={`Industry ${i + 1} name`}
                    labelHidden
                    value={x.name}
                    placeholder="Industry name"
                    onChange={(e) => setIndustry(x._key, { name: e.target.value })}
                  />
                  <IconButton
                    label="Remove industry"
                    tone="danger"
                    icon={<X aria-hidden="true" />}
                    onClick={() => set('industries', draft.industries.filter((y) => y._key !== x._key))}
                  />
                </div>
                <ChipInput
                  label="Include keywords"
                  values={x.include_keywords}
                  variant="include"
                  onChange={(v) => setIndustry(x._key, { include_keywords: v })}
                  placeholder="Type a keyword, press Enter"
                />
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              icon={<Plus aria-hidden="true" />}
              onClick={() =>
                set('industries', [
                  ...draft.industries,
                  { _key: nextKey(), name: '', include_keywords: [] },
                ])
              }
            >
              Add industry
            </Button>
          </fieldset>
        </div>
      </Dialog>
    </>
  )
}
