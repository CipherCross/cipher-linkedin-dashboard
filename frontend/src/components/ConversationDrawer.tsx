import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CalendarCheck2, Check, ExternalLink, MessagesSquare, Pencil, Sparkles, Trash2, X,
} from 'lucide-react'
import { authPost } from '../lib/api'
import { fetchNeonThread } from '../lib/dashboardReads'
import { useData } from '../lib/DataContext'
import { withLeadEdits } from '../lib/leadEdits'
import { useToast } from '../lib/ToastContext'
import { usePipelineActions } from '../lib/usePipelineActions'
import { ImportHistoryPanel } from './ImportHistoryPanel'
import { FollowUpPanel } from './FollowUpPanel'
import { MessageBubble } from './conversation/MessageBubble'
import { CoachPanel, useCoaching } from './conversation/CoachPanel'
import { ContextHeading, LeadContextPanel } from './conversation/LeadContextPanel'
import { groupMessages } from '../lib/messageGroups'
import { replyDayHeading, replyTime, REPLY_TIME_ZONE_LABEL } from '../lib/replyTime'
import { ReplyReviewPanel } from './conversation/ReplyReviewPanel'
import { useReplyReviewActions } from '../lib/useReplyReviewActions'
import { defaultReplyReadClient, isReplyManualReady } from '../lib/replyReview'
import { LostReasonModal } from './LostReasonModal'
import { LeadAvatar } from './Avatar'
import { Skeleton } from './Skeleton'
import { INTENT_META, SENTIMENT_META, instanceName } from '../lib/leads'
import {
  activeFollowUp,
  followUpDueLabel,
  followUpKey,
  followUpStateMap,
} from '../lib/followUps'
import type { ConversationMode } from '../lib/ConversationContext'
import type { Lead, Message } from '../lib/types'
import type { ReplyReview } from '../lib/replyReview'
import {
  Badge, Button, Dialog, EmptyState, ExternalLinkButton, IconButton, InlineError, LinkButton,
  Textarea, useDirtyGuard,
} from '../ui'

/** The reply-review thread read pages at this size; a full page may be capped. */
const THREAD_LIMIT = 100

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

/** One lead's conversation as a modal workspace in three panes: Context (who
 *  this is, the funnel, pipeline fields, notes), the Conversation (both
 *  directions, oldest first, or the import view in its place), and Actions
 *  (follow-up and the manual review of the latest reply). The AI coach opens
 *  as a side panel in place of Actions. */
