import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, Filter, Inbox, RefreshCw, Search, X } from 'lucide-react'
import { Link, UNSAFE_DataRouterContext, useBlocker, useLocation } from 'react-router-dom'
import { InitialsAvatar } from '../components/Avatar'
import { useData } from '../lib/DataContext'
import { useConversation } from '../lib/ConversationContext'
import { replyTime, REPLY_TIME_ZONE_LABEL } from '../lib/replyTime'
import { ConversationActionPanel } from '../components/conversation/ConversationActionPanel'
import { ConversationThread } from '../components/conversation/ConversationThread'
import { ReplyReviewPanel } from '../components/conversation/ReplyReviewPanel'
import { EmptyState } from '../components/EmptyState'
import { useReplyReviewActions } from '../lib/useReplyReviewActions'
import { useRepliesInbox } from '../lib/useRepliesInbox'
import { ACTION_LABELS, isReplyManualReady, REASON_LABELS, SENTIMENT_LABELS, nextUnreviewedReply, REPLY_SEARCH_DEBOUNCE_MS, type ReplyCapabilities, type ReplyInboxScope, type ReplyReadClient, type ReplyReviewDraft, type ReplyThreadMessage, type ReplyWorkflowMutation } from '../lib/replyReview'
import './replies-inbox.css'

