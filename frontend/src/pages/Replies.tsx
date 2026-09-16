import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Filter, Inbox, RefreshCw, Search, X } from 'lucide-react'
import { Link, UNSAFE_DataRouterContext, useBlocker, useLocation } from 'react-router-dom'
import { InitialsAvatar } from '../components/Avatar'
import { useData } from '../lib/DataContext'
import { useConversation } from '../lib/ConversationContext'
import { replyTime, REPLY_TIME_ZONE_LABEL } from '../lib/replyTime'
import { ConversationActionPanel } from '../components/conversation/ConversationActionPanel'
import { ConversationThread } from '../components/conversation/ConversationThread'
import { ReplyReviewPanel } from '../components/conversation/ReplyReviewPanel'
import { WORKFLOW_LABELS } from '../components/reply-analysis/WorkflowBuckets'
import { EmptyState } from '../components/EmptyState'
import { useReplyReviewActions } from '../lib/useReplyReviewActions'
import { useRepliesInbox } from '../lib/useRepliesInbox'
import { ACTION_LABELS, isReplyManualReady, REASON_LABELS, SENTIMENT_LABELS, nextUnreviewedReply, REPLY_SEARCH_DEBOUNCE_MS, type ReplyCapabilities, type ReplyInboxScope, type ReplyReadClient, type ReplyReviewDraft, type ReplyThreadMessage, type ReplyWorkflowMutation } from '../lib/replyReview'
import { Button, Checkbox, Dialog, ExternalLinkButton, FilterCount, IconButton, LinkButton, PageHeader, SelectField, Tabs } from '../ui'
import { COPY } from '../ui/labels'
import { UNKNOWN_PERSON_LABEL } from '../ui/Identity'
import './replies-inbox.css'

const VIEWS: ReplyInboxScope['view'][] = ['all', 'unreviewed', 'needs_reply', 'deferred', 'completed']
const VIEW_LABELS: Record<ReplyInboxScope['view'], string> = { all: COPY.all, unreviewed: COPY.unreviewed, needs_reply: COPY.needsReply, deferred: COPY.deferred, completed: COPY.completed }
function formatTime(value: string | null): string { return value ? replyTime(value, true) : '—' }
function profileName(profile: string): string { return profile.split('/').filter(Boolean).pop() || profile }
function capabilityMessage(capabilities: ReplyCapabilities | null): string {
  if (!capabilities) return 'Checking whether manual review is available…'
  if (capabilities.activation_in_progress) {
    const progress = capabilities.activation_total ? ` (${capabilities.activation_processed ?? 0}/${capabilities.activation_total})` : ''
    return `Manual review is being switched on${progress}. Replies opens once that finishes.`
  }
  if (capabilities.mode === 'prepared' || capabilities.manual_ready === false || capabilities.active === false) return 'Manual review is prepared but not switched on for this workspace yet.'
  return capabilities.unavailable_reason || 'Replies is not available for this workspace yet.'
}

type NavigationRequest = { proceed: () => void; cancel?: () => void }

function DataRouterNavigationGuard({ dirty, onRequest }: { dirty: boolean; onRequest: (request: NavigationRequest) => void }) {
  const blocker = useBlocker(dirty)
  const requested = useRef(false)
  useEffect(() => {
    if (blocker.state !== 'blocked') { requested.current = false; return }
    if (requested.current) return
    requested.current = true
    onRequest({ proceed: () => blocker.proceed(), cancel: () => { requested.current = false; blocker.reset() } })
  }, [blocker, onRequest])
  return null
}

function LegacyNavigationGuard({ dirty, onRequest }: { dirty: boolean; onRequest: (request: NavigationRequest) => void }) {
  const location = useLocation()
  const dirtyRef = useRef(dirty)
  const restoringHistory = useRef(false)
  const approvedHistory = useRef(false)
  const approvedLink = useRef(false)
  const historyIndex = useRef<number | null>(typeof window === 'undefined' ? null : (window.history.state?.idx ?? null))
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => { historyIndex.current = window.history.state?.idx ?? null }, [location])
  useEffect(() => {
    const onPopState = () => {
      if (restoringHistory.current) { restoringHistory.current = false; return }
      if (approvedHistory.current) { approvedHistory.current = false; return }
      const targetIndex = window.history.state?.idx ?? null
      const previousIndex = historyIndex.current
      historyIndex.current = targetIndex
      if (!dirtyRef.current) return
      if (previousIndex != null && targetIndex != null && previousIndex !== targetIndex) {
        restoringHistory.current = true
        historyIndex.current = previousIndex
        window.history.go(previousIndex - targetIndex)
        onRequest({ proceed: () => { dirtyRef.current = false; approvedHistory.current = true; window.history.go(targetIndex - previousIndex) } })
      }
    }
    const onLinkClick = (event: MouseEvent) => {
      if (!dirtyRef.current || approvedLink.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest('a[href]') as HTMLAnchorElement | null
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return
      const destination = new URL(anchor.href, window.location.href)
      if (destination.origin !== window.location.origin || !destination.hash.startsWith('#/')) return
      event.preventDefault()
      event.stopPropagation()
      onRequest({ proceed: () => { dirtyRef.current = false; approvedLink.current = true; anchor.click(); approvedLink.current = false } })
    }
    window.addEventListener('popstate', onPopState)
    document.addEventListener('click', onLinkClick, true)
    return () => { window.removeEventListener('popstate', onPopState); document.removeEventListener('click', onLinkClick, true) }
  }, [onRequest])
  return null
}

