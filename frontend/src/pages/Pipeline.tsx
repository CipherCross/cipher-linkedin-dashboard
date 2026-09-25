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
import type { FollowUpBucket } from '../lib/followUps'
import type { ConversationLatestMessage, FollowUpState, Lead } from '../lib/types'
import {
  Badge, Button, PageHeader, Select, SelectField, StatusText, TextField, Toolbar,
} from '../ui'
import type { Tone } from '../ui'

// Intake lane: replies that haven't been triaged into the pipeline yet.
const INTAKE = 'untriaged'

/* Due-date urgency, in the same words as the Leads and Follow-ups queues. */
const FOLLOW_UP_TONE: Record<FollowUpBucket, Tone> = {
  overdue: 'danger',
  today: 'warning',
  upcoming: 'accent',
  unscheduled: 'neutral',
}

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
          <span className="text-app-meta text-app-text-muted" title="Audit identity comes from your login">
            Working as <strong className="text-app-text font-semibold">{actor}</strong>
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

      <p className="mt-0 mb-app-sm text-app-meta text-app-text-muted">
        The board scrolls sideways. Drag a card to another stage, or open Manage lead on the card.
      </p>
      <div
        // Fills the viewport below the chrome: 170px is where the board starts at
        // every PC width (24 page top + 56 header + 16 + 36 toolbar + 12 + 18
        // hint + 8), and the page's own 32px bottom gutter stays below it, so
        // the route never scrolls as a whole. Columns stretch to this height.
        className="flex items-stretch gap-app-lg h-[calc(100vh-170px-var(--space-2xl))] overflow-x-auto pb-app-sm [overscroll-behavior-x:contain]"
        style={{
          // Full-bleed: escape the centered .page container so columns scroll to
          // the content-area edges instead of clipping at the page's max width.
          marginInline: 'calc(50% - 50vw + var(--sidebar-w) / 2)',
          paddingInline: 'calc(50vw - 50% - var(--sidebar-w) / 2)',
        }}
        role="region"
        aria-label="Pipeline board"
        tabIndex={0}
      >
        {boardColumns.map((col) => {
          const cards = columns.get(col.id) ?? []
          return (
            <section
              key={col.id}
              className={[
                'flex-none w-[340px] min-h-0 flex flex-col rounded-card bg-app-surface border',
                dragOver === col.id ? 'border-app-accent bg-app-accent-subtle' : 'border-app-border',
              ].join(' ')}
              // The ONE status accent on this board: a 3px stage stripe along the
              // column's top edge, which an inline style always keeps regardless
              // of the drag-over highlight above. Cards inside carry no colour.
              style={{ borderTopWidth: 3, borderTopColor: col.color }}
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
              {/* Same 12px inset as the cards below, so the title, the count and
                  the card edges share one line on each side. */}
              <div className="flex items-center gap-app-sm p-app-md border-b border-app-border">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: col.color }} aria-hidden="true" />
                <span className="flex-1 text-app-body font-semibold overflow-hidden text-ellipsis whitespace-nowrap">{col.label}</span>
                <Badge className="tabular-nums">{num(cards.length)}</Badge>
              </div>
              <div className="flex flex-col gap-app-md p-app-md min-h-0 overflow-y-auto">
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
                {cards.length === 0 && (
                  <div className="text-center py-app-md px-0 text-app-text-muted text-app-meta">—</div>
                )}
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
      className="flex flex-col gap-app-sm p-app-md border border-app-border rounded-control bg-app-surface cursor-grab active:cursor-grabbing hover:border-app-border-strong"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <Button
        variant="ghost"
        className="flex-col items-stretch justify-start gap-app-sm min-w-0 w-full h-auto p-0 text-left whitespace-normal font-normal text-app-text"
        draggable={false}
        onClick={() => {
          if (draggingRef.current) return
          onOpen()
        }}
      >
        <span className="flex items-center gap-app-sm min-w-0">
          <LeadAvatar lead={lead} size={32} />
          <span className="min-w-0 flex flex-col">
            <span className="text-app-table font-semibold truncate">{name}</span>
            <span className="truncate text-app-meta text-app-text-muted">
              {[lead.company, lead.headline].filter(Boolean).join(' · ') || '—'}
            </span>
          </span>
        </span>
        {activeFollowUp(followUp) && (
          <Badge tone={FOLLOW_UP_TONE[followUpBucket(followUp)]} className="self-start">
            {followUpDueLabel(followUp)}
            {followUpOwnerName && followUp?.owner_id !== lead.assigned_to
              ? ` · ${followUpOwnerName}`
              : ''}
          </Badge>
        )}
        {latestMessage && (
          <span className="flex items-center gap-app-sm min-w-0 text-app-meta text-app-text-secondary">
            <StatusText tone={latestMessage.direction === 'in' ? 'accent' : 'neutral'}>
              {latestMessage.direction === 'in' ? 'Them' : 'Us'}
            </StatusText>
            <span className="truncate min-w-0">{messageSnippet(latestMessage.body, 74)}</span>
            <time className="flex-none text-app-text-muted" dateTime={latestMessage.sent_at} title={REPLY_TIME_ZONE_LABEL}>{replyDate(latestMessage.sent_at)}</time>
          </span>
        )}
        <span
          className="block max-w-full truncate text-app-meta text-app-text-muted"
          title={`${campaignName} · ${accountName}`}
        >
          {campaignName} · {accountName}
        </span>
      </Button>

      <div className="flex items-center gap-app-sm text-app-meta min-h-5">
        {assigneeName && (
          <span className="inline-flex items-center" title={`Lead owner: ${assigneeName}`}>
            <InitialsAvatar name={assigneeName} size={20} />
          </span>
        )}
        <span className="text-app-text-muted truncate">{substatusLabel(lead.pipeline_substatus ?? '') || ''}</span>
        {days != null && (
          <span className="ml-auto text-app-text-muted" title="Days in this stage">
            {days}d
          </span>
        )}
      </div>

      <details
        className="border-t border-app-border pt-app-xs [&_summary]:min-h-control-sm [&_summary]:flex [&_summary]:items-center [&_summary]:text-app-text-muted [&_summary]:text-app-meta [&_summary]:font-semibold [&_summary]:cursor-pointer [&_summary]:[list-style-position:inside] [&[open]_summary]:text-app-text-secondary"
        draggable={false}
        onMouseDown={stopControl}
        onDragStart={stopControl}
        onClick={stopControl}
      >
        <summary>Manage lead</summary>
        {/* Drag-and-drop stays the fast path; this is the explicit one, and it
            is also the only path a keyboard user has. */}
        <div className="flex flex-col gap-app-sm mt-app-sm">
          {substatuses.length > 0 && (
            <Select
              aria-label="Pipeline substatus"
              className="min-h-control-sm pl-app-sm text-app-meta"
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
            </Select>
          )}
          <Select
            aria-label="Pipeline stage"
            className="min-h-control-sm pl-app-sm text-app-meta"
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
          </Select>
          <Select
            aria-label="Lead owner"
            className="min-h-control-sm pl-app-sm text-app-meta"
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
          </Select>
          {/* A disabled control's `title` is not reliably announced, so the
              reason it's disabled is also plain visible text. */}
          {assignBlockedReason && (
            <span className="text-app-meta text-app-text-muted">{assignBlockedReason}</span>
          )}
        </div>
      </details>
    </article>
  )
}