export function ConversationDrawer({
  lead,
  initialMode = 'thread',
  onClose,
}: {
  lead: Lead | null
  initialMode?: ConversationMode
  onClose: () => void
}) {
  const { data, refetch, leadEdits, loadFollowUpState } = useData()
  const toast = useToast()
  const { setStage } = usePipelineActions()
  const [pendingLost, setPendingLost] = useState(false)
  const [rows, setRows] = useState<ThreadMsg[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The imported message currently being deleted (for the inline spinner).
  const [deleting, setDeleting] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [replyCapabilities, setReplyCapabilities] = useState<Awaited<ReturnType<typeof defaultReplyReadClient.capabilities>> | null>(null)
  const coach = useCoaching(lead)
  const [coachOpen, setCoachOpen] = useState(false)
  const coachId = useId()
  const [importOpen, setImportOpen] = useState(initialMode === 'import_history')
  const [followUpOpen, setFollowUpOpen] = useState(initialMode === 'follow_up')
  const [followUpReturnAction, setFollowUpReturnAction] = useState<
    'complete' | 'skip' | undefined
  >()
  const threadRef = useRef<HTMLDivElement>(null)
  // The import view, when it replaces the thread.
  const importRef = useRef<HTMLDivElement>(null)
  // The follow-up view, when it replaces the actions, and the button that opens it.
  const followUpRef = useRef<HTMLDivElement>(null)
  const followUpTriggerRef = useRef<HTMLButtonElement>(null)
  const coachTriggerRef = useRef<HTMLButtonElement>(null)
  // Bumped after a manual import so the thread effect refetches the new rows.
  const [reloadKey, setReloadKey] = useState(0)
  const [importDirty, setImportDirty] = useState(false)
  // A typed note that has not been added. Only closing can lose it.
  const [noteDirty, setNoteDirty] = useState(false)
  // The inbound message whose review form has unsaved edits. Keyed by message
  // so a newer reply (which remounts the form with a fresh draft) is not
  // mistaken for the edited one.
  const [reviewDirtyFor, setReviewDirtyFor] = useState<number | null>(null)
  const replyActions = useReplyReviewActions(() => { setReloadKey((value) => value + 1); refetch() })
  // The review revision the server reported in a 409 — the reply was reviewed
  // meanwhile, by a teammate. The next save is checked against it, so Save
  // again overwrites deliberately instead of conflicting forever; reloading the
  // thread instead would remount the form and drop the SDR's input. Cleared
  // whenever the thread reloads.
  const [conflictRevision, setConflictRevision] = useState<number | null>(null)
  useEffect(() => { setConflictRevision(null) }, [reloadKey, lead?.id])
  useEffect(() => {
    const conflict = replyActions.conflict
    if (!conflict) return
    const current = conflict.current as { revision?: unknown } | null | undefined
    setConflictRevision(typeof current?.revision === 'number' ? current.revision : 0)
  }, [replyActions.conflict])

  // Switching leads (or opening one from the worklist) resets the transient
  // workflow and honors the caller's requested destination.
  useEffect(() => {
    setImportOpen(initialMode === 'import_history')
    setFollowUpOpen(initialMode === 'follow_up')
    setFollowUpReturnAction(undefined)
    setEditing(null)
    setSavingEdit(false)
    setCoachOpen(false)
  }, [lead, initialMode])

  // The thread renders oldest-first; triage users click a recent reply, so open
  // at the newest message. Re-runs after an import bumps reloadKey.
  useEffect(() => {
    if (!rows || importOpen) return
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows, reloadKey, importOpen])

  // A view that replaces a pane unmounts the control that opened or closed it.
  // Focus goes to what the pane returns to — the messages, the follow-up
  // button — or, on opening, to the view itself when focus was lost.
  const focusLost = () => !document.activeElement || document.activeElement === document.body
    || document.activeElement.getAttribute('role') === 'dialog'
  const wasImport = useRef(importOpen)
  useEffect(() => {
    if (wasImport.current && !importOpen) threadRef.current?.focus()
    else if (importOpen && focusLost()) importRef.current?.focus()
    wasImport.current = importOpen
  }, [importOpen])
  const wasFollowUp = useRef(followUpOpen)
  useEffect(() => {
    if (wasFollowUp.current && !followUpOpen && focusLost()) followUpTriggerRef.current?.focus()
    else if (followUpOpen && focusLost()) followUpRef.current?.focus()
    wasFollowUp.current = followUpOpen
  }, [followUpOpen])
  // Closing the coach unmounts its close button; return focus to the toggle.
  const wasCoach = useRef(coachOpen)
  useEffect(() => {
    if (wasCoach.current && !coachOpen && focusLost()) coachTriggerRef.current?.focus()
    wasCoach.current = coachOpen
  }, [coachOpen])

  // Saving or cancelling an edit unmounts its text box; return focus to that
  // message's edit button rather than letting it fall to the dialog itself.
  const lastEdited = useRef<number | null>(null)
  useEffect(() => {
    if (editing) { lastEdited.current = editing.id; return }
    if (lastEdited.current == null) return
    threadRef.current?.querySelector<HTMLElement>(`[data-edit-for="${lastEdited.current}"]`)?.focus()
    lastEdited.current = null
  }, [editing])

  // Leads is page-local and carries no follow-up states; fetch this
  // conversation's so Schedule follow-up works here and not only on Pipeline.
  // A failure leaves the button hidden, as it was, rather than guessing.
  useEffect(() => {
    if (!lead) return
    loadFollowUpState(lead.instance_id, lead.profile_url).catch(() => {})
  }, [lead?.instance_id, lead?.profile_url, loadFollowUpState])

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
      try {
        const thread = isReplyManualReady(replyCapabilities)
          ? (await defaultReplyReadClient.thread({ instance_id: lead.instance_id, profile_url: lead.profile_url, limit: THREAD_LIMIT })).messages
          : await fetchNeonThread(lead.instance_id, lead.profile_url)
        if (cancelled) return
        setRows(thread as ThreadMsg[])
      } catch (e) {
        if (cancelled) return
        // The reply-review thread read answers 404 for a conversation with no
        // messages at all — a lead invited or accepted but never written to.
        // Here that is an empty thread, not a failure: it is exactly the lead
        // whose history the SDR has come here to import.
        if ((e as { code?: string }).code === 'REPLY_REVIEW_NOT_FOUND') setRows([])
        else setError(e instanceof Error ? e.message : String(e))
      }
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

  // Unsaved work: a pasted/parsed import that has not been saved, edits to the
  // review form, or a typed note. Every pane stays mounted while another view
  // is open (the review hides under follow-up and the coach), so only closing
  // the workspace — Escape, backdrop, Close, or one of its navigation links —
  // can lose it, and that asks Keep editing / Discard changes first.
  const navigate = useNavigate()
  const latestInbound = rows
    ? [...rows].reverse().find((m) => m.direction === 'in' && m.body)
    : undefined
  const reviewUnsaved = reviewDirtyFor !== null && reviewDirtyFor === (latestInbound?.id ?? null)
  const unsaved = (importOpen && importDirty) || reviewUnsaved || noteDirty
  const { guard: closeGuard, prompt: closePrompt } = useDirtyGuard(unsaved)
  const discardAllAnd = (action: () => void) => closeGuard(() => {
    setImportDirty(false)
    setReviewDirtyFor(null)
    setNoteDirty(false)
    action()
  })
  const requestClose = () => discardAllAnd(onClose)
  /** A link inside the workspace both navigates and closes it; with unsaved
   *  work the navigation waits for the answer. */
  const guardedLinkClick = (to: string) => (event: React.MouseEvent) => {
    if (!unsaved) {
      onClose()
      return
    }
    event.preventDefault()
    discardAllAnd(() => { onClose(); navigate(to) })
  }

  if (!lead) return null

  // The `lead` prop is a snapshot captured when the workspace opened; pipeline
  // fields (stage/substatus/assignee) mutate in place via patchLead, so read
  // the live row from context for those controls. Leads reads its rows
  // page-locally, so a lead opened there is not in data.leads at all — its
  // saved edits come from leadEdits instead.
  const live = data?.leads.find((x) => x.id === lead.id) ?? withLeadEdits(lead, leadEdits)
  const followUpState = followUpStateMap(data?.followUpStates ?? []).get(
    followUpKey(lead.instance_id, lead.profile_url),
  )
  const followUpActive = activeFollowUp(followUpState)

  const campaignName =
    data?.campaigns.find((c) => c.campaign_id === lead.campaign_id)?.campaign_name ??
    lead.campaign_id
  const outreachAccount = data?.instances.find((i) => i.id === lead.instance_id)
  const accountLabel = instanceName(outreachAccount, lead.instance_id)

  // The lead's effective status = its most recent classified inbound reply.
  const latestSentiment = latestInbound?.review?.sentiment ?? latestInbound?.sentiment
  const latestReason = latestInbound?.review?.reason_ids?.join(', ') ?? latestInbound?.reason
  const statusMeta = latestSentiment ? SENTIMENT_META[latestSentiment] : null
  const latestIntent = latestInbound?.review?.intent_level ?? latestInbound?.intent_level
  const latestIntentMeta = latestIntent ? INTENT_META[latestIntent] : null
  const manualReviewReady = isReplyManualReady(replyCapabilities)

  const status = (
    <>
      {statusMeta ? (
        <Badge tone={statusMeta.tone} title={latestReason ?? 'Follows the most recent reply'}>
          {statusMeta.label}
        </Badge>
      ) : (
        <Badge tone="neutral">{latestInbound ? 'Not reviewed' : 'No reply yet'}</Badge>
      )}
      {latestIntentMeta && (
        <Badge tone={latestIntentMeta.tone} title={latestInbound?.intent_reason ?? 'Commercial intent on latest reply'}>
          {latestIntentMeta.short} · {latestIntentMeta.label}
        </Badge>
      )}
    </>
  )

  const openCoach = (generate: boolean) => {
    setCoachOpen(true)
    if (generate && !coach.coaching && !coach.loading) void coach.load(false)
  }

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

  const name = lead.full_name || lead.profile_url.replace('https://www.linkedin.com/in/', '')
  const identityLine = [lead.headline, lead.company].filter(Boolean).join(' · ')
  const lastRow = rows && rows.length ? rows[rows.length - 1] : null

  return (
    <Dialog
      size="workspace"
      title={
        <span className="flex items-center gap-app-md min-w-0">
          {/* The avatar's initials would otherwise be read as part of the name. */}
          <span aria-hidden="true" className="contents"><LeadAvatar lead={lead} size={40} /></span>
          <span className="truncate">{name}</span>
        </span>
      }
      description={identityLine || '—'}
      headerActions={
        <>
          <ExternalLinkButton
            variant="ghost"
            size="sm"
            href={lead.profile_url}
            target="_blank"
            rel="noreferrer"
            icon={<ExternalLink aria-hidden="true" />}
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
          {/* Hidden while the import view is open, and while the empty state
              shows — that state carries its own Import-history action. */}
          {!importOpen && !(rows && rows.length === 0) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setImportOpen(true)}
              disabled={!rows}
              title="Paste a conversation copied from LinkedIn"
            >
              Import history
            </Button>
          )}
          <Button
            ref={coachTriggerRef}
            variant={coachOpen ? 'primary' : 'secondary'}
            size="sm"
            icon={<Sparkles aria-hidden="true" />}
            aria-expanded={coachOpen}
            aria-controls={coachId}
            onClick={() => (coachOpen ? setCoachOpen(false) : openCoach(false))}
          >
            AI coach
          </Button>
        </>
      }
      onRequestClose={requestClose}
      // Focus starts in whatever the workspace opened on: the messages, so the
      // keyboard can scroll the thread at once, or the import / follow-up view.
      initialFocusRef={importOpen ? importRef : followUpOpen ? followUpRef : threadRef}
      bodyClassName="p-0 overflow-hidden"
    >
      <div className="conversation-workspace" data-coach={coachOpen ? 'open' : 'closed'}>
        {/* The panes carry no visible titles: what they hold is obvious, and
            the space goes to the content. Each keeps its accessible name. */}
        <section className="conversation-pane" aria-label="Context">
          <LeadContextPanel
            lead={lead}
            live={live}
            campaignName={campaignName}
            account={outreachAccount}
            accountLabel={accountLabel}
            status={status}
            onLinkClick={guardedLinkClick}
            onRequestLost={() => setPendingLost(true)}
            onNoteDirtyChange={setNoteDirty}
          />
        </section>

        <section className="conversation-pane" aria-label="Conversation">

          {error && (
            <div className="shrink-0 px-pane pt-pane">
              <InlineError
                title="The conversation could not load."
                message={error}
                onRetry={() => setReloadKey((k) => k + 1)}
              />
            </div>
          )}

          {importOpen ? (
            <div
              ref={importRef}
              tabIndex={-1}
              role="region"
              aria-label="Import history"
              className="flex-1 min-h-0 flex flex-col focus:outline-none"
            >
              <ImportHistoryPanel
                lead={lead}
                accountName={outreachAccount?.account_name ?? null}
                existing={rows}
                onImported={() => {
                  setReloadKey((k) => k + 1)
                  refetch()
                }}
                onClose={() => setImportOpen(false)}
                onDirtyChange={setImportDirty}
              />
            </div>
          ) : (
            <div
              className="flex-1 min-h-0 overflow-y-auto p-pane flex flex-col gap-group [overscroll-behavior:contain] focus-visible:outline-2 focus-visible:outline-app-accent focus-visible:-outline-offset-2"
              ref={threadRef}
              role="region"
              aria-label="Messages"
              tabIndex={0}
            >
              {loading && (
                <div className="flex flex-col gap-group" aria-hidden="true">
                  <Skeleton className="self-start" width="68%" height={44} radius="10px 10px 10px 2px" />
                  <Skeleton className="self-end" width="54%" height={32} radius="10px 10px 2px 10px" />
                  <Skeleton className="self-start" width="60%" height={38} radius="10px 10px 10px 2px" />
                </div>
              )}
              {rows && rows.length === 0 && !loading && (
                <EmptyState
                  className="my-auto"
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
              {rows && groupMessages(rows).map((group) => {
                const inbound = group.direction === 'in'
                const last = group.messages[group.messages.length - 1]
                const busyRow = deleting !== null || savingEdit || editing !== null
                return (
                  <Fragment key={group.key}>
                  {group.startsDay && (
                    <div className="flex items-center gap-app-sm my-app-xs mx-0 text-app-text-muted before:content-[''] before:flex-1 before:h-px before:bg-app-border after:content-[''] after:flex-1 after:h-px after:bg-app-border"><span className="text-app-meta font-semibold uppercase tracking-[var(--tracking-caps)] whitespace-nowrap">{replyDayHeading(last.sent_at)}</span></div>
                  )}
                  <div className={`flex flex-col gap-app-xs max-w-[min(80%,560px)] ${inbound ? 'self-start items-start' : 'self-end items-end'}`}>
                  {group.messages.map((m, index) => (
                    <Fragment key={m.id}>
                    <MessageBubble
                      direction={group.direction}
                      tail={index === group.messages.length - 1}
                      title={`${replyTime(m.sent_at, true)} · ${REPLY_TIME_ZONE_LABEL}`}
                    >
                      {editing?.id === m.id ? (
                        <Textarea
                          aria-label="Edit imported message"
                          className="block w-[min(420px,50vw)] min-h-[72px] text-app-table"
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
                        <span className="message-bubble__body">{m.body || <span className="opacity-70">(empty)</span>}</span>
                      )}
                    </MessageBubble>
                    {m.source === 'manual' && (
                      /* The controls sit beside the bubble, never inside it. */
                      <div className={`flex items-center gap-app-xs ${inbound ? '' : 'flex-row-reverse'}`}>
                          <Badge title="Imported from a pasted LinkedIn thread — this time is the real message time, not an LH2 action-run time">
                            Imported
                          </Badge>
                          {editing?.id === m.id ? (
                            <>
                              <IconButton
                                label="Save message"
                                icon={<Check aria-hidden="true" />}
                                loading={savingEdit}
                                disabled={!editing.body.trim()}
                                onClick={() => void editMessage(m)}
                              />
                              <IconButton
                                label="Cancel editing"
                                icon={<X aria-hidden="true" />}
                                disabled={savingEdit}
                                onClick={() => setEditing(null)}
                              />
                            </>
                          ) : (
                            <IconButton
                              data-edit-for={m.id}
                              label="Edit imported message"
                              icon={<Pencil aria-hidden="true" />}
                              disabled={busyRow}
                              onClick={() => setEditing({ id: m.id, body: m.body ?? '' })}
                            />
                          )}
                          <IconButton
                            tone="danger"
                            label="Delete imported message"
                            icon={<Trash2 aria-hidden="true" />}
                            loading={deleting === m.id}
                            disabled={busyRow}
                            onClick={() => deleteMessage(m)}
                          />
                      </div>
                    )}
                    </Fragment>
                  ))}
                    <time className="text-app-meta text-app-text-muted" dateTime={last.sent_at} title={REPLY_TIME_ZONE_LABEL}>{replyTime(last.sent_at)}</time>
                  </div>
                  </Fragment>
                )
              })}
            </div>
          )}
        </section>

        {/* Hidden, never unmounted, while the coach is open: an edited review
            keeps its draft. */}
        <section className="conversation-pane" aria-label="Actions" hidden={coachOpen}>

          {followUpOpen && (
            <div
              ref={followUpRef}
              tabIndex={-1}
              role="region"
              aria-label="Follow-up"
              className="flex-1 min-h-0 flex flex-col focus:outline-none"
            >
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
            </div>
          )}

          {/* Kept mounted under the follow-up view, so a review draft survives it. */}
          <div className="flex-1 min-h-0 overflow-y-auto [overscroll-behavior:contain]" hidden={followUpOpen}>
            <div className="flex flex-col gap-stack p-pane border-b border-app-border">
              <ContextHeading>Next message</ContextHeading>
              <p className="m-0 text-app-table text-app-text-secondary">
                Get 10–15 options for what to write next, and feedback on the messages you wrote by hand.
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                icon={<Sparkles aria-hidden="true" />}
                onClick={() => openCoach(true)}
              >
                {coach.coaching ? 'Show message ideas' : 'Get message ideas'}
              </Button>
            </div>

            {data?.followUpsAvailable && (
              <div className="flex flex-col gap-stack p-pane border-b border-app-border">
                <ContextHeading>Follow-up</ContextHeading>
                <p className={`m-0 text-app-table ${followUpActive ? 'font-semibold text-app-text' : 'text-app-text-secondary'}`}>
                  {followUpActive ? followUpDueLabel(followUpState) : 'No follow-up scheduled.'}
                </p>
                <Button
                  ref={followUpTriggerRef}
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  icon={<CalendarCheck2 aria-hidden="true" />}
                  onClick={() => {
                    setFollowUpReturnAction(undefined)
                    setFollowUpOpen(true)
                  }}
                >
                  {followUpActive ? 'Manage follow-up' : 'Schedule follow-up'}
                </Button>
              </div>
            )}

            {manualReviewReady && latestInbound && (
              <ReplyReviewPanel
                message={latestInbound as unknown as import('../lib/replyReview').ReplyThreadMessage}
                review={latestInbound.review ?? null}
                saving={replyActions.saving}
                error={replyActions.error ?? (replyActions.conflict
                  ? 'This reply was reviewed meanwhile by a teammate. Your choices are kept — Save again to replace that review.'
                  : null)}
                onDirtyChange={(dirty) => setReviewDirtyFor(dirty ? latestInbound.id : null)}
                onSave={async (draft) => {
                  const saved = await replyActions.saveReview({
                    instance_id: lead.instance_id,
                    profile_url: lead.profile_url,
                    message_id: latestInbound.id,
                    expected_review_revision: conflictRevision ?? latestInbound.review?.revision ?? 0,
                    review: draft,
                  })
                  // A refused or failed save keeps the draft, and so keeps asking.
                  if (saved) setReviewDirtyFor(null)
                  return saved
                }}
              />
            )}
            {manualReviewReady && rows && !latestInbound && (
              <p className="m-0 p-pane text-app-meta text-app-text-muted">
                The reply review appears here once the prospect replies.
              </p>
            )}
          </div>
        </section>

        {coachOpen && (
          <CoachPanel
            id={coachId}
            state={coach}
            threadSize={rows?.length ?? 0}
            threadLastSentAt={lastRow?.sent_at ?? null}
            threadCapped={!!rows && rows.length >= THREAD_LIMIT}
            onClose={() => setCoachOpen(false)}
          />
        )}
      </div>

      {closePrompt}
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