function NavigationGuard({ dirty, onRequest }: { dirty: boolean; onRequest: (request: NavigationRequest) => void }) {
  const dataRouter = useContext(UNSAFE_DataRouterContext)
  return dataRouter ? <DataRouterNavigationGuard dirty={dirty} onRequest={onRequest} /> : <LegacyNavigationGuard dirty={dirty} onRequest={onRequest} />
}

/* The filters the sheet owns and commits together. The view tabs, the account
 * selector and the search box are on the page itself and stay immediate. */
const FILTER_DRAFT_KEYS = [
  'scope', 'campaign', 'owner', 'unowned', 'sentiment', 'reason', 'action',
  'my', 'unacknowledged', 'overdue',
] as const
type RepliesFilterDraft = Pick<ReplyInboxScope, typeof FILTER_DRAFT_KEYS[number]>

function pickFilterDraft(scope: ReplyInboxScope): RepliesFilterDraft {
  return {
    scope: scope.scope, campaign: scope.campaign, owner: scope.owner,
    unowned: scope.unowned, sentiment: scope.sentiment, reason: scope.reason,
    action: scope.action, my: scope.my, unacknowledged: scope.unacknowledged,
    overdue: scope.overdue,
  }
}

const EMPTY_FILTER_DRAFT: RepliesFilterDraft = {
  scope: 'new', campaign: null, owner: null, unowned: false, sentiment: null,
  reason: null, action: null, my: false, unacknowledged: false, overdue: false,
}

