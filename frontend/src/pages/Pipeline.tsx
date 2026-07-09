import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import { useConversation } from '../lib/ConversationContext'
import { useToast } from '../lib/ToastContext'
import { usePipelineActions } from '../lib/usePipelineActions'
import { InitialsAvatar } from '../components/Avatar'
import { LostReasonModal } from '../components/LostReasonModal'
import { instanceName } from '../lib/leads'
import {
  PIPELINE_STAGES, daysInStage, stageColor, substatusLabel,
} from '../lib/pipeline'
import { num } from '../lib/format'
import type { Lead } from '../lib/types'

// Intake lane: replies that haven't been triaged into the pipeline yet.
const INTAKE = 'untriaged'

export function Pipeline() {
  const { data } = useData()
  const { openConversation } = useConversation()
  const toast = useToast()
  const { setStage, assign, actor, setActor, members, addMember, memberName } =
    usePipelineActions()
  const [params, setParams] = useSearchParams()

  const inst = params.get('inst') ?? 'all'
  const camp = params.get('camp') ?? 'all'
  const who = params.get('who') ?? 'all'
  const q = params.get('q') ?? ''

  const [qInput, setQInput] = useState(q)
  useEffect(() => {
    const id = setTimeout(() => {
      const t = qInput.trim()
      if (t === q) return
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        if (t) next.set('q', t)
        else next.delete('q')
        return next
      }, { replace: true })
    }, 200)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput])
  useEffect(() => {
    setQInput(q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value === 'all' || value === '') next.delete(key)
    else next.set(key, value)
    if (key === 'inst') next.delete('camp')
    setParams(next, { replace: true })
  }

  // A camp from a shared link can belong to another account than `inst`.
  const campInstance = data?.campaigns.find((c) => c.campaign_id === camp)?.instance_id
  const effCamp =
    camp !== 'all' && inst !== 'all' && campInstance && campInstance !== inst ? 'all' : camp

  const filtered = useMemo(() => {
    if (!data) return []
    const needle = q.trim().toLowerCase()
    return data.leads.filter((l) => {
      if (inst !== 'all' && l.instance_id !== inst) return false
      if (effCamp !== 'all' && l.campaign_id !== effCamp) return false
      if (who === 'unassigned' && l.assigned_to != null) return false
      if (who !== 'all' && who !== 'unassigned' && String(l.assigned_to) !== who) return false
      if (needle) {
        const hay = `${l.full_name ?? ''} ${l.headline ?? ''} ${l.company ?? ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [data, inst, effCamp, who, q])

  // Bucket into the intake lane + one bucket per stage id.
  const columns = useMemo(() => {
    const byId = new Map<string, Lead[]>()
    byId.set(INTAKE, [])
    for (const s of PIPELINE_STAGES) byId.set(s.id, [])
    for (const l of filtered) {
      if (l.pipeline_stage && byId.has(l.pipeline_stage)) byId.get(l.pipeline_stage)!.push(l)
      else if (l.replied_at && !l.pipeline_stage) byId.get(INTAKE)!.push(l)
    }
    const sortByTs = (get: (l: Lead) => string | null) => (a: Lead, b: Lead) =>
      (get(b) ?? '').localeCompare(get(a) ?? '')
    byId.get(INTAKE)!.sort(sortByTs((l) => l.replied_at))
    for (const s of PIPELINE_STAGES)
      byId.get(s.id)!.sort(sortByTs((l) => l.pipeline_stage_changed_at))
    return byId
  }, [filtered])

  const [dragOver, setDragOver] = useState<string | null>(null)
  const [pendingLost, setPendingLost] = useState<Lead | null>(null)
  // Distinguish a drag-drop from a click so the card click doesn't fire mid-drag.
  const draggingId = useRef<string | null>(null)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  if (!data) return null

  const campaignName = (id: string) =>
    data.campaigns.find((c) => c.campaign_id === id)?.campaign_name ?? id
  const campaignOptions = data.campaigns.filter((c) => inst === 'all' || c.instance_id === inst)
  const activeMembers = members.filter((m) => m.active)

  const handleDrop = (leadId: string, colId: string) => {
    const lead = data.leads.find((l) => l.id === leadId)
    if (!lead) return
    if (colId === INTAKE) {
      if (lead.pipeline_stage) void setStage(lead, null)
      return
    }
    if (colId === lead.pipeline_stage) return
    if (colId === 'lost') {
      setPendingLost(lead)
      return
    }
    void setStage(lead, colId)
  }

  const submitMember = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      await addMember(name)
      setActor(name)
      setNewName('')
      setAdding(false)
    } catch (e) {
      toast.error(`Couldn't add member: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const boardColumns: Array<{ id: string; label: string; color: string; sub: string[] }> = [
    { id: INTAKE, label: 'Untriaged replies', color: 'var(--warning)', sub: [] },
    ...PIPELINE_STAGES.map((s) => ({
      id: s.id,
      label: s.label,
      color: stageColor(s.id),
      sub: s.substatuses,
    })),
  ]

  return (
    <>
      <header>
        <div>
          <h1>Pipeline</h1>
          <div className="muted small">
            Drag replies into the funnel and track them by hand. Filters are kept in the URL.
          </div>
        </div>
        <div className="controls">
          <label className="filter-field">
            <span className="filter-label">Who am I</span>
            {adding ? (
              <span className="pipe-add-member">
                <input
                  autoFocus
                  value={newName}
                  placeholder="Name"
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitMember()
                    if (e.key === 'Escape') {
                      setAdding(false)
                      setNewName('')
                    }
                  }}
                />
                <button className="btn accent sm" onClick={() => void submitMember()}>
                  Add
                </button>
              </span>
            ) : (
              <select
                value={actor}
                onChange={(e) => {
                  if (e.target.value === '__add__') setAdding(true)
                  else setActor(e.target.value)
                }}
              >
                <option value="">— pick —</option>
                {activeMembers.map((m) => (
                  <option key={m.id} value={m.name}>{m.name}</option>
                ))}
                <option value="__add__">＋ Add member…</option>
              </select>
            )}
          </label>
        </div>
      </header>

      <div className="filter-bar card">
        <label className="filter-field filter-field-grow">
          <span className="filter-label">Search</span>
          <input
            type="search"
            placeholder="Name, headline, company…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
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
          <span className="filter-label">Assignee</span>
          <select value={who} onChange={(e) => setFilter('who', e.target.value)}>
            <option value="all">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={String(m.id)}>{m.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="pipe-board">
        {boardColumns.map((col) => {
          const cards = columns.get(col.id) ?? []
          return (
            <section
              key={col.id}
              className={`pipe-col ${dragOver === col.id ? 'drag-over' : ''}`}
              style={{ borderTopColor: col.color }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(col.id)
              }}
              onDragLeave={(e) => {
                // Only clear when leaving the column, not entering a child.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(null)
                const id = e.dataTransfer.getData('text/plain')
                if (id) handleDrop(id, col.id)
              }}
            >
              <div className="pipe-col-head">
                <span className="pipe-dot" style={{ background: col.color }} aria-hidden="true" />
                <span className="pipe-col-label">{col.label}</span>
                <span className="pipe-count">{num(cards.length)}</span>
              </div>
              <div className="pipe-col-body">
                {cards.map((l) => (
                  <PipeCard
                    key={l.id}
                    lead={l}
                    columnId={col.id}
                    substatuses={col.sub}
                    campaignName={campaignName(l.campaign_id)}
                    assigneeName={memberName(l.assigned_to)}
                    members={activeMembers.length ? activeMembers : members}
                    onOpen={() => openConversation(l)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', l.id)
                      e.dataTransfer.effectAllowed = 'move'
                      draggingId.current = l.id
                    }}
                    onDragEnd={() => {
                      draggingId.current = null
                    }}
                    onStage={(stage) => {
                      if (stage === 'lost') setPendingLost(l)
                      else void setStage(l, stage || null)
                    }}
                    onSubstatus={(sub) => void setStage(l, l.pipeline_stage, { substatus: sub })}
                    onAssign={(memberId) => void assign(l, memberId)}
                    draggingRef={draggingId}
                  />
                ))}
                {cards.length === 0 && <div className="pipe-empty muted small">—</div>}
              </div>
            </section>
          )
        })}
      </div>

      {pendingLost && (
        <LostReasonModal
          leadName={pendingLost.full_name}
          onCancel={() => setPendingLost(null)}
          onConfirm={(reason) => {
            const lead = pendingLost
            setPendingLost(null)
            void setStage(lead, 'lost', { lostReason: reason })
          }}
        />
      )}
    </>
  )
}

function PipeCard({
  lead,
  columnId,
  substatuses,
  campaignName,
  assigneeName,
  members,
  onOpen,
  onDragStart,
  onDragEnd,
  onStage,
  onSubstatus,
  onAssign,
  draggingRef,
}: {
  lead: Lead
  columnId: string
  substatuses: string[]
  campaignName: string
  assigneeName: string
  members: { id: number; name: string }[]
  onOpen: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onStage: (stage: string) => void
  onSubstatus: (sub: string | null) => void
  onAssign: (memberId: number | null) => void
  draggingRef: React.MutableRefObject<string | null>
}) {
  const name = lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')
  const days = daysInStage(lead)
  const isIntake = columnId === INTAKE
  const currentStage = lead.pipeline_stage ?? ''

  // Interactive children stop propagation so they don't start a drag or open the
  // drawer. `stopControl` marks a mousedown so the parent doesn't become drag-source.
  const stopControl = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <article
      className="pipe-card"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={{ borderLeftColor: stageColor(isIntake ? null : columnId) }}
      onClick={() => {
        if (draggingRef.current) return
        onOpen()
      }}
    >
      <div className="pipe-card-name">{name}</div>
      {lead.company && <div className="pipe-card-sub muted small">{lead.company}</div>}
      <div className="pipe-card-camp muted small ellipsis" title={campaignName}>
        {campaignName}
      </div>

      {(assigneeName || days != null) && (
        <div className="pipe-card-foot">
          {assigneeName && (
            <span className="assignee-chip" title={assigneeName}>
              <InitialsAvatar name={assigneeName} size={20} />
            </span>
          )}
          {days != null && (
            <span className="pipe-days muted small" title="Days in this stage">
              {days}d
            </span>
          )}
        </div>
      )}

      {substatuses.length > 0 && (
        <select
          className="substatus-chip"
          value={lead.pipeline_substatus ?? ''}
          draggable={false}
          onMouseDown={stopControl}
          onClick={stopControl}
          onChange={(e) => onSubstatus(e.target.value || null)}
        >
          <option value="">Substatus…</option>
          {substatuses.map((s) => (
            <option key={s} value={s}>{substatusLabel(s)}</option>
          ))}
        </select>
      )}

      <div className="pipe-card-controls">
        <select
          className="pipe-stage-select"
          value={isIntake ? '' : currentStage}
          draggable={false}
          onMouseDown={stopControl}
          onClick={stopControl}
          onChange={(e) => onStage(e.target.value)}
        >
          {isIntake && <option value="">Move to…</option>}
          {PIPELINE_STAGES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <select
          className="pipe-assign-select"
          value={String(lead.assigned_to ?? '')}
          draggable={false}
          onMouseDown={stopControl}
          onClick={stopControl}
          onChange={(e) => onAssign(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={String(m.id)}>{m.name}</option>
          ))}
        </select>
      </div>
    </article>
  )
}
