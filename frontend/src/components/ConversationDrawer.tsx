import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  CalendarCheck2, Check, ExternalLink, MessagesSquare, Pencil, Trash2, X,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { authPost } from '../lib/api'
import { authFetch } from '../lib/api'
import { fetchNeonThread, resolveReadPath } from '../lib/dashboardReads'
import { useAuth } from '../lib/AuthContext'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { usePipelineActions } from '../lib/usePipelineActions'
import { ImportHistoryPanel } from './ImportHistoryPanel'
import { FollowUpPanel } from './FollowUpPanel'
import { LeadNotesPanel } from './LeadNotesPanel'
import { ReplyReviewPanel } from './conversation/ReplyReviewPanel'
import { useReplyReviewActions } from '../lib/useReplyReviewActions'
import { defaultReplyReadClient, isReplyManualReady } from '../lib/replyReview'
import { LostReasonModal } from './LostReasonModal'
import { Avatar, LeadAvatar } from './Avatar'
import { Skeleton } from './Skeleton'
import {
  INTENT_META, ISSUE_KIND_LABEL, NEXT_ACTION_META, SENTIMENT_META,
  SEVERITY_TONE,
  ageRange, instanceName, leadKey,
} from '../lib/leads'
import {
  activeFollowUp,
  followUpDueLabel,
  followUpKey,
  followUpStateMap,
} from '../lib/followUps'
import { PIPELINE_STAGES, stageById, substatusLabel } from '../lib/pipeline'
import { clockTime, dayHeading } from '../lib/format'
import type { ConversationMode } from '../lib/ConversationContext'
import type { Coaching, Gender, Lead, Message } from '../lib/types'
import type { ReplyReview } from '../lib/replyReview'
import {
  Badge, Button, Dialog, EmptyState, ExternalLinkButton, IconButton, InlineError, LinkButton,
  SelectField, Textarea, useDirtyGuard,
} from '../ui'
import { ConversationSection } from './ConversationSection'

// Only the thread fields the drawer renders — fetched on demand (the global
// DataContext caps messages at 90 days / 2000 rows, too narrow for "whole chain").
type ThreadMsg = Pick<
  Message,
  | 'id' | 'direction' | 'body' | 'sent_at' | 'sentiment' | 'reason'
  | 'classified_model' | 'source' | 'intent_level' | 'intent_reason'
  | 'intent_classified_model'
> & { review?: ReplyReview | null }

function repliesHref(lead: Lead, focusMessageId: number | null = null): string {
  const params = new URLSearchParams({
    view: 'all',
    scope: 'all',
    thread: `${lead.instance_id}|${lead.profile_url}`,
    instance_id: lead.instance_id,
    profile_url: lead.profile_url,
  })
  if (focusMessageId != null && Number.isSafeInteger(focusMessageId) && focusMessageId > 0) {
    params.set('focus', String(focusMessageId))
  }
  return `/replies?${params.toString()}`
}

/** Slide-in panel showing one lead's full conversation, both directions, oldest
 *  first. The latest inbound reply can be reviewed manually in the shared panel. */