export function Replies({ client }: { client?: ReplyReadClient } = {}) {
  const { data } = useData()
  const { openConversation } = useConversation()
  const inbox = useRepliesInbox(client)
  const [search, setSearch] = useState(inbox.scope.query)
  /* The filter sheet edits a draft and commits it on Apply. Every field used
   * to call guardedScope on change, so Escape dismissed a dialog whose changes
   * had already refetched the list and rewritten the URL. `null` = closed. */
  const [filterDraft, setFilterDraft] = useState<RepliesFilterDraft | null>(null)
  const filtersOpen = filterDraft !== null
  const [workflowValid, setWorkflowValid] = useState(true)
  const [pendingNavigation, setPendingNavigation] = useState<NavigationRequest | null>(null)
  const [mobileStep, setMobileStep] = useState<'list' | 'thread' | 'review'>('list')
  const [newInboundAvailable, setNewInboundAvailable] = useState(false)
  const seenInboundRevision = useRef<{ key: string; revision: number } | null>(null)
  const [reviewDirty, setReviewDirty] = useState(false)
  const [workflowUserDirty, setWorkflowUserDirty] = useState(false)
  const [autoDncDerived, setAutoDncDerived] = useState(false)
  const [autoDncSnapshot, setAutoDncSnapshot] = useState<Pick<ReplyWorkflowMutation, 'action' | 'next_follow_up_date' | 'do_not_contact'> | null>(null)
  const [workflowDncUserTouched, setWorkflowDncUserTouched] = useState(false)
  const workflowDirty = workflowUserDirty || autoDncDerived
  const dirty = reviewDirty || workflowDirty
  const [workflowDraft, setWorkflowDraft] = useState<ReplyWorkflowMutation | null>(null)
  const workflowDraftRef = useRef<ReplyWorkflowMutation | null>(null)
  useEffect(() => { workflowDraftRef.current = workflowDraft }, [workflowDraft])
  const itemCache = useRef(new Map<string, typeof inbox.items[number]>())
  inbox.items.forEach((item) => itemCache.current.set(`${item.instance_id}|${item.profile_url}`, item))
  const selectedItem = inbox.scope.thread ? itemCache.current.get(`${inbox.scope.thread.instance_id}|${inbox.scope.thread.profile_url}`) ?? null : null
  const selectedLead = useMemo(() => data?.leads.find((lead) => lead.instance_id === inbox.scope.thread?.instance_id && lead.profile_url === inbox.scope.thread?.profile_url) ?? null, [data?.leads, inbox.scope.thread?.instance_id, inbox.scope.thread?.profile_url])
  const hasSelection = inbox.scope.thread !== null
  const selectedMessage = useMemo<ReplyThreadMessage | null>(() => {
    if (!inbox.thread?.messages.length) return null
    const focus = inbox.scope.thread?.focus_message_id
    return focus != null ? inbox.thread.messages.find((message) => message.id === focus) ?? null : [...inbox.thread.messages].reverse().find((message) => message.direction === 'in') ?? inbox.thread.messages[inbox.thread.messages.length - 1]
  }, [inbox.scope.thread, inbox.thread])
  const selectedThreadKey = inbox.scope.thread ? `${inbox.scope.thread.instance_id}|${inbox.scope.thread.profile_url}` : null
  const latestInbound = [...(inbox.thread?.messages ?? [])].reverse().find((message) => message.direction === 'in') ?? null
  useEffect(() => {
    if (!selectedThreadKey || !inbox.thread) return
    const revision = inbox.thread.inbound_revision ?? 0
    if (seenInboundRevision.current?.key !== selectedThreadKey) {
      seenInboundRevision.current = { key: selectedThreadKey, revision }
      setNewInboundAvailable(false)
    } else if (revision > seenInboundRevision.current.revision) {
      seenInboundRevision.current.revision = revision
      if (latestInbound?.id !== selectedMessage?.id || inbox.thread.newer_cursor) setNewInboundAvailable(true)
    }
    if (latestInbound && latestInbound.id === selectedMessage?.id && !inbox.thread.newer_cursor) setNewInboundAvailable(false)
  }, [selectedThreadKey, inbox.thread, latestInbound?.id, selectedMessage?.id])
  const actionRefresh = useCallback(() => { inbox.refresh() }, [inbox.refresh])
  const actions = useReplyReviewActions(actionRefresh)
  useEffect(() => { if (!hasSelection) setMobileStep('list'); else if (mobileStep === 'list') setMobileStep('thread') }, [hasSelection, mobileStep])
  useEffect(() => {
    const workflow = inbox.thread?.workflow ?? selectedItem
    if (dirty) return
    setWorkflowDraft(workflow ? { expected_revision: 'workflow_revision' in workflow ? workflow.workflow_revision : workflow.revision, observed_inbound_revision: workflow.inbound_revision ?? 0, action: workflow.action, owner_id: workflow.owner_id, next_follow_up_date: workflow.next_follow_up_date, do_not_contact: workflow.do_not_contact, change_reason: null } : null)
    setReviewDirty(false)
    setWorkflowUserDirty(false)
    setAutoDncDerived(false)
    setAutoDncSnapshot(null)
    setWorkflowDncUserTouched(false)
  }, [inbox.scope.thread?.instance_id, inbox.scope.thread?.profile_url, inbox.thread?.workflow?.revision, selectedItem?.revision])
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
  const queueNavigation = useCallback((request: NavigationRequest) => setPendingNavigation(request), [])
  const confirmNavigation = useCallback((action: () => void) => { if (dirty) queueNavigation({ proceed: action }); else action() }, [dirty, queueNavigation])
  const clearDirty = useCallback(() => { setReviewDirty(false); setWorkflowUserDirty(false); setAutoDncDerived(false); setAutoDncSnapshot(null); setWorkflowDncUserTouched(false) }, [])
  const navigateWithoutGuard = useCallback((item: typeof selectedItem, focus?: number | null) => { clearDirty(); inbox.selectThread(item, focus); setMobileStep(item ? 'thread' : 'list') }, [clearDirty, inbox])
  const guardedSelect = useCallback((item: typeof selectedItem, focus?: number | null) => { confirmNavigation(() => navigateWithoutGuard(item, focus)) }, [confirmNavigation, navigateWithoutGuard])
  const guardedScope = useCallback((patch: Partial<ReplyInboxScope>, options?: { replace?: boolean }) => { confirmNavigation(() => { clearDirty(); inbox.setScope(patch, options) }) }, [clearDirty, confirmNavigation, inbox])
  const updateScope = useCallback((patch: Partial<ReplyInboxScope>) => inbox.setScope(patch), [inbox])
  useEffect(() => {
    if (search === inbox.scope.query) return
    const timer = window.setTimeout(() => guardedScope({ query: search, cursor: null }, { replace: true }), REPLY_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [guardedScope, inbox.scope.query, search])
  const saveReviewDraft = useCallback(async (draft: ReplyReviewDraft, confirmAutoReset?: boolean, moveNext = false) => {
    if (!inbox.scope.thread || !selectedMessage || selectedMessage.direction !== 'in' || (workflowDirty && !workflowValid)) return
    const result = await actions.saveReview({ instance_id: inbox.scope.thread.instance_id, profile_url: inbox.scope.thread.profile_url, message_id: selectedMessage.id, expected_review_revision: selectedMessage.review?.revision ?? 0, review: draft, workflow: workflowDraft && workflowDirty ? workflowDraft : undefined, confirmAutoReset })
    if (!result) return
    clearDirty()
    if (moveNext) {
      const target = nextUnreviewedReply(inbox.thread?.messages ?? [], inbox.items, selectedMessage.id, inbox.scope.thread)
      if (target?.kind === 'message') { updateScope({ thread: { instance_id: target.value.instance_id, profile_url: target.value.profile_url, focus_message_id: target.value.id } }); return }
      if (target?.kind === 'thread') { navigateWithoutGuard(target.value); return }
      if (inbox.nextCursor) { const next = await inbox.nextPendingPage(); if (next) navigateWithoutGuard(next) }
      return
    }
    if (pendingNavigation) { pendingNavigation.proceed(); setPendingNavigation(null) }
  }, [actions, clearDirty, inbox.items, inbox.thread?.messages, inbox.scope.thread, inbox.nextCursor, inbox.nextPendingPage, navigateWithoutGuard, selectedMessage, workflowDirty, workflowDraft, workflowValid, pendingNavigation, updateScope])
  const saveReview = useCallback((draft: ReplyReviewDraft, confirm?: boolean) => saveReviewDraft(draft, confirm), [saveReviewDraft])
  const saveReviewAndNext = useCallback((draft: ReplyReviewDraft, confirm?: boolean) => saveReviewDraft(draft, confirm, true), [saveReviewDraft])
  const saveWorkflow = useCallback((workflow: ReplyWorkflowMutation) => {
    if (!inbox.scope.thread || !workflowValid) return Promise.resolve(null)
    return actions.saveWorkflow({ instance_id: inbox.scope.thread.instance_id, profile_url: inbox.scope.thread.profile_url, workflow }).then((result) => { if (result) { setWorkflowUserDirty(false); setAutoDncDerived(false); setAutoDncSnapshot(null); setWorkflowDncUserTouched(false); if (pendingNavigation) { pendingNavigation.proceed(); setPendingNavigation(null) } } return result })
  }, [actions, inbox.scope.thread, workflowValid, pendingNavigation])
  const handleReviewDraftChange = useCallback((draft: ReplyReviewDraft) => {
    if (!inbox.scope.thread) return
    const hasDncReason = draft.reason_ids.includes('do_not_contact')
    // DNC selected as a review reason must be saved atomically with workflow.
    // Removing the reason never clears an already-installed DNC decision.
    if (hasDncReason && !(inbox.thread?.workflow?.do_not_contact ?? selectedItem?.do_not_contact) && !autoDncDerived) {
      const current = workflowDraftRef.current
      if (current && !current.do_not_contact) {
        setAutoDncSnapshot({ action: current.action, next_follow_up_date: current.next_follow_up_date, do_not_contact: current.do_not_contact })
        setWorkflowDraft({ ...current, do_not_contact: true, action: 'resolved', next_follow_up_date: null })
        setAutoDncDerived(true)
      }
    } else if (!hasDncReason && autoDncDerived) {
      if (!workflowDncUserTouched && autoDncSnapshot) {
        setWorkflowDraft((current) => current ? { ...current, ...autoDncSnapshot } : current)
      }
      setAutoDncDerived(false)
      setAutoDncSnapshot(null)
    }
  }, [autoDncDerived, autoDncSnapshot, inbox.scope.thread, inbox.thread?.workflow?.do_not_contact, selectedItem, workflowDncUserTouched])
  const handleWorkflowDraftChange = useCallback((workflow: ReplyWorkflowMutation) => {
    const previous = workflowDraftRef.current
    if (previous && previous.do_not_contact !== workflow.do_not_contact) setWorkflowDncUserTouched(true)
    setWorkflowUserDirty(true)
    setWorkflowDraft(workflow)
  }, [])
  const handleWorkflowDirtyChange = useCallback((value: boolean) => { if (value) setWorkflowUserDirty(true) }, [])
  const hasData = inbox.loading || inbox.items.length > 0
  const currentName = selectedItem?.name || UNKNOWN_PERSON_LABEL
  const selectedIsOutboundOnly = hasSelection && !!selectedMessage && selectedMessage.direction !== 'in'
  const ownerOptions = inbox.capabilities?.members?.filter((member) => member.active) ?? []
  const capabilityReady = isReplyManualReady(inbox.capabilities)
  const actionWorkflow = inbox.scope.thread ? (() => {
    const base = inbox.thread?.workflow ?? (selectedItem ? { instance_id: selectedItem.instance_id, profile_url: selectedItem.profile_url, action: selectedItem.action, owner_id: selectedItem.owner_id, next_follow_up_date: selectedItem.next_follow_up_date, do_not_contact: selectedItem.do_not_contact, revision: selectedItem.revision, acknowledged_inbound_revision: selectedItem.acknowledged_inbound_revision, inbound_revision: selectedItem.inbound_revision } : null)
    if (!base) return null
    return workflowDraft ? { ...base, action: workflowDraft.action, owner_id: workflowDraft.owner_id, next_follow_up_date: workflowDraft.next_follow_up_date, do_not_contact: workflowDraft.do_not_contact, revision: workflowDraft.expected_revision } : base
  })() : null
  const accountLabel = (id: string) => {
    const instances = inbox.capabilities?.instances ?? []
    const label = instances.find((item) => item.id === id)?.label || id
    return instances.filter((item) => item.label === label).length > 1 ? `${label} · ${id}` : label
  }
  const ownerLabel = (id: number) => {
    const owner = ownerOptions.find((member) => member.id === id)
    if (!owner) return `Teammate #${id}`
    return ownerOptions.filter((member) => member.name === owner.name).length > 1 ? `${owner.name} · #${id}` : owner.name
  }
  const ownerCount = (id: number | null) => inbox.facets?.owners?.find((facet) => facet.id === id)?.count ?? 0
  const openFilters = () => setFilterDraft(pickFilterDraft(inbox.scope))
  const patchDraft = (patch: Partial<RepliesFilterDraft>) =>
    setFilterDraft((current) => (current ? { ...current, ...patch } : current))
  const applyFilters = () => {
    const draft = filterDraft
    setFilterDraft(null)
    if (draft) guardedScope({ ...draft, cursor: null })
  }
  const activeFilterCount = [
    inbox.scope.campaign, inbox.scope.owner, inbox.scope.sentiment, inbox.scope.reason,
    inbox.scope.action, inbox.scope.scope !== 'new', inbox.scope.my, inbox.scope.unacknowledged,
    inbox.scope.unowned, inbox.scope.overdue,
  ].filter(Boolean).length
  /* While the sheet is open its footer counts the draft, not the applied URL. */
  const draftFilterCount = filterDraft
    ? [
      filterDraft.campaign, filterDraft.owner, filterDraft.sentiment, filterDraft.reason,
      filterDraft.action, filterDraft.scope !== 'new', filterDraft.my,
      filterDraft.unacknowledged, filterDraft.unowned, filterDraft.overdue,
    ].filter(Boolean).length
    : 0
  const scopeLabel = inbox.scope.metric_scope
    ? ({
      business_rate: 'Declines and objections', negative_objection: 'Declines and objections',
      dialogues: 'Conversations with a reply', full_dialogues: 'Conversations with no unreviewed replies',
      unreviewed_dialogues: 'Conversations with unreviewed replies',
      latest_unreviewed: 'Latest reply not reviewed', only_auto: 'Automated replies only',
      unreviewed_intent: 'Buying interest not reviewed', legacy_ai: 'Earlier AI labelling',
      missing_reason: 'No reason recorded', needs_confirmation: 'Needs a next step',
      transfers: 'Handovers (events)',
    } as Record<string, string>)[inbox.scope.metric_scope.value]
      || (inbox.scope.metric_scope.kind === 'workflow' ? WORKFLOW_LABELS[inbox.scope.metric_scope.value] : null)
      || (inbox.scope.metric_scope.kind === 'sentiment' ? SENTIMENT_LABELS[inbox.scope.metric_scope.value as keyof typeof SENTIMENT_LABELS] : null)
      || (inbox.scope.metric_scope.kind === 'reason' ? REASON_LABELS[inbox.scope.metric_scope.value as keyof typeof REASON_LABELS] : null)
      || 'Selected metric'
    : null
  const analyticsBack = '/sentiment-analysis?' + new URLSearchParams(Object.entries({
    from: inbox.scope.from, to: inbox.scope.to, account: inbox.scope.account,
    campaign: inbox.scope.campaign, owner: inbox.scope.owner,
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')).toString()
  const clearMetric = () => guardedScope({ metric_scope: null, from: null, to: null, sentiment: null, reason: null, view: 'unreviewed', scope: 'new' })
  const saveWorkflowOnly = (next: boolean) => {
    if (!workflowDraft || !workflowDirty || !workflowValid) return
    void saveWorkflow(workflowDraft).then(async (result) => {
      if (!result || !next) return
      const target = nextUnreviewedReply(inbox.thread?.messages ?? [], inbox.items, selectedMessage?.id ?? -1, inbox.scope.thread ?? { instance_id: '', profile_url: '' })
      if (target?.kind === 'message') inbox.setScope({ thread: { instance_id: target.value.instance_id, profile_url: target.value.profile_url, focus_message_id: target.value.id } })
      else if (target?.kind === 'thread') navigateWithoutGuard(target.value)
      else if (inbox.nextCursor) { const loaded = await inbox.nextPendingPage(); if (loaded) navigateWithoutGuard(loaded) }
    })
  }
  return <div className="replies-page">
    <NavigationGuard dirty={dirty} onRequest={queueNavigation} />
    {pendingNavigation && <Dialog
      size="sm"
      title={COPY.unsavedChanges}
      description="Save the review and the next step before leaving, or stay in this conversation."
      onRequestClose={() => { pendingNavigation.cancel?.(); setPendingNavigation(null) }}
      closeLabel="Keep editing"
      footer={<>
        <Button variant="secondary" onClick={() => { pendingNavigation.cancel?.(); setPendingNavigation(null) }}>Keep editing</Button>
        <Button variant="danger" onClick={() => { clearDirty(); pendingNavigation.proceed(); setPendingNavigation(null) }}>Discard changes</Button>
        <Button variant="primary" disabled={!workflowValid} loading={actions.saving} onClick={() => {
          if (reviewDirty) (document.getElementById('reply-review-form') as HTMLFormElement | null)?.requestSubmit()
          else saveWorkflowOnly(false)
        }}>{COPY.save}</Button>
      </>}
    >
      <p>Discarding removes only the unsaved draft for this conversation.</p>
    </Dialog>}

    <PageHeader
      title={COPY.replies}
      actions={<div className="replies-head-actions">
        <LinkButton to="/sentiment-analysis" variant="ghost">Sentiment analysis</LinkButton>
        <Button
          variant="secondary"
          icon={<RefreshCw size={18} aria-hidden="true" />}
          onClick={() => confirmNavigation(inbox.refresh)}
          loading={inbox.loading}
          loadingLabel="Refreshing replies"
        >{COPY.refresh}</Button>
      </div>}
    />

    {inbox.capabilities && !capabilityReady && <div className="replies-unavailable" role="status"><AlertCircle size={18} aria-hidden="true" /> {capabilityMessage(inbox.capabilities)}</div>}

    <div className="replies-toolbar">
      <Tabs
        className="replies-views"
        label="Reply queue"
        value={inbox.scope.view}
        onChange={(view) => guardedScope({ view, cursor: null })}
        items={VIEWS.map((view) => ({ id: view, label: VIEW_LABELS[view] }))}
      />
      <div className="replies-toolbar-tools">
        <SelectField
          label="Account"
          labelHidden
          value={inbox.scope.account ?? ''}
          onChange={(event) => guardedScope({ account: event.target.value || null, campaign: null, cursor: null })}
        >
          <option value="">All accounts</option>
          {inbox.capabilities?.instances?.map((item) => <option key={item.id} value={item.id}>{accountLabel(item.id)}</option>)}
        </SelectField>
        <Button
          variant="secondary"
          icon={<Filter size={18} aria-hidden="true" />}
          aria-expanded={filtersOpen}
          onClick={openFilters}
        >{COPY.filters}<FilterCount count={activeFilterCount} /></Button>
      </div>
    </div>

    {/* Filters open OVER the page. Nothing below them moves, so the workspace
        keeps its full height whether they are open or closed. */}
    {filterDraft && <Dialog
      title={COPY.filters}
      description="Applies to the conversation list when you apply them. The account selector stays on the page."
      onRequestClose={() => setFilterDraft(null)}
      footerNote={draftFilterCount ? `${draftFilterCount} filter${draftFilterCount === 1 ? '' : 's'} selected` : 'No filters selected'}
      footer={<>
        <Button variant="ghost" onClick={() => setFilterDraft(EMPTY_FILTER_DRAFT)}>{COPY.clearAll}</Button>
        <Button variant="secondary" onClick={() => setFilterDraft(null)}>{COPY.cancel}</Button>
        <Button variant="primary" onClick={applyFilters}>{COPY.apply}</Button>
      </>}
    >
      <div className="replies-filter-grid">
        <SelectField label="Arrived" value={filterDraft.scope} onChange={(event) => patchDraft({ scope: event.target.value as ReplyInboxScope['scope'] })}>
          <option value="new">Since manual review started</option>
          <option value="historical">Before manual review started</option>
          <option value="all">All time</option>
        </SelectField>
        <SelectField label="Campaign" value={filterDraft.campaign ?? ''} onChange={(event) => patchDraft({ campaign: event.target.value || null })}>
          <option value="">All campaigns</option>
          {inbox.capabilities?.campaigns?.filter((item) => !inbox.scope.account || item.instance_id === inbox.scope.account).map((item) => <option key={item.id} value={item.id}>{item.name} · {accountLabel(item.instance_id)}</option>)}
        </SelectField>
        <SelectField
          label={COPY.conversationOwner}
          help={inbox.facets ? 'Counts are for the current result set.' : undefined}
          value={filterDraft.unowned ? 'unassigned' : filterDraft.owner ?? ''}
          onChange={(event) => patchDraft({ owner: event.target.value === 'unassigned' ? null : event.target.value || null, unowned: event.target.value === 'unassigned' })}
        >
          <option value="">All owners</option>
          <option value="unassigned">Unassigned{inbox.facets ? ` · ${ownerCount(null)}` : ''}</option>
          {ownerOptions.map((owner) => <option key={owner.id} value={String(owner.id)}>{ownerLabel(owner.id)}{inbox.facets ? ` · ${ownerCount(owner.id)}` : ''}</option>)}
        </SelectField>
        <SelectField label={COPY.sentiment} value={filterDraft.sentiment ?? ''} onChange={(event) => patchDraft({ sentiment: (event.target.value || null) as ReplyInboxScope['sentiment'] })}>
          <option value="">All sentiments</option>
          {Object.entries(SENTIMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SelectField>
        <SelectField label={COPY.reasons} value={filterDraft.reason ?? ''} onChange={(event) => patchDraft({ reason: (event.target.value || null) as ReplyInboxScope['reason'] })}>
          <option value="">All reasons</option>
          {Object.entries(REASON_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SelectField>
        <SelectField label={COPY.nextStep} value={filterDraft.action ?? ''} onChange={(event) => patchDraft({ action: (event.target.value || null) as ReplyInboxScope['action'] })}>
          <option value="">All next steps</option>
          {Object.entries(ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SelectField>
      </div>
      <div className="replies-filter-toggles">
        {([['my', 'Assigned to me'], ['unacknowledged', 'Needs a next step'], ['unowned', 'Unassigned'], ['overdue', 'Follow-up overdue']] as const).map(([key, label]) => (
          <Checkbox key={key} label={label} checked={filterDraft[key]} onChange={(event) => patchDraft({ [key]: event.target.checked })} />
        ))}
      </div>
    </Dialog>}

    {scopeLabel && <div className="replies-drill-banner" role="status">
      <span>From analytics · {inbox.scope.from ?? 'start'} — {inbox.scope.to ?? 'today'} · {scopeLabel}</span>
      <Link to={analyticsBack}>Back to the report</Link>
      <IconButton label="Clear the analytics filter" icon={<X size={20} aria-hidden="true" />} onClick={clearMetric} />
    </div>}

    {inbox.stale && <div className="replies-stale" role="status">
      <span>Showing the last data that loaded.</span>
      <Button variant="ghost" size="sm" onClick={inbox.refresh}>{COPY.retry}</Button>
    </div>}

    {capabilityReady ? <div className={'replies-workspace' + (mobileStep === 'review' ? ' pane-review' : '') + (hasSelection ? ' has-selection' : '')}>
      <aside className="replies-list-pane" aria-label="Conversations">
        <div className="replies-pane-title">
          <div>
            <h2>{inbox.scope.view === 'unreviewed' ? 'Review queue' : 'Conversations'}</h2>
            <span className="muted small">{inbox.nextCursor ? `${inbox.items.length} loaded · more available` : `${inbox.items.length} conversation${inbox.items.length === 1 ? '' : 's'}`}</span>
          </div>
        </div>
        <label className="replies-search">
          <Search size={18} aria-hidden="true" />
          <input type="search" value={search} maxLength={200} placeholder="Search conversations" aria-label="Search conversations" onChange={(event) => setSearch(event.target.value)} />
          <IconButton label="Clear the search" icon={<X size={18} aria-hidden="true" />} onClick={() => { setSearch(''); guardedScope({ query: '', cursor: null }) }} />
        </label>
        {inbox.loading && !inbox.items.length ? <div className="replies-loading" role="status" aria-busy="true">Loading replies…</div>
          : inbox.error && !hasData ? <div className="replies-error" role="alert"><AlertCircle size={20} aria-hidden="true" />{inbox.error}<Button variant="secondary" size="sm" onClick={inbox.refresh}>{COPY.retry}</Button></div>
            : !inbox.items.length ? <EmptyState icon={Inbox} title={scopeLabel ? 'No conversations match this report period' : 'Nothing to review'} hint={scopeLabel ? 'Check the period and the conditions of the report.' : 'Try another queue or a wider arrival period.'} />
              : <div className="replies-list">{inbox.items.map((item) => {
                const selected = inbox.scope.thread?.instance_id === item.instance_id && inbox.scope.thread.profile_url === item.profile_url
                const name = item.name || UNKNOWN_PERSON_LABEL
                return <button type="button" key={item.instance_id + '|' + item.profile_url} className={'replies-list-item' + (selected ? ' selected' : '')} onClick={() => guardedSelect(item)}>
                  <span className="replies-list-identity"><InitialsAvatar name={name} size={36} /><span className="replies-list-identity-text"><span className="replies-list-item-top"><strong>{name}</strong><time dateTime={item.latest_sent_at ?? undefined} title={REPLY_TIME_ZONE_LABEL}>{formatTime(item.latest_sent_at)}</time></span><span className="muted small ellipsis">{item.company || item.headline || profileName(item.profile_url)}</span></span></span>
                  <span className="replies-list-snippet">{item.latest_direction === 'in' ? 'Reply: ' : 'Sent: '}{item.latest_snippet || 'No text'}</span>
                  <span className="replies-list-item-bottom"><span>{accountLabel(item.instance_id)}</span><span>{item.owner_id ? ownerLabel(item.owner_id) : null}{item.action ? ' · ' + ACTION_LABELS[item.action] : ''}</span>{item.pending_count > 0 && <b>{item.pending_count}</b>}</span>
                </button>
              })}</div>}
        {inbox.nextCursor && <button className="replies-load-more" type="button" onClick={inbox.loadMore} disabled={inbox.loadingMore}>{inbox.loadingMore ? COPY.loading : 'Load more'}</button>}
      </aside>

      <main className="replies-thread-pane">
        {hasSelection ? <>
          <div className="replies-thread-head">
            <div>
              <h2>{currentName}</h2>
              <p className="muted small">{selectedItem?.company || selectedItem?.headline || profileName(inbox.scope.thread?.profile_url ?? '')} · {accountLabel(inbox.scope.thread?.instance_id ?? '')}</p>
            </div>
            <div className="replies-thread-links">
              {newInboundAvailable && <Button variant="secondary" size="sm" onClick={() => { if (inbox.thread?.newer_cursor) inbox.loadNewer(); else if (latestInbound) confirmNavigation(() => { updateScope({ thread: { instance_id: latestInbound.instance_id, profile_url: latestInbound.profile_url, focus_message_id: latestInbound.id } }); setNewInboundAvailable(false) }) }}>New reply · show it</Button>}
              {selectedLead && <Button variant="ghost" size="sm" onClick={() => confirmNavigation(() => openConversation(selectedLead, { mode: 'import_history' }))}>Import history</Button>}
              <ExternalLinkButton variant="ghost" size="sm" href={inbox.scope.thread?.profile_url} target="_blank" rel="noreferrer">LinkedIn ↗</ExternalLinkButton>
            </div>
          </div>
          <ConversationThread messages={inbox.thread?.messages ?? []} selectedMessageId={selectedMessage?.id ?? null} focusMessageId={inbox.scope.thread?.focus_message_id} loading={inbox.loadingThread} error={inbox.threadError} olderCursor={inbox.thread?.older_cursor} newerCursor={inbox.thread?.newer_cursor} inboundName={currentName} outboundName={accountLabel(inbox.scope.thread?.instance_id ?? '')} onSelectMessage={(message) => confirmNavigation(() => updateScope({ thread: { instance_id: message.instance_id, profile_url: message.profile_url, focus_message_id: message.id } }))} onLoadOlder={inbox.loadOlder} onLoadNewer={inbox.loadNewer} />
          <div className="replies-pane-switch">
            <Button variant="ghost" block onClick={() => setMobileStep(mobileStep === 'review' ? 'thread' : 'review')}>
              {mobileStep === 'review' ? '← Back to conversations' : `${COPY.reviewReply} and ${COPY.nextStep.toLowerCase()} →`}
            </Button>
          </div>
        </> : <div className="replies-select-empty">
          <Inbox size={32} aria-hidden="true" />
          <h2>Select a conversation</h2>
          <p className="muted">The thread and its next step open here.</p>
        </div>}
      </main>

      <aside className="replies-inspector-pane" aria-label="Review reply and next step">
        {hasSelection ? <>
          <div className="replies-inspector-scroll">
            {selectedMessage?.direction === 'in' ? <ReplyReviewPanel message={selectedMessage} review={selectedMessage.review} saving={actions.saving} error={actions.error ?? (actions.conflict ? 'This conversation changed in another tab. Your input is kept — reload the conversation once you have compared them.' : null)} history={inbox.history} historyLoading={inbox.historyLoading} historyCursor={inbox.historyCursor} historyRequested={inbox.historyRequested} onOpenHistory={inbox.requestHistory} onLoadHistoryMore={inbox.loadHistoryMore} onDirtyChange={setReviewDirty} onDraftChange={handleReviewDraftChange} onSave={saveReview} onSaveAndNext={saveReviewAndNext} externalActions />
              : <div className="replies-inspector-empty">{selectedIsOutboundOnly ? <>An outbound message is selected. {inbox.thread?.messages.some((message) => message.direction === 'in') ? <Button variant="ghost" size="sm" onClick={() => { const inbound = [...(inbox.thread?.messages ?? [])].reverse().find((message) => message.direction === 'in'); if (inbound) updateScope({ thread: { instance_id: inbound.instance_id, profile_url: inbound.profile_url, focus_message_id: inbound.id } }) }}>Go to the latest inbound reply</Button> : 'There are no inbound messages in the loaded part of this thread.'}</> : inbox.loadingThread ? 'Loading the reply…' : 'Select an inbound reply in the thread.'}</div>}
            <ConversationActionPanel workflow={actionWorkflow} members={inbox.capabilities?.members} inboundRevision={inbox.thread?.inbound_revision ?? selectedItem?.inbound_revision ?? 0} persistedDoNotContact={inbox.thread?.workflow?.do_not_contact ?? selectedItem?.do_not_contact ?? false} saving={actions.saving} error={actions.error} onDirtyChange={handleWorkflowDirtyChange} onDraftChange={handleWorkflowDraftChange} onSave={saveWorkflow} onValidityChange={setWorkflowValid} externalActions />
          </div>
          <div className="replies-inspector-footer">
            <span role="status">{actions.saving ? COPY.saving : actions.error || actions.conflict ? COPY.saveFailed : dirty ? COPY.unsavedChanges : selectedMessage?.review?.complete ? actionWorkflow?.action ? COPY.saved : 'Review saved · no next step chosen yet' : COPY.noChanges}</span>
            <div>
              {reviewDirty
                ? <>
                  <Button variant="secondary" type="submit" form="reply-review-form" disabled={!workflowValid} loading={actions.saving}>{COPY.save}</Button>
                  <Button variant="primary" type="submit" form="reply-review-form" data-next="true" disabled={!workflowValid} loading={actions.saving}>{COPY.saveAndNext}</Button>
                </>
                : <>
                  <Button variant="secondary" disabled={!workflowDirty || !workflowValid} loading={actions.saving} onClick={() => saveWorkflowOnly(false)}>{COPY.save}</Button>
                  <Button variant="primary" disabled={!workflowDirty || !workflowValid} loading={actions.saving} onClick={() => saveWorkflowOnly(true)}>{COPY.saveAndNext}</Button>
                </>}
            </div>
          </div>
        </> : <div className="replies-inspector-empty">Select a conversation to review its reply.</div>}
      </aside>
    </div> : inbox.capabilities ? <div className="replies-inactive-empty" role="status">
      <Inbox size={32} aria-hidden="true" />
      <h2>Replies is not available yet</h2>
      <p className="muted">{capabilityMessage(inbox.capabilities)}</p>
    </div> : <div className="replies-loading" role="status" aria-busy="true">Opening replies…</div>}
  </div>
}
