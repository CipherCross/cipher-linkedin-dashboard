import { useEffect, useState } from 'react'
import { Check, UserRound } from 'lucide-react'
import { ACTION_LABELS, type ReplyWorkflow, type ReplyWorkflowAction } from '../../lib/replyReview'
import { COPY } from '../../ui/labels'

export interface ConversationActionPanelProps {
  workflow: ReplyWorkflow | null
  members?: Array<{ id: number; name: string; active: boolean }>
  inboundRevision?: number
  persistedDoNotContact?: boolean
  saving?: boolean
  error?: string | null
  onDraftChange?: (workflow: { expected_revision: number; observed_inbound_revision: number; action: ReplyWorkflowAction | null; owner_id: number | null; next_follow_up_date: string | null; do_not_contact: boolean; change_reason: string | null }) => void
  onDirtyChange?: (dirty: boolean) => void
  onSave: (workflow: { expected_revision: number; observed_inbound_revision: number; action: ReplyWorkflowAction | null; owner_id: number | null; next_follow_up_date: string | null; do_not_contact: boolean; change_reason: string | null }) => void | Promise<unknown>
  externalActions?: boolean
  onValidityChange?: (valid: boolean) => void
}

export function ConversationActionPanel({ workflow, members = [], inboundRevision = 0, persistedDoNotContact, saving, error, onSave, onDraftChange, onDirtyChange, externalActions = false, onValidityChange }: ConversationActionPanelProps) {
  const [action, setAction] = useState<ReplyWorkflowAction | null>(workflow?.action ?? null)
  const [owner, setOwner] = useState<number | null>(workflow?.owner_id ?? null)
  const [date, setDate] = useState(workflow?.next_follow_up_date ?? '')
  const [dnc, setDnc] = useState(workflow?.do_not_contact ?? false)
  const [reason, setReason] = useState('')
  useEffect(() => { setAction(workflow?.action ?? null); setOwner(workflow?.owner_id ?? null); setDate(workflow?.next_follow_up_date ?? ''); setDnc(workflow?.do_not_contact ?? false) }, [workflow?.revision, workflow?.action, workflow?.owner_id, workflow?.next_follow_up_date, workflow?.do_not_contact])
  const requiresOwner = action === 'needs_reply' || action === 'follow_up' || action === 'awaiting_reply'
  const requiresDate = action === 'follow_up'
  const blockedByDnc = dnc && action !== 'resolved' && action !== 'closed_soft' && action !== 'closed_hard'
  const removingDnc = (persistedDoNotContact ?? workflow?.do_not_contact) === true && !dnc
  const madridToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const invalid = (requiresOwner && owner == null) || (requiresDate && (!date || date < madridToday)) || blockedByDnc || (removingDnc && (!action || !reason.trim()))
  useEffect(() => { onValidityChange?.(!invalid) }, [invalid, onValidityChange])
  const submit = () => {
    if (invalid) return
    void onSave({ expected_revision: workflow?.revision ?? 0, observed_inbound_revision: inboundRevision, action: dnc ? 'resolved' : action, owner_id: owner, next_follow_up_date: dnc || action !== 'follow_up' ? null : date, do_not_contact: dnc, change_reason: reason.trim() || null })
  }
  const updateDraft = (patch: Partial<{ action: ReplyWorkflowAction | null; owner_id: number | null; next_follow_up_date: string | null; do_not_contact: boolean; change_reason: string | null }>) => {
    const next = { action, owner_id: owner, next_follow_up_date: date || null, do_not_contact: dnc, change_reason: reason.trim() || null, ...patch }
    // Combined Save / Save and next use this draft instead of submit().
    if (next.do_not_contact || next.action !== 'follow_up') next.next_follow_up_date = null
    setDate(next.next_follow_up_date ?? '')
    onDraftChange?.({ expected_revision: workflow?.revision ?? 0, observed_inbound_revision: inboundRevision, action: next.action, owner_id: next.owner_id, next_follow_up_date: next.next_follow_up_date, do_not_contact: next.do_not_contact, change_reason: next.change_reason })
    onDirtyChange?.(true)
  }
  return <section className="replies-action-panel" aria-label="Next step">
    <div className="replies-panel-heading"><div><h2>Next step</h2></div>{workflow?.acknowledged_inbound_revision !== inboundRevision && inboundRevision > 0 && <span className="replies-pending-badge">Needs a next step</span>}</div>
    <label className="replies-fieldset"><span className="replies-label">Conversation status</span><select value={action ?? ''} onChange={(event) => { const next = (event.target.value || null) as ReplyWorkflowAction | null; setAction(next); updateDraft({ action: next }) }} disabled={dnc}><option value="">Not set</option>{(Object.keys(ACTION_LABELS) as ReplyWorkflowAction[]).map((value) => <option key={value} value={value}>{ACTION_LABELS[value]}</option>)}</select></label>
    <label className="replies-fieldset"><span className="replies-label"><UserRound size={14} /> Conversation owner</span><select value={owner == null ? '' : String(owner)} onChange={(event) => { const next = event.target.value ? Number(event.target.value) : null; setOwner(next); updateDraft({ owner_id: next }) }}><option value="">Unassigned</option>{members.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.name}{members.filter((candidate) => candidate.active && candidate.name === member.name).length > 1 ? ` · #${member.id}` : ''}</option>)}</select></label>
    {requiresDate && <label className="replies-fieldset"><span className="replies-label">Follow-up date</span><input type="date" value={date} min={madridToday} onChange={(event) => { setDate(event.target.value); updateDraft({ next_follow_up_date: event.target.value || null }) }} /></label>}
    <label className="replies-dnc"><input type="checkbox" checked={dnc} onChange={(event) => { const next = event.target.checked; setDnc(next); setAction(next ? 'resolved' : null); updateDraft({ do_not_contact: next, action: next ? 'resolved' : null }) }} /><span><strong>Do not contact</strong><small>Setting this cancels follow-ups inside the dashboard. Stop the Linked Helper campaign separately.</small></span></label>
    {invalid && <p className="replies-form-error">{blockedByDnc ? 'An active next step cannot be set while Do not contact is on.' : removingDnc && !reason.trim() ? 'Removing Do not contact requires a comment.' : removingDnc && !action ? 'Removing Do not contact requires an explicit next step.' : requiresOwner && owner == null ? 'Choose a conversation owner.' : 'Choose a follow-up date no earlier than today (Madrid time).'}</p>}
    {(removingDnc || reason) && <label className="replies-fieldset"><span className="replies-label">Change comment {removingDnc && <span className="muted small">required when removing Do not contact</span>}</span><input value={reason} onChange={(event) => { const next = event.target.value; setReason(next); updateDraft({ change_reason: next.trim() || null }) }} placeholder="For example: the contact agreed to be contacted again…" /></label>}
    {!removingDnc && !reason && <button type="button" className="flex items-center gap-app-xs self-start min-h-control-sm p-0 border-0 bg-transparent font-[inherit] text-app-table font-semibold cursor-pointer text-app-accent" onClick={() => setReason(' ')}>Add a comment</button>}
    {error && <div className="replies-inline-error" role="alert">{error}</div>}
    {!externalActions && <button className="btn" type="button" onClick={submit} disabled={saving || invalid}>{saving ? COPY.saving : <><Check size={16} /> Save next step</>}</button>}
  </section>
}