export function ConversationDrawer({
  lead,
  initialMode = 'thread',
  onClose,
}: {
  lead: Lead | null
  initialMode?: ConversationMode
  onClose: () => void
}) {
  const { isAdmin } = useAuth()
  const { data, refetch, patchLead } = useData()
  const toast = useToast()
  const { setStage, assign, members, memberWritesBlockedReason } =
    usePipelineActions()
  const [pendingLost, setPendingLost] = useState(false)
  const [rows, setRows] = useState<ThreadMsg[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The imported message currently being deleted (for the inline spinner).
  const [deleting, setDeleting] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  // True while a gender override is being saved (disables the select).
  const [savingGender, setSavingGender] = useState(false)
  const [replyCapabilities, setReplyCapabilities] = useState<Awaited<ReturnType<typeof defaultReplyReadClient.capabilities>> | null>(null)
  const [coaching, setCoaching] = useState<Coaching | null>(null)
  const [coachLoading, setCoachLoading] = useState(false)
  const [coachError, setCoachError] = useState<string | null>(null)
  const [coachOpen, setCoachOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(initialMode === 'import_history')
  const [followUpOpen, setFollowUpOpen] = useState(initialMode === 'follow_up')
  const [followUpReturnAction, setFollowUpReturnAction] = useState<
    'complete' | 'skip' | undefined
  >()
  const threadRef = useRef<HTMLDivElement>(null)
  // The import or follow-up view, when one replaces the thread.
  const viewRef = useRef<HTMLDivElement>(null)
  // Bumped after a manual import so the thread effect refetches the new rows.
  const [reloadKey, setReloadKey] = useState(0)
  const [importDirty, setImportDirty] = useState(false)
  // The inbound message whose review form has unsaved edits. Keyed by message
  // so a newer reply (which remounts the form with a fresh draft) is not
  // mistaken for the edited one.
  const [reviewDirtyFor, setReviewDirtyFor] = useState<number | null>(null)
  const replyActions = useReplyReviewActions(() => { setReloadKey((value) => value + 1); refetch() })
  // Identifies the conversation a coach request was issued for, so a slow
  // response can't land on a drawer the user has since switched away from.
  const coachReqKey = useRef('')

  // Switching leads (or opening one from the worklist) resets the transient
  // workflow and honors the caller's requested destination.
  useEffect(() => {
    setImportOpen(initialMode === 'import_history')
    setFollowUpOpen(initialMode === 'follow_up')
    setFollowUpReturnAction(undefined)
    setEditing(null)
    setSavingEdit(false)
  }, [lead, initialMode])

  // The thread renders oldest-first; triage users click a recent reply, so open
  // at the newest message. Re-runs after an import bumps reloadKey.
  useEffect(() => {
    if (!rows || importOpen || followUpOpen) return
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows, reloadKey, importOpen, followUpOpen])

  // Closing the import or follow-up view unmounts the control that had focus.
  // Hand it to the messages, which is where that view returns to.
  // Opening one can unmount the focused message control the same way; then
  // focus goes to the view itself.
  const wasSubView = useRef(importOpen || followUpOpen)
  useEffect(() => {
    const subView = importOpen || followUpOpen
    const lost = !document.activeElement || document.activeElement === document.body
      || document.activeElement.getAttribute('role') === 'dialog'
    if (wasSubView.current && !subView) threadRef.current?.focus()
    else if (subView && lost) viewRef.current?.focus()
    wasSubView.current = subView
  }, [importOpen, followUpOpen])

  // Saving or cancelling an edit unmounts its text box; return focus to that
  // message's edit button rather than letting it fall to the dialog itself.
  const lastEdited = useRef<number | null>(null)
  useEffect(() => {
    if (editing) { lastEdited.current = editing.id; return }
    if (lastEdited.current == null) return
    threadRef.current?.querySelector<HTMLElement>(`[data-edit-for="${lastEdited.current}"]`)?.focus()
    lastEdited.current = null
  }, [editing])

  // Fetch the full thread whenever the active lead changes (or an import lands).
  useEffect(() => {
    if (!lead) {
      setRows(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setRows(null)
    ;(async () => {
      // The Neon path serves one fixed projection: the column ladder below dies
      // there rather than being reproduced. Its middle rung silently drops
      // `intent_level` and `intent_reason` from every message in the thread, so
      // an SDR triaging a conversation would see no buying intent *because the
      // query asked for none* — a confident wrong answer in the one place a
      // human decides from what is on screen. That was worth it while migration
      // 047 was in flight; against a ledger-applied schema it hides a broken
      // deployment from the person least able to detect it.
      if ((await resolveReadPath()) === 'neon') {
        try {
          const thread = isReplyManualReady(replyCapabilities)
            ? (await defaultReplyReadClient.thread({ instance_id: lead.instance_id, profile_url: lead.profile_url, limit: 100 })).messages
            : await fetchNeonThread(lead.instance_id, lead.profile_url)
          if (cancelled) return
          setRows(thread as ThreadMsg[])
        } catch (e) {
          if (cancelled) return
          setError(e instanceof Error ? e.message : String(e))
        }
        setLoading(false)
        return
      }
      if (!supabase) {
        setError('Supabase is not configured.')
        setLoading(false)
        return
      }
      let result = await supabase
        .from('messages')
        .select(
          'id,direction,body,sent_at,sentiment,reason,classified_model,source,' +
          'intent_level,intent_reason,intent_classified_model',
        )
        .eq('instance_id', lead.instance_id)
        .eq('profile_url', lead.profile_url)
        .order('sent_at', { ascending: true })
      if (result.error?.code === '42703') {
        result = await supabase
          .from('messages')
          .select('id,direction,body,sent_at,sentiment,reason,classified_model,source')
          .eq('instance_id', lead.instance_id)
          .eq('profile_url', lead.profile_url)
          .order('sent_at', { ascending: true }) as typeof result
      }
      if (result.error?.code === '42703') {
        result = await supabase
          .from('messages')
          .select('id,direction,body,sent_at,sentiment,reason,classified_model')
          .eq('instance_id', lead.instance_id)
          .eq('profile_url', lead.profile_url)
          .order('sent_at', { ascending: true }) as typeof result
      }
      const { data: msgs, error: err } = result
      if (cancelled) return
      if (err) setError(err.message)
      else setRows((msgs ?? []) as unknown as ThreadMsg[])
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [lead, reloadKey, replyCapabilities])

  useEffect(() => {
    let cancelled = false
    if (!lead) { setReplyCapabilities(null); return () => { cancelled = true } }
    defaultReplyReadClient.capabilities().then((value) => { if (!cancelled) setReplyCapabilities(value) }).catch(() => { if (!cancelled) setReplyCapabilities(null) })
    return () => { cancelled = true }
  }, [lead])

  // On-demand coaching: ask /api/coach for this conversation. The endpoint serves
  // a cached take instantly when the thread is unchanged, else generates a fresh
  // one (a few seconds). `force` bypasses the cache for the Regenerate button.
  const loadCoaching = useCallback(
    async (force: boolean) => {
      if (!lead) return
      const k = leadKey(lead.instance_id, lead.profile_url)
      coachReqKey.current = k
      setCoachLoading(true)
      setCoachError(null)
      if (force) setCoaching(null)
      try {
        const res = await authFetch('/api/coach', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            instance_id: lead.instance_id,
            profile_url: lead.profile_url,
            campaign_id: lead.campaign_id,
            force,
          }),
        })
        const j = await res.json()
        if (coachReqKey.current !== k) return // user switched conversations
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
        setCoaching(j as Coaching)
      } catch (e) {
        if (coachReqKey.current === k)
          setCoachError(e instanceof Error ? e.message : String(e))
      } finally {
        if (coachReqKey.current === k) setCoachLoading(false)
      }
    },
    [lead],
  )

  // Coaching is generated on demand via the button only — auto-loading on every
  // drawer open burned model credits for conversations nobody wanted coached.
  useEffect(() => {
    coachReqKey.current = ''
    setCoaching(null)
    setCoachError(null)
    setCoachLoading(false)
    setCoachOpen(false)
  }, [lead])

  // Unsaved work: a pasted/parsed import that has not been saved, or edits to
  // the review form. Closing the drawer — Escape, backdrop, Close, or one of
  // its navigation links — or switching to a view that unmounts the form asks
  // Keep editing / Discard changes first.
  const navigate = useNavigate()
  const latestInboundId = rows
    ? [...rows].reverse().find((m) => m.direction === 'in' && m.body)?.id ?? null
    : null
  const reviewUnsaved = !importOpen && !followUpOpen && reviewDirtyFor !== null && reviewDirtyFor === latestInboundId
  const { guard, prompt: discardPrompt } = useDirtyGuard((importOpen && importDirty) || reviewUnsaved)
  const discardAnd = (action: () => void) => guard(() => {
    setImportDirty(false)
    setReviewDirtyFor(null)
    action()
  })
  const requestClose = () => discardAnd(onClose)
  /** A link inside the drawer both navigates and closes it; with unsaved work
   *  the navigation waits for the answer. */
  const guardedLinkClick = (to: string) => (event: React.MouseEvent) => {
    if (!(importOpen && importDirty) && !reviewUnsaved) {
      onClose()
      return
    }
    event.preventDefault()
    discardAnd(() => { onClose(); navigate(to) })
  }

  if (!lead) return null

  // The `lead` prop is a snapshot captured when the drawer opened; pipeline
  // fields (stage/substatus/assignee) mutate in place via patchLead, so read
  // the live row from context for those controls.
  const live = data?.leads.find((x) => x.id === lead.id) ?? lead
  const liveStage = stageById(live.pipeline_stage)
  const followUpState = followUpStateMap(data?.followUpStates ?? []).get(
    followUpKey(lead.instance_id, lead.profile_url),
  )

  const campaignName =
    data?.campaigns.find((c) => c.campaign_id === lead.campaign_id)?.campaign_name ??
    lead.campaign_id
  const outreachAccount = data?.instances.find((i) => i.id === lead.instance_id)
  const accountLabel = instanceName(
    outreachAccount,
    lead.instance_id,
  )

  // The lead's effective status = its most recent classified inbound reply.
  const latestInbound = rows
    ? [...rows].reverse().find((m) => m.direction === 'in' && m.body)
    : undefined
  const latestSentiment = latestInbound?.review?.sentiment ?? latestInbound?.sentiment
  const latestReason = latestInbound?.review?.reason_ids?.join(', ') ?? latestInbound?.reason
  const statusMeta = latestSentiment
    ? SENTIMENT_META[latestSentiment]
    : null
  const latestIntent = latestInbound?.review?.intent_level ?? latestInbound?.intent_level
  const latestIntentMeta = latestIntent
    ? INTENT_META[latestIntent]
    : null

  // Compare the live thread to what the coaching was generated against, so we can
  // nudge for a Regenerate when new messages have arrived since.
  const liveMarker =
    rows && rows.length ? `${rows[rows.length - 1].sent_at}|${rows.length}` : null
  const coachStale =
    !!coaching?.last_msg_marker && !!liveMarker && coaching.last_msg_marker !== liveMarker
  const actionMeta = coaching ? NEXT_ACTION_META[coaching.next_action] : null
  const manualReviewReady = isReplyManualReady(replyCapabilities)

  // Only source='manual' rows are deletable — sync rows are LH2 ground truth and
  // would be resurrected by the next agent sync anyway. The endpoint recomputes
  // milestones the import backfilled from the row, so refetch() the funnel data.
  async function deleteMessage(msg: ThreadMsg) {
    if (
      !window.confirm(
        'Delete this imported message? Reply/connect milestones derived from it will be recomputed.',
      )
    )
      return
    setDeleting(msg.id)
    try {
      const res = await authPost('/api/import', {
        action: 'delete_message',
        id: msg.id,
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      setRows((prev) => prev?.filter((m) => m.id !== msg.id) ?? prev)
      refetch()
    } catch (e) {
      // A banner at the top of a long thread scrolls off-screen — toast instead.
      toast.error(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeleting(null)
    }
  }

  async function editMessage(msg: ThreadMsg) {
    if (!editing || editing.id !== msg.id) return
    const body = editing.body.trim()
    if (!body || body === (msg.body ?? '').trim()) {
      setEditing(null)
      return
    }
    setSavingEdit(true)
    try {
      const res = await authPost('/api/import', {
        action: 'edit_message',
        id: msg.id,
        body,
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      setRows(
        (prev) => prev?.map((m) => (m.id === msg.id ? { ...m, body: j.body ?? body } : m)) ?? prev,
      )
      setEditing(null)
      refetch()
    } catch (e) {
      toast.error(`Couldn't edit: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSavingEdit(false)
    }
  }

  // Gender override → /api/pipeline set_gender. A non-null value marks the row
  // SDR-reviewed (demo_model='manual', confidence 1); null clears only the gender
  // lifecycle so the next classify run re-infers it. Age remains independent.
  // Optimistic via
  // patchLead, reverting the snapshot on failure; on success the response already
  // carries the authoritative fields, so patch those directly instead of refetching.
  async function setGender(gender: Gender | null) {
    setSavingGender(true)
    const snapshot: Partial<Lead> = {
      gender: live.gender ?? null,
      gender_confidence: live.gender_confidence ?? null,
      gender_inferred_at: live.gender_inferred_at ?? null,
      gender_model_version: live.gender_model_version ?? null,
      demo_model: live.demo_model ?? null,
      demo_inferred_at: live.demo_inferred_at ?? null,
    }
    patchLead(
      lead!.id,
      gender === null
        ? {
            gender: null,
            gender_confidence: null,
            gender_inferred_at: null,
            gender_model_version: null,
            demo_model: null,
            demo_inferred_at: null,
          }
        : {
            gender,
            gender_confidence: 1,
            gender_inferred_at: new Date().toISOString(),
            gender_model_version: null,
            demo_model: 'manual',
          },
    )
    try {
      const res = await authPost('/api/pipeline', {
        action: 'set_gender',
        lead_id: lead!.id,
        gender,
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      patchLead(lead!.id, {
        gender: (j.gender ?? null) as Gender | null,
        gender_confidence: j.gender_confidence ?? null,
        gender_inferred_at: j.gender_inferred_at ?? null,
        gender_model_version: j.gender_model_version ?? null,
        demo_model: j.demo_model ?? null,
        demo_inferred_at: j.demo_inferred_at ?? null,
      })
      // The API applies a confirmation to every campaign row for this account/profile.
      // Refresh so duplicates elsewhere in the explorer receive the same value.
      refetch()
    } catch (e) {
      patchLead(lead!.id, snapshot) // revert
      toast.error(`Couldn't update gender: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSavingGender(false)
    }
  }

  const name = lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')
  const identityLine = [lead.headline, lead.company].filter(Boolean).join(' · ')

  return (
    <Dialog
      placement="end"
      title={
        <span className="flex items-center gap-app-md min-w-0">
          {/* The avatar's initials would otherwise be read as part of the name. */}
          <span aria-hidden="true" className="contents"><LeadAvatar lead={lead} size={40} /></span>
          <span className="truncate">{name}</span>
        </span>
      }
      description={identityLine || '—'}
      onRequestClose={requestClose}
      // Focus starts in whatever the drawer opened on: the messages, so the
      // keyboard can scroll the thread at once, or the import / follow-up view.
      initialFocusRef={importOpen || followUpOpen ? viewRef : threadRef}
      className="animate-[conv-slide-in_0.25s_var(--ease-out)]"
      bodyClassName="p-0 overflow-hidden flex flex-col"
    >
      <div className="shrink-0 flex flex-col gap-app-md px-app-xl py-app-md border-b border-app-border">
        <div className="flex items-center gap-app-sm flex-wrap">
          <Link
            className="text-app-meta text-app-text-muted no-underline hover:text-app-accent hover:underline"
            to={`/campaign/${encodeURIComponent(lead.campaign_id)}`}
            onClick={guardedLinkClick(`/campaign/${encodeURIComponent(lead.campaign_id)}`)}
          >
            {campaignName}
          </Link>
          {outreachAccount ? (
            <a
              className="inline-flex items-center gap-1.5 text-app-meta text-app-text-muted no-underline [&[href]:hover]:text-app-text"
              href={outreachAccount.account_url ?? undefined}
              target={outreachAccount.account_url ? '_blank' : undefined}
              rel={outreachAccount.account_url ? 'noreferrer' : undefined}
              title={`Outreach account: ${accountLabel}`}
              onClick={outreachAccount.account_url ? undefined : (e) => e.preventDefault()}
            >
              <Avatar key={outreachAccount.id} inst={outreachAccount} size={22} />
              <span>{accountLabel}</span>
            </a>
          ) : (
            <span className="text-app-meta text-app-text-muted">· {accountLabel}</span>
          )}
          {statusMeta ? (
            <Badge
              tone={statusMeta.tone}
              title={latestReason ?? 'Follows the most recent reply'}
            >
              {statusMeta.label}
            </Badge>
          ) : (
            <Badge tone="neutral">No reply yet</Badge>
          )}
          {latestIntentMeta && (
            <Badge
              tone={latestIntentMeta.tone}
              title={latestInbound?.intent_reason ?? 'Commercial intent on latest reply'}
            >
              {latestIntentMeta.short} · {latestIntentMeta.label}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-app-sm flex-wrap">
          <ExternalLinkButton
            variant="ghost"
            size="sm"
            href={lead.profile_url}
            target="_blank"
            rel="noreferrer"
            icon={<ExternalLink size={14} aria-hidden="true" />}
          >
            LinkedIn
          </ExternalLinkButton>
          {rows && rows.length > 0 && (
            <LinkButton
              variant="ghost"
              size="sm"
              to={repliesHref(lead, latestInbound?.id ?? null)}
              onClick={guardedLinkClick(repliesHref(lead, latestInbound?.id ?? null))}
            >
              Open in Replies
            </LinkButton>
          )}
          {/* Hidden while the empty state shows — that state carries its own
              Import-history action, and two identical actions one viewport
              apart read as clutter. */}
          {!importOpen && !followUpOpen && !(rows && rows.length === 0) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => discardAnd(() => setImportOpen(true))}
              disabled={!rows}
              title="Paste a conversation copied from LinkedIn"
            >
              Import history
            </Button>
          )}
          {data?.followUpsAvailable && (
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              icon={<CalendarCheck2 size={14} aria-hidden="true" />}
              aria-pressed={followUpOpen}
              onClick={() => discardAnd(() => {
                setImportOpen(false)
                setFollowUpReturnAction(undefined)
                setFollowUpOpen((open) => !open)
              })}
            >
              {activeFollowUp(followUpState)
                ? followUpDueLabel(followUpState)
                : 'Schedule follow-up'}
            </Button>
          )}
        </div>

        {/* Everything below is lead metadata, not the conversation. It sits
            behind one disclosure so the thread starts near the top of the
            drawer instead of below four rows of controls. */}
        <details className="[&>summary]:flex [&>summary]:items-center [&>summary]:min-h-control-sm [&>summary]:text-app-accent [&>summary]:text-app-table [&>summary]:font-semibold [&>summary]:cursor-pointer">
          <summary>Lead details</summary>
          <div className="grid grid-cols-2 gap-app-md mt-app-md">
            <SelectField
              label="Stage"
              value={live.pipeline_stage ?? ''}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'lost') setPendingLost(true)
                else void setStage(live, v || null)
              }}
            >
              <option value="">Not in pipeline</option>
              {PIPELINE_STAGES.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </SelectField>
            {liveStage && liveStage.substatuses.length > 0 && (
              <SelectField
                label="Substatus"
                value={live.pipeline_substatus ?? ''}
                onChange={(e) =>
                  void setStage(live, live.pipeline_stage, { substatus: e.target.value || null })
                }
              >
                <option value="">—</option>
                {liveStage.substatuses.map((s) => (
                  <option key={s} value={s}>{substatusLabel(s)}</option>
                ))}
              </SelectField>
            )}
            {/* Disabled rather than emptied. This control *displays* the
                current owner as well as changing them, and a select whose
                value matches no option renders as "Unassigned" — so dropping
                the options would turn a blocked write into a wrong reading.
                The chooser in `FollowUpPanel`, which displays nothing, empties
                its list instead. */}
            <SelectField
              label="Owner"
              value={String(live.assigned_to ?? '')}
              onChange={(e) => void assign(live, e.target.value ? Number(e.target.value) : null)}
              disabled={memberWritesBlockedReason !== null}
              title={memberWritesBlockedReason ?? undefined}
              help={memberWritesBlockedReason ?? undefined}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={String(m.id)}>{m.name}</option>
              ))}
            </SelectField>
            <SelectField
              label="Gender"
              value={live.gender ?? ''}
              disabled={savingGender || !isAdmin}
              onChange={(e) => {
                const v = e.target.value
                if (v === '') return
                void setGender(v === 'clear' ? null : (v as Gender))
              }}
              help={live.gender
                ? live.demo_model === 'manual'
                  ? <Badge title="Reviewed by an SDR — manual override">Reviewed</Badge>
                  : (
                    <Badge title="Inferred by AI from name + headline — pick a value to confirm">
                      AI{live.gender_confidence != null ? ` ·${Math.round(live.gender_confidence * 100)}%` : ''}
                    </Badge>
                  )
                : undefined}
            >
              {!live.gender && (
                <option value="" disabled>
                  Set gender…
                </option>
              )}
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="unknown">Unknown</option>
              {live.gender && <option value="clear">Clear override → re-infer</option>}
            </SelectField>
            <div className="flex flex-col gap-app-xs">
              <span className="text-app-meta font-semibold text-app-text-secondary">Age</span>
              <span className="tabular-nums font-semibold">{ageRange(live) ?? '—'}</span>
            </div>
          </div>
        </details>
      </div>

      {error && (
        <div className="shrink-0 px-app-xl pt-app-md">
          <InlineError
            title="The conversation could not load."
            message={error}
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </div>
      )}

      {(importOpen || followUpOpen) && (
      <div
        ref={viewRef}
        tabIndex={-1}
        role="region"
        aria-label={importOpen ? 'Import history' : 'Follow-up'}
        className="flex-1 min-h-0 flex flex-col focus:outline-none"
      >
      {importOpen && (
        <ImportHistoryPanel
          lead={lead}
          accountName={
            data?.instances.find((i) => i.id === lead.instance_id)?.account_name ?? null
          }
          existing={rows}
          onImported={() => {
            setReloadKey((k) => k + 1)
            refetch()
          }}
          onClose={() => setImportOpen(false)}
          onDirtyChange={setImportDirty}
        />
      )}

      {!importOpen && followUpOpen && (
        <FollowUpPanel
          lead={live}
          initialAction={followUpReturnAction}
          onBack={() => {
            setFollowUpOpen(false)
            setFollowUpReturnAction(undefined)
          }}
          onImport={(returnTo) => {
            setFollowUpReturnAction(returnTo)
            setImportOpen(true)
          }}
          onCompleted={() => {
            setFollowUpOpen(false)
            setFollowUpReturnAction(undefined)
          }}
        />
      )}
      </div>
      )}

      {!importOpen && !followUpOpen && (
      <>
      <div
        className="flex-[1_1_0] min-h-[120px] overflow-y-auto px-app-xl py-app-lg flex flex-col gap-app-lg [overscroll-behavior:contain] focus-visible:outline-2 focus-visible:outline-app-accent focus-visible:-outline-offset-2"
        ref={threadRef}
        role="region"
        aria-label="Messages"
        tabIndex={0}
      >
        {loading && (
          <div className="flex flex-col gap-app-lg" aria-hidden="true">
            <Skeleton className="self-start" width="68%" height={44} radius="10px 10px 10px 2px" />
            <Skeleton className="self-end" width="54%" height={32} radius="10px 10px 2px 10px" />
            <Skeleton className="self-start" width="60%" height={38} radius="10px 10px 10px 2px" />
          </div>
        )}
        {rows && rows.length === 0 && !loading && (
          <EmptyState
            icon={MessagesSquare}
            title="No messages yet"
            hint="LH2 stops capturing a thread once you take it over by hand. Paste the LinkedIn conversation to import its history."
            action={
              <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
                Import history
              </Button>
            }
          />
        )}
        {rows?.map((m, idx) => {
          const inbound = m.direction === 'in'
          const prev = idx > 0 ? rows[idx - 1] : null
          const newDay =
            !prev || new Date(prev.sent_at).toDateString() !== new Date(m.sent_at).toDateString()
          const busyRow = deleting !== null || savingEdit || editing !== null
          return (
            <Fragment key={m.id}>
            {newDay && (
              <div className="flex items-center gap-2.5 my-1 mx-0 text-app-text-muted before:content-[''] before:flex-1 before:h-px before:bg-app-border after:content-[''] after:flex-1 after:h-px after:bg-app-border"><span className="text-app-meta font-semibold uppercase tracking-[var(--tracking-caps)] whitespace-nowrap">{dayHeading(m.sent_at)}</span></div>
            )}
            <div className={`flex flex-col gap-[3px] max-w-[88%] ${inbound ? 'self-start items-start' : 'self-end items-end'}`}>
              <div
                className={[
                  'px-app-md py-app-sm text-app-table whitespace-pre-wrap [overflow-wrap:anywhere]',
                  inbound
                    ? 'bg-app-surface-2 border border-app-border rounded-[10px_10px_10px_2px]'
                    : 'bg-[var(--bubble-out)] text-[color:var(--bubble-out-fg)] rounded-[10px_10px_2px_10px]',
                ].join(' ')}
              >
                {editing?.id === m.id ? (
                  <Textarea
                    aria-label="Edit imported message"
                    className="block w-[min(340px,65vw)] min-h-[72px] text-app-table"
                    value={editing.body}
                    maxLength={5000}
                    autoFocus
                    onChange={(e) => setEditing({ id: m.id, body: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        // Cancels the edit, not the whole conversation.
                        e.stopPropagation()
                        setEditing(null)
                      }
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void editMessage(m)
                    }}
                  />
                ) : (
                  m.body || <span className="text-app-text-muted">(empty)</span>
                )}
              </div>
              <div className={`flex items-center gap-1.5 ${inbound ? '' : 'flex-row-reverse'}`}>
                <span className="text-app-meta text-app-text-muted">{clockTime(m.sent_at)}</span>
                {m.source === 'manual' && (
                  <>
                    <span
                      className="text-app-meta font-semibold uppercase tracking-[var(--tracking-caps)] text-app-text-muted border border-app-border rounded-sm px-[5px] cursor-help"
                      title="Imported from a pasted LinkedIn thread — this time is the real message time, not an LH2 action-run time"
                    >
                      imported
                    </span>
                    {editing?.id === m.id ? (
                      <>
                        <IconButton
                          className="size-8"
                          label="Save message"
                          icon={<Check size={16} aria-hidden="true" />}
                          loading={savingEdit}
                          disabled={!editing.body.trim()}
                          onClick={() => void editMessage(m)}
                        />
                        <IconButton
                          className="size-8"
                          label="Cancel editing"
                          icon={<X size={16} aria-hidden="true" />}
                          disabled={savingEdit}
                          onClick={() => setEditing(null)}
                        />
                      </>
                    ) : (
                      <IconButton
                        className="size-8"
                        data-edit-for={m.id}
                        label="Edit imported message"
                        icon={<Pencil size={16} aria-hidden="true" />}
                        disabled={busyRow}
                        onClick={() => setEditing({ id: m.id, body: m.body ?? '' })}
                      />
                    )}
                    <IconButton
                      className="size-8"
                      tone="danger"
                      label="Delete imported message"
                      icon={<Trash2 size={16} aria-hidden="true" />}
                      loading={deleting === m.id}
                      disabled={busyRow}
                      onClick={() => deleteMessage(m)}
                    />
                  </>
                )}
              </div>
            </div>
            </Fragment>
          )
        })}
      </div>

      {/* The review form is taller than the drawer at 720px. Capped and
          scrolling on its own, it can no longer push the coach and the notes
          below the drawer's bottom edge, out of reach. */}
      {manualReviewReady && latestInbound && (
        <div className="min-h-0 max-h-[45%] shrink overflow-y-auto border-t border-app-border px-app-xl py-app-md">
        <ReplyReviewPanel
          message={latestInbound as unknown as import('../lib/replyReview').ReplyThreadMessage}
          review={latestInbound.review ?? null}
          saving={replyActions.saving}
          error={replyActions.error}
          onDirtyChange={(dirty) => setReviewDirtyFor(dirty ? latestInbound.id : null)}
          onSave={async (draft) => {
            const saved = await replyActions.saveReview({
              instance_id: lead.instance_id,
              profile_url: lead.profile_url,
              message_id: latestInbound.id,
              expected_review_revision: latestInbound.review?.revision ?? 0,
              review: draft,
            })
            // A refused or failed save keeps the draft, and so keeps asking.
            if (saved) setReviewDirtyFor(null)
            return saved
          }}
        />
        </div>
      )}

      <ConversationSection
        title="AI coach"
        open={coachOpen}
        onToggle={() => setCoachOpen((o) => !o)}
        badges={actionMeta && (
          <Badge tone={actionMeta.tone} title="Suggested next action">
            {actionMeta.label}
          </Badge>
        )}
        actions={
          <Button
            variant="ghost"
            size="sm"
            loading={coachLoading}
            loadingLabel="Coaching…"
            onClick={() => {
              setCoachOpen(true)
              loadCoaching(!!coaching)
            }}
          >
            {coaching ? 'Regenerate' : 'Get coaching'}
          </Button>
        }
      >
        {coachError && <InlineError title="Coaching failed." message={coachError} />}
        {coachLoading && !coaching && (
          <p className="m-0 text-app-meta text-app-text-muted">Reading the conversation…</p>
        )}
        {!coaching && !coachLoading && !coachError && (
          <p className="m-0 text-app-meta text-app-text-muted">Get an AI read on what to say next to earn a reply.</p>
        )}

        {coaching && (
          <div className="flex flex-col gap-app-md text-app-table">
            {coaching.cached && <p className="m-0 text-app-meta text-app-text-muted">Cached take</p>}

            {coaching.summary && <p className="m-0">{coaching.summary}</p>}

            {coaching.issues.length > 0 && (
              <div>
                <h3 className="m-0 mb-app-xs text-app-meta font-semibold uppercase tracking-[var(--tracking-caps)] text-app-text-muted">What hurt your reply odds</h3>
                <div className="flex flex-col gap-app-sm">
                  {coaching.issues.map((iss, i) => (
                    <div className="flex flex-col items-start gap-[3px] pl-[9px] border-l-2 border-app-border" key={i}>
                      <Badge tone={SEVERITY_TONE[iss.severity]}>
                        {ISSUE_KIND_LABEL[iss.kind]}
                      </Badge>
                      <div>
                        {iss.quote && <div className="italic mb-0.5 [overflow-wrap:anywhere] text-app-text-muted">“{iss.quote}”</div>}
                        <div>{iss.fix}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {coaching.tips.length > 0 && (
              <div>
                <h3 className="m-0 mb-app-xs text-app-meta font-semibold uppercase tracking-[var(--tracking-caps)] text-app-text-muted">How to respond now</h3>
                <ul className="m-0 pl-[18px] flex flex-col gap-app-xs">
                  {coaching.tips.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}

            {coachStale && (
              <p className="m-0 text-app-meta text-app-text-muted italic">
                New messages since this was generated — Regenerate for an updated take.
              </p>
            )}
          </div>
        )}
      </ConversationSection>

      <LeadNotesPanel lead={lead} />
      </>
      )}

      {discardPrompt}
      {pendingLost && (
        <LostReasonModal
          leadName={live.full_name}
          onCancel={() => setPendingLost(false)}
          onConfirm={(reason) => {
            setPendingLost(false)
            void setStage(live, 'lost', { lostReason: reason })
          }}
        />
      )}
    </Dialog>
  )
}
