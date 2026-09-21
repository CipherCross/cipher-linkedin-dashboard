import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useData } from '../lib/DataContext'
import { useConversation } from '../lib/ConversationContext'
import { usePipelineActions } from '../lib/usePipelineActions'
import { InitialsAvatar, LeadAvatar } from '../components/Avatar'
import { LostReasonModal } from '../components/LostReasonModal'
import { accountLabeller } from '../lib/leads'
import {
  PIPELINE_STAGES, daysInStage, stageColor, substatusLabel,
} from '../lib/pipeline'
import { num } from '../lib/format'
import { replyDate, REPLY_TIME_ZONE_LABEL } from '../lib/replyTime'
import {
  activeFollowUp,
  followUpBucket,
  followUpDueLabel,
  followUpKey,
  followUpStateMap,
  latestConversationMessageMap,
  messageSnippet,
} from '../lib/followUps'
import type { ConversationLatestMessage, FollowUpState, Lead } from '../lib/types'
import { PageHeader, SelectField, TextField, Toolbar } from '../ui'

// Intake lane: replies that haven't been triaged into the pipeline yet.
const INTAKE = 'untriaged'

export function Pipeline() {
  const { data } = useData()
  const { openConversation } = useConversation()
  const { setStage, assign, actor, members, memberName, memberWritesBlockedReason } =
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
  const followUps = useMemo(
    () => followUpStateMap(data?.followUpStates ?? []),
    [data?.followUpStates],
  )
  const latestMessages = useMemo(
    () => latestConversationMessageMap(data?.latestConversationMessages ?? []),
    [data?.latestConversationMessages],
  )

  const [dragOver, setDragOver] = useState<string | null>(null)
  const [pendingLost, setPendingLost] = useState<Lead | null>(null)
  // Distinguish a drag-drop from a click so the card click doesn't fire mid-drag.
  const draggingId = useRef<string | null>(null)

  if (!data) return null

  const campaignName = (id: string) =>
    data.campaigns.find((c) => c.campaign_id === id)?.campaign_name ?? id
  /* Two notebooks can carry the same display name. Where they do, the id goes
   * in the label so a board column, a filter and a card all name the same
   * account unambiguously. */
  const accountLabel = accountLabeller(data.instances)
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
      <PageHeader
        title="Pipeline"
        description="Drag replies into the funnel and track them by hand. Filters are kept in the URL."
        actions={
          <span className="identity-chip" title="Audit identity comes from your login">
            Working as <strong>{actor}</strong>
          </span>
        }
      />

      <Toolbar>
        <TextField
          className="ui-toolbar__search"
          label="Search leads"
          labelHidden
          type="search"
          placeholder="Name, headline, company…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <SelectField label="Account" labelHidden value={inst} onChange={(e) => setFilter('inst', e.target.value)}>
          <option value="all">All accounts</option>
          {data.instances.map((i) => (
            <option key={i.id} value={i.id}>{accountLabel(i.id)}</option>
          ))}
        </SelectField>
        <SelectField label="Campaign" labelHidden value={effCamp} onChange={(e) => setFilter('camp', e.target.value)}>
          <option value="all">All campaigns</option>
          {campaignOptions.map((c) => (
            <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>
          ))}
        </SelectField>
        <SelectField label="Assignee" labelHidden value={who} onChange={(e) => setFilter('who', e.target.value)}>
          <option value="all">Anyone</option>
          <option value="unassigned">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={String(m.id)}>{m.name}</option>
          ))}
        </SelectField>
      </Toolbar>

      <div className="pipe-board">
        {boardColumns.map((col) => {
          const cards = columns.get(col.id) ?? []
          return (
            <section
              key={col.id}
              className={`pipe-col ${dragOver === col.id ? 'drag-over' : ''}`}
              /* One status accent per COLUMN. The cards inside it no longer
                 repeat the same hue on their own left border. */
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
              <div className="flex items-center gap-app-sm min-h-control px-app-lg py-app-md border-b border-app-border sticky top-0 bg-app-surface">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: col.color }} aria-hidden="true" />
                <span className="flex-1 text-app-body font-semibold overflow-hidden text-ellipsis whitespace-nowrap">{col.label}</span>
                <span className="px-app-sm py-0.5 rounded-pill bg-app-surface-2 text-app-text-secondary text-app-meta font-semibold tabular-nums">{num(cards.length)}</span>
              </div>
              <div className="flex flex-col gap-app-md p-app-md overflow-y-auto">
                {cards.map((l) => (
                  <PipeCard
                    key={l.id}
                    lead={l}
                    columnId={col.id}
                    substatuses={col.sub}
                    campaignName={campaignName(l.campaign_id)}
                    accountName={accountLabel(l.instance_id)}
                    assigneeName={memberName(l.assigned_to)}
                    followUp={followUps.get(followUpKey(l.instance_id, l.profile_url))}
                    followUpOwnerName={memberName(
                      followUps.get(followUpKey(l.instance_id, l.profile_url))?.owner_id,
                    )}
                    latestMessage={latestMessages.get(followUpKey(l.instance_id, l.profile_url))}
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
                    assignBlockedReason={memberWritesBlockedReason}
                    draggingRef={draggingId}
                  />
                ))}
                {cards.length === 0 && <div className="text-center py-app-md px-0 muted small">—</div>}
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
  accountName,
  assigneeName,
  followUp,
  followUpOwnerName,
  latestMessage,
  members,
  assignBlockedReason,
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
  accountName: string
  assigneeName: string
  followUp?: FollowUpState
  followUpOwnerName: string
  latestMessage?: ConversationLatestMessage
  members: { id: number; name: string }[]
  /**
   * Why the owner cannot be changed, or `null` when it can. The select keeps its
   * options either way — it displays the current owner, and a value with no
   * matching option would read as "Unassigned".
   */
  assignBlockedReason: string | null
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
      className="flex flex-col gap-[7px] p-2.5 border border-app-border rounded-control bg-app-surface cursor-grab active:cursor-grabbing hover:border-app-border-strong [&_.substatus-chip]:mt-0"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className="flex flex-col gap-1.5 min-w-0 w-full border-0 p-0 bg-none text-app-text cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[3px] focus-visible:rounded-sm"
        draggable={false}
        onClick={() => {
          if (draggingRef.current) return
          onOpen()
        }}
      >
        <span className="flex items-center gap-app-sm [&_.pipe-card-name]:min-w-0">
          <LeadAvatar lead={lead} size={32} />
          <span className="min-w-0 flex flex-col gap-px">
            <span className="pipe-card-name text-app-table font-semibold overflow-hidden text-ellipsis whitespace-nowrap">{name}</span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap muted small">
              {[lead.company, lead.headline].filter(Boolean).join(' · ') || '—'}
            </span>
          </span>
        </span>
        {activeFollowUp(followUp) && (
          <span className={`pipe-follow-due ${followUpBucket(followUp)}`}>
            {followUpDueLabel(followUp)}
            {followUpOwnerName && followUp?.owner_id !== lead.assigned_to
              ? ` · ${followUpOwnerName}`
              : ''}
          </span>
        )}
        {latestMessage && (
          <span className="flex items-center gap-1.5 min-w-0 text-[length:var(--text-xs)] text-app-text-secondary">
            <span className={`pipe-msg-dir ${latestMessage.direction}`}>
              {latestMessage.direction === 'in' ? 'Them' : 'Us'}
            </span>
            <span className="ellipsis">{messageSnippet(latestMessage.body, 74)}</span>
            <time className="flex-[0_0_auto] text-app-text-muted" dateTime={latestMessage.sent_at} title={REPLY_TIME_ZONE_LABEL}>{replyDate(latestMessage.sent_at)}</time>
          </span>
        )}
        <span
          className="block max-w-full muted small ellipsis"
          title={`${campaignName} · ${accountName}`}
        >
          {campaignName} · {accountName}
        </span>
      </button>

      <div className="flex items-center gap-app-sm mt-app-xs text-app-meta min-h-5">
        {assigneeName && (
          <span className="inline-flex items-center" title={`Lead owner: ${assigneeName}`}>
            <InitialsAvatar name={assigneeName} size={20} />
          </span>
        )}
        <span className="muted small ellipsis">{substatusLabel(lead.pipeline_substatus ?? '') || ''}</span>
        {days != null && (
          <span className="ml-auto muted small" title="Days in this stage">
            {days}d
          </span>
        )}
      </div>

      <details
        className="border-t border-app-border pt-[5px] [&_summary]:min-h-control-sm [&_summary]:flex [&_summary]:items-center [&_summary]:text-app-text-muted [&_summary]:text-[length:var(--text-2xs)] [&_summary]:font-semibold [&_summary]:cursor-pointer [&_summary]:[list-style-position:inside] [&[open]_summary]:text-app-text-secondary [&[open]_summary]:mb-1.5"
        draggable={false}
        onMouseDown={stopControl}
        onDragStart={stopControl}
        onClick={stopControl}
      >
        <summary>Manage lead</summary>
        {/* Drag-and-drop stays the fast path; this is the explicit one, and it
            is also the only path a keyboard user has. */}
        <div className="pipe-card-controls">
          {substatuses.length > 0 && (
            <select
              className="substatus-chip"
              aria-label="Pipeline substatus"
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
          <select
            className="pipe-stage-select"
            aria-label="Pipeline stage"
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
            aria-label="Lead owner"
            value={String(lead.assigned_to ?? '')}
            draggable={false}
            onMouseDown={stopControl}
            onClick={stopControl}
            onChange={(e) => onAssign(e.target.value ? Number(e.target.value) : null)}
            disabled={assignBlockedReason !== null}
            title={assignBlockedReason ?? undefined}
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={String(m.id)}>{m.name}</option>
            ))}
          </select>
        </div>
      </details>
    </article>
  )
}