const VIEWS: ReplyInboxScope['view'][] = ['all', 'unreviewed', 'needs_reply', 'deferred', 'completed']
const VIEW_LABELS: Record<ReplyInboxScope['view'], string> = { all: 'Все', unreviewed: 'Не разобраны', needs_reply: 'Нужен ответ', deferred: 'Отложены', completed: 'Завершены' }
function formatTime(value: string | null): string { return value ? replyTime(value, true) : '—' }
function profileName(profile: string): string { return profile.split('/').filter(Boolean).pop() || profile }
function capabilityMessage(capabilities: ReplyCapabilities | null): string {
  if (!capabilities) return 'Проверяем доступность ручной разметки…'
  if (capabilities.activation_in_progress) {
    const progress = capabilities.activation_total ? ` (${capabilities.activation_processed ?? 0}/${capabilities.activation_total})` : ''
    return `Ручная разметка активируется${progress}. Replies Inbox станет доступен после завершения перехода.`
  }
  if (capabilities.mode === 'prepared' || capabilities.manual_ready === false || capabilities.active === false) return 'Ручная разметка подготовлена, но ещё не активирована для этого tenant.'
  return capabilities.unavailable_reason || 'Replies Inbox недоступен для текущей схемы tenant.'
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

export function Replies({ client }: { client?: ReplyReadClient } = {}) {
  const { data } = useData()
  const { openConversation } = useConversation()
  const inbox = useRepliesInbox(client)
  const [search, setSearch] = useState(inbox.scope.query)
  const [filtersOpen, setFiltersOpen] = useState(false)
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
  const currentName = selectedItem?.name || 'Контакт LinkedIn'
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
    if (!owner) return `Участник #${id}`
    return ownerOptions.filter((member) => member.name === owner.name).length > 1 ? `${owner.name} · #${id}` : owner.name
  }
  const ownerCount = (id: number | null) => inbox.facets?.owners?.find((facet) => facet.id === id)?.count ?? 0
  const activeFilterCount = [
    inbox.scope.campaign, inbox.scope.owner, inbox.scope.sentiment, inbox.scope.reason,
    inbox.scope.action, inbox.scope.scope !== 'new', inbox.scope.my, inbox.scope.unacknowledged,
    inbox.scope.unowned, inbox.scope.overdue,
  ].filter(Boolean).length
  const scopeLabel = inbox.scope.metric_scope
    ? ({ business_rate: 'Отказы и возражения', negative_objection: 'Отказы и возражения', unreviewed_dialogues: 'Диалоги с неразобранными ответами' } as Record<string, string>)[inbox.scope.metric_scope.value]
      || (inbox.scope.metric_scope.kind === 'sentiment' ? SENTIMENT_LABELS[inbox.scope.metric_scope.value as keyof typeof SENTIMENT_LABELS] : null)
      || (inbox.scope.metric_scope.kind === 'reason' ? REASON_LABELS[inbox.scope.metric_scope.value as keyof typeof REASON_LABELS] : null)
      || 'Выбранный показатель'
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
    {pendingNavigation && <div className="replies-dialog-backdrop"><div className="replies-dialog" role="dialog" aria-modal="true" aria-labelledby="replies-unsaved-title">
      <h2 id="replies-unsaved-title">Есть несохранённые изменения</h2>
      <p>Сохраните разметку и следующий шаг перед переходом или останьтесь в диалоге.</p>
      <div className="replies-dialog-actions">
        <button className="secondary" type="button" onClick={() => { pendingNavigation.cancel?.(); setPendingNavigation(null) }}>Вернуться</button>
        <button className="secondary" type="button" onClick={() => { clearDirty(); pendingNavigation.proceed(); setPendingNavigation(null) }}>Не сохранять</button>
        <button className="primary" type="button" disabled={!workflowValid || actions.saving} onClick={() => {
          if (reviewDirty) (document.getElementById('reply-review-form') as HTMLFormElement | null)?.requestSubmit()
          else saveWorkflowOnly(false)
        }}>Сохранить</button>
      </div>
    </div></div>}
    <header className="replies-page-head">
      <h1>Replies</h1>
      <div className="replies-head-actions">
        <Link className="secondary replies-head-link" to="/sentiment-analysis">Аналитика</Link>
        <button className="secondary" type="button" onClick={() => confirmNavigation(inbox.refresh)} disabled={inbox.loading} aria-label="Обновить ответы"><RefreshCw size={16} /> <span>Обновить</span></button>
      </div>
    </header>
    {inbox.capabilities && !capabilityReady && <div className="replies-unavailable" role="status"><AlertCircle size={18} /> {capabilityMessage(inbox.capabilities)}</div>}
    <div className="replies-toolbar">
      <div className="replies-views" role="tablist" aria-label="Очередь">
        {VIEWS.map((view) => <button type="button" role="tab" aria-selected={inbox.scope.view === view} key={view} className={inbox.scope.view === view ? 'active' : ''} onClick={() => guardedScope({ view, cursor: null })}>{VIEW_LABELS[view]}</button>)}
      </div>
      <div className="replies-toolbar-tools">
        <label className="sr-only" htmlFor="replies-account">Аккаунт</label>
        <select id="replies-account" value={inbox.scope.account ?? ''} onChange={(event) => guardedScope({ account: event.target.value || null, campaign: null, cursor: null })}><option value="">Все аккаунты</option>{inbox.capabilities?.instances?.map((item) => <option key={item.id} value={item.id}>{accountLabel(item.id)}</option>)}</select>
        <button className="secondary" type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((value) => !value)}><Filter size={15} /> Фильтры {activeFilterCount || ''}</button>
      </div>
    </div>
    {filtersOpen && <div className="replies-filter-panel">
      <label>Период поступления<select value={inbox.scope.scope} onChange={(event) => guardedScope({ scope: event.target.value as ReplyInboxScope['scope'], cursor: null })}><option value="new">После запуска ручного разбора</option><option value="historical">До запуска</option><option value="all">За всё время</option></select></label>
      <label>Кампания<select value={inbox.scope.campaign ?? ''} onChange={(event) => guardedScope({ campaign: event.target.value || null, cursor: null })}><option value="">Все кампании</option>{inbox.capabilities?.campaigns?.filter((item) => !inbox.scope.account || item.instance_id === inbox.scope.account).map((item) => <option key={item.id} value={item.id}>{item.name} · {accountLabel(item.instance_id)}</option>)}</select></label>
      <label>Ответственный<select value={inbox.scope.unowned ? 'unassigned' : inbox.scope.owner ?? ''} onChange={(event) => guardedScope({ owner: event.target.value === 'unassigned' ? null : event.target.value || null, unowned: event.target.value === 'unassigned', cursor: null })}><option value="">Все ответственные</option><option value="unassigned">Без ответственного{inbox.facets ? ` · ${ownerCount(null)}` : ''}</option>{ownerOptions.map((owner) => <option key={owner.id} value={String(owner.id)}>{ownerLabel(owner.id)}{inbox.facets ? ` · ${ownerCount(owner.id)}` : ''}</option>)}</select>{inbox.facets && <span className="replies-facet-caption">Количество в текущем наборе</span>}</label>
      <label>Тип ответа<select value={inbox.scope.sentiment ?? ''} onChange={(event) => guardedScope({ sentiment: (event.target.value || null) as ReplyInboxScope['sentiment'], cursor: null })}><option value="">Все типы ответа</option>{Object.entries(SENTIMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Причина<select value={inbox.scope.reason ?? ''} onChange={(event) => guardedScope({ reason: (event.target.value || null) as ReplyInboxScope['reason'], cursor: null })}><option value="">Все причины</option>{Object.entries(REASON_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Следующий шаг<select value={inbox.scope.action ?? ''} onChange={(event) => guardedScope({ action: (event.target.value || null) as ReplyInboxScope['action'], cursor: null })}><option value="">Все действия</option>{Object.entries(ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {([['my', 'Мои'], ['unacknowledged', 'Нужен шаг'], ['unowned', 'Без ответственного'], ['overdue', 'Просрочены']] as const).map(([key, label]) => <label key={key} className="replies-toggle"><input type="checkbox" checked={inbox.scope[key]} onChange={(event) => guardedScope({ [key]: event.target.checked, cursor: null })} /> {label}</label>)}
      <button type="button" className="replies-reset" onClick={() => guardedScope({ campaign: null, owner: null, sentiment: null, reason: null, action: null, my: false, unacknowledged: false, unowned: false, overdue: false, scope: 'new', cursor: null })}>Сбросить фильтры</button>
    </div>}
    {scopeLabel && <div className="replies-drill-banner" role="status"><span>Из аналитики · {inbox.scope.from ?? 'начало'} — {inbox.scope.to ?? 'сегодня'} · {scopeLabel}</span><Link to={analyticsBack}>Вернуться к отчёту</Link><button type="button" onClick={clearMetric} aria-label="Очистить фильтр аналитики"><X size={16} /></button></div>}
    {inbox.stale && <div className="replies-stale" role="status">Показаны последние загруженные данные. <button type="button" onClick={inbox.refresh}>Повторить</button></div>}
    {capabilityReady ? <div className={'replies-workspace mobile-' + mobileStep + (hasSelection ? ' has-selection' : '')}>
      <aside className="replies-list-pane" aria-label="Список диалогов">
        <div className="replies-pane-title"><div><h2>{inbox.scope.view === 'unreviewed' ? 'Очередь разбора' : 'Диалоги'}</h2><span className="muted small">{inbox.nextCursor ? 'Загружено ' + inbox.items.length + ', есть ещё' : inbox.items.length + ' диалогов'}</span></div></div>
        <label className="replies-search"><Search size={15} aria-hidden="true" /><input type="search" value={search} maxLength={200} placeholder="Поиск по диалогам" aria-label="Поиск по диалогам" onChange={(event) => setSearch(event.target.value)} /><button type="button" aria-label="Очистить поиск" onClick={() => { setSearch(''); guardedScope({ query: '', cursor: null }) }}><X size={14} /></button></label>
        {inbox.loading && !inbox.items.length ? <div className="replies-loading">Загружаем ответы…</div> : inbox.error && !hasData ? <div className="replies-error"><AlertCircle size={18} />{inbox.error}<button type="button" onClick={inbox.refresh}>Повторить</button></div> : !inbox.items.length ? <EmptyState icon={Inbox} title={scopeLabel ? 'В этом периоде нет подходящих диалогов' : 'Нет ответов для разбора'} hint={scopeLabel ? 'Проверьте период и условия отчёта.' : 'Попробуйте другую очередь или период поступления.'} /> : <div className="replies-list">{inbox.items.map((item) => {
          const selected = inbox.scope.thread?.instance_id === item.instance_id && inbox.scope.thread.profile_url === item.profile_url
          const name = item.name || 'Контакт LinkedIn'
          return <button type="button" key={item.instance_id + '|' + item.profile_url} className={'replies-list-item' + (selected ? ' selected' : '')} onClick={() => guardedSelect(item)}>
            <span className="replies-list-identity"><InitialsAvatar name={name} size={32} /><span className="replies-list-identity-text"><span className="replies-list-item-top"><strong>{name}</strong><time dateTime={item.latest_sent_at ?? undefined} title={REPLY_TIME_ZONE_LABEL}>{formatTime(item.latest_sent_at)}</time></span><span className="muted small ellipsis">{item.company || item.headline || profileName(item.profile_url)}</span></span></span>
            <span className="replies-list-snippet">{item.latest_direction === 'in' ? 'Ответ: ' : 'Отправлено: '}{item.latest_snippet || 'Нет текста'}</span>
            <span className="replies-list-item-bottom"><span>{accountLabel(item.instance_id)}</span><span>{item.owner_id ? ownerLabel(item.owner_id) : null}{item.action ? ' · ' + ACTION_LABELS[item.action] : ''}</span>{item.pending_count > 0 && <b>{item.pending_count}</b>}</span>
          </button>
        })}</div>}
        {inbox.nextCursor && <button className="replies-load-more" type="button" onClick={inbox.loadMore} disabled={inbox.loadingMore}>{inbox.loadingMore ? 'Загружаем…' : 'Загрузить ещё'}</button>}
      </aside>
      <main className="replies-thread-pane">
        {hasSelection && <button className="replies-mobile-back" type="button" onClick={() => guardedSelect(null)}><ArrowLeft size={16} /> К списку</button>}
        {hasSelection ? <>
          <div className="replies-thread-head"><div><h2>{currentName}</h2><p className="muted small">{selectedItem?.company || selectedItem?.headline || profileName(inbox.scope.thread?.profile_url ?? '')} · {accountLabel(inbox.scope.thread?.instance_id ?? '')}</p></div><div className="replies-thread-links">{newInboundAvailable && <button type="button" className="replies-new-inbound" onClick={() => { if (inbox.thread?.newer_cursor) inbox.loadNewer(); else if (latestInbound) confirmNavigation(() => { updateScope({ thread: { instance_id: latestInbound.instance_id, profile_url: latestInbound.profile_url, focus_message_id: latestInbound.id } }); setNewInboundAvailable(false) }) }}>Есть новый ответ · Показать</button>}{selectedLead && <button type="button" onClick={() => confirmNavigation(() => openConversation(selectedLead, { mode: 'import_history' }))}>Импорт истории</button>}<a href={inbox.scope.thread?.profile_url} target="_blank" rel="noreferrer">LinkedIn ↗</a></div></div>
          <ConversationThread messages={inbox.thread?.messages ?? []} selectedMessageId={selectedMessage?.id ?? null} focusMessageId={inbox.scope.thread?.focus_message_id} loading={inbox.loadingThread} error={inbox.threadError} olderCursor={inbox.thread?.older_cursor} newerCursor={inbox.thread?.newer_cursor} inboundName={currentName} outboundName={accountLabel(inbox.scope.thread?.instance_id ?? '')} onSelectMessage={(message) => confirmNavigation(() => updateScope({ thread: { instance_id: message.instance_id, profile_url: message.profile_url, focus_message_id: message.id } }))} onLoadOlder={inbox.loadOlder} onLoadNewer={inbox.loadNewer} />
          <button type="button" className="replies-mobile-next" onClick={() => setMobileStep('review')}>К разбору и следующему шагу →</button>
        </> : <div className="replies-select-empty"><Inbox size={30} /><h2>Выберите диалог</h2><p className="muted">Переписка и следующий шаг откроются здесь.</p></div>}
      </main>
      <aside className="replies-inspector-pane" aria-label="Разбор ответа и следующий шаг">
        <button className="replies-review-back" type="button" onClick={() => setMobileStep('thread')}><ArrowLeft size={16} /> К переписке</button>
        {hasSelection ? <>
          <div className="replies-inspector-scroll">
            {selectedMessage?.direction === 'in' ? <ReplyReviewPanel message={selectedMessage} review={selectedMessage.review} saving={actions.saving} error={actions.error ?? (actions.conflict ? 'Данные изменились в другой вкладке. Ваш ввод сохранён. Обновите диалог после сверки.' : null)} history={inbox.history} historyLoading={inbox.historyLoading} historyCursor={inbox.historyCursor} onLoadHistoryMore={inbox.loadHistoryMore} onDirtyChange={setReviewDirty} onDraftChange={handleReviewDraftChange} onSave={saveReview} onSaveAndNext={saveReviewAndNext} externalActions />
              : <div className="replies-inspector-empty">{selectedIsOutboundOnly ? <>Выбрано исходящее сообщение. {inbox.thread?.messages.some((message) => message.direction === 'in') ? <button type="button" onClick={() => { const inbound = [...(inbox.thread?.messages ?? [])].reverse().find((message) => message.direction === 'in'); if (inbound) updateScope({ thread: { instance_id: inbound.instance_id, profile_url: inbound.profile_url, focus_message_id: inbound.id } }) }}>К последнему входящему</button> : 'В загруженной части переписки входящих нет.'}</> : inbox.loadingThread ? 'Загружаем ответ…' : 'Выберите входящий ответ в переписке.'}</div>}
            <ConversationActionPanel workflow={actionWorkflow} members={inbox.capabilities?.members} inboundRevision={inbox.thread?.inbound_revision ?? selectedItem?.inbound_revision ?? 0} persistedDoNotContact={inbox.thread?.workflow?.do_not_contact ?? selectedItem?.do_not_contact ?? false} saving={actions.saving} error={actions.error} onDirtyChange={handleWorkflowDirtyChange} onDraftChange={handleWorkflowDraftChange} onSave={saveWorkflow} onValidityChange={setWorkflowValid} externalActions />
          </div>
          <div className="replies-inspector-footer">
            <span role="status">{actions.saving ? 'Сохраняем…' : actions.error || actions.conflict ? 'Ошибка сохранения' : dirty ? 'Есть изменения' : selectedMessage?.review?.complete ? actionWorkflow?.action ? 'Сохранено' : 'Разметка сохранена · следующий шаг ещё не выбран' : 'Нет изменений'}</span>
            <div>
              {reviewDirty ? <><button className="secondary" type="submit" form="reply-review-form" disabled={actions.saving || !workflowValid}>Сохранить</button><button className="primary" type="submit" form="reply-review-form" data-next="true" disabled={actions.saving || !workflowValid}>Сохранить и следующий</button></>
                : <><button className="secondary" type="button" disabled={!workflowDirty || actions.saving || !workflowValid} onClick={() => saveWorkflowOnly(false)}>Сохранить</button><button className="primary" type="button" disabled={!workflowDirty || actions.saving || !workflowValid} onClick={() => saveWorkflowOnly(true)}>Сохранить и следующий</button></>}
            </div>
          </div>
        </> : <div className="replies-inspector-empty">Выберите диалог, чтобы разобрать ответ.</div>}
      </aside>
    </div> : inbox.capabilities ? <div className="replies-inactive-empty" role="status"><Inbox size={30} /><h2>Replies Inbox временно недоступен</h2><p className="muted">{capabilityMessage(inbox.capabilities)}</p></div> : <div className="replies-loading" role="status" aria-busy="true">Открываем ответы…</div>}
  </div>
}
