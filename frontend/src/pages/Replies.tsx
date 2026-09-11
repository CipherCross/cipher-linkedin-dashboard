import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, Inbox, RefreshCw, Search, X } from 'lucide-react'
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom'
import { ConversationActionPanel } from '../components/conversation/ConversationActionPanel'
import { ConversationThread } from '../components/conversation/ConversationThread'
import { ReplyReviewPanel } from '../components/conversation/ReplyReviewPanel'
import { EmptyState } from '../components/EmptyState'
import { useReplyReviewActions } from '../lib/useReplyReviewActions'
import { useRepliesInbox } from '../lib/useRepliesInbox'
import { ACTION_LABELS, isReplyManualReady, REASON_LABELS, SENTIMENT_LABELS, nextUnreviewedReply, REPLY_SEARCH_DEBOUNCE_MS, type ReplyCapabilities, type ReplyInboxScope, type ReplyReviewDraft, type ReplyThreadMessage, type ReplyWorkflowMutation } from '../lib/replyReview'
import './replies-inbox.css'

const VIEWS: ReplyInboxScope['view'][] = ['all', 'unreviewed', 'needs_reply', 'deferred', 'completed']
const VIEW_LABELS: Record<ReplyInboxScope['view'], string> = { all: 'Все', unreviewed: 'Не разобраны', needs_reply: 'Нужен ответ', deferred: 'Отложены', completed: 'Завершены' }
function formatTime(value: string | null): string { return value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—' }
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

const UNSAVED_MESSAGE = 'Есть несохранённые изменения. Нажмите OK, чтобы отбросить их, или Cancel, чтобы остаться.'

function DataRouterNavigationGuard({ dirty, onDiscard }: { dirty: boolean; onDiscard: () => void }) {
  const blocker = useBlocker(dirty)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm(UNSAVED_MESSAGE)) { onDiscard(); blocker.proceed() }
    else blocker.reset()
  }, [blocker, onDiscard])
  return null
}

function LegacyNavigationGuard({ dirty, onDiscard }: { dirty: boolean; onDiscard: () => void }) {
  const dirtyRef = useRef(dirty)
  const restoringHistory = useRef(false)
  const historyIndex = useRef<number | null>(typeof window === 'undefined' ? null : (window.history.state?.idx ?? null))
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => {
    const onPopState = () => {
      if (restoringHistory.current) { restoringHistory.current = false; return }
      const targetIndex = window.history.state?.idx ?? null
      const previousIndex = historyIndex.current
      historyIndex.current = targetIndex
      if (!dirtyRef.current) return
      if (window.confirm(UNSAVED_MESSAGE)) { dirtyRef.current = false; onDiscard(); return }
      // HashRouter's history entries carry an index. Restore either Back or
      // Forward correctly instead of assuming every pop was a Back action.
      if (previousIndex != null && targetIndex != null && previousIndex !== targetIndex) {
        restoringHistory.current = true
        historyIndex.current = previousIndex
        window.history.go(previousIndex - targetIndex)
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [onDiscard])
  return null
}

function NavigationGuard({ dirty, onDiscard }: { dirty: boolean; onDiscard: () => void }) {
  const dataRouter = useContext(UNSAFE_DataRouterContext)
  return dataRouter ? <DataRouterNavigationGuard dirty={dirty} onDiscard={onDiscard} /> : <LegacyNavigationGuard dirty={dirty} onDiscard={onDiscard} />
}

export function Replies() {
  const inbox = useRepliesInbox()
  const [search, setSearch] = useState(inbox.scope.query)
  const [mobileStep, setMobileStep] = useState<'list' | 'thread' | 'review'>('list')
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
  const selectedItem = useMemo(() => inbox.scope.thread ? inbox.items.find((item) => item.instance_id === inbox.scope.thread?.instance_id && item.profile_url === inbox.scope.thread?.profile_url) ?? null : null, [inbox.items, inbox.scope.thread])
  const hasSelection = inbox.scope.thread !== null
  const selectedMessage = useMemo<ReplyThreadMessage | null>(() => {
    if (!inbox.thread?.messages.length) return null
    const focus = inbox.scope.thread?.focus_message_id
    return inbox.thread.messages.find((message) => message.id === focus) ?? [...inbox.thread.messages].reverse().find((message) => message.direction === 'in') ?? inbox.thread.messages[inbox.thread.messages.length - 1]
  }, [inbox.scope.thread, inbox.thread])
  const actionRefresh = useCallback(() => { setReviewDirty(false); setWorkflowUserDirty(false); setAutoDncDerived(false); setAutoDncSnapshot(null); setWorkflowDncUserTouched(false); inbox.refresh() }, [inbox.refresh])
  const actions = useReplyReviewActions(actionRefresh)
  useEffect(() => { if (!hasSelection) setMobileStep('list'); else if (mobileStep === 'list') setMobileStep('thread') }, [hasSelection, mobileStep])
  useEffect(() => {
    setWorkflowDraft(selectedItem ? { expected_revision: selectedItem.workflow_revision ?? selectedItem.revision, observed_inbound_revision: selectedItem.inbound_revision, action: selectedItem.action, owner_id: selectedItem.owner_id, next_follow_up_date: selectedItem.next_follow_up_date, do_not_contact: selectedItem.do_not_contact, change_reason: null } : null)
    setReviewDirty(false)
    setWorkflowUserDirty(false)
    setAutoDncDerived(false)
    setAutoDncSnapshot(null)
    setWorkflowDncUserTouched(false)
  }, [selectedItem?.instance_id, selectedItem?.profile_url, selectedItem?.revision])
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
  const confirmNavigation = useCallback(() => !dirty || window.confirm(UNSAVED_MESSAGE), [dirty])
  const clearDirty = useCallback(() => { setReviewDirty(false); setWorkflowUserDirty(false); setAutoDncDerived(false); setAutoDncSnapshot(null); setWorkflowDncUserTouched(false) }, [])
  const navigateWithoutGuard = useCallback((item: typeof selectedItem, focus?: number | null) => { clearDirty(); inbox.selectThread(item, focus); setMobileStep(item ? 'thread' : 'list') }, [clearDirty, inbox])
  const guardedSelect = useCallback((item: typeof selectedItem, focus?: number | null) => { if (!confirmNavigation()) return; navigateWithoutGuard(item, focus) }, [confirmNavigation, navigateWithoutGuard])
  const guardedScope = useCallback((patch: Partial<ReplyInboxScope>, options?: { replace?: boolean }) => { if (!confirmNavigation()) return; clearDirty(); inbox.setScope(patch, options) }, [clearDirty, confirmNavigation, inbox])
  const updateScope = useCallback((patch: Partial<ReplyInboxScope>) => inbox.setScope(patch), [inbox])
  useEffect(() => {
    if (search === inbox.scope.query) return
    const timer = window.setTimeout(() => guardedScope({ query: search, cursor: null }, { replace: true }), REPLY_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [guardedScope, inbox.scope.query, search])
  const saveReviewDraft = useCallback(async (draft: ReplyReviewDraft, confirmAutoReset?: boolean, moveNext = false) => {
    if (!selectedItem || !selectedMessage || selectedMessage.direction !== 'in') return
    const result = await actions.saveReview({ instance_id: selectedItem.instance_id, profile_url: selectedItem.profile_url, message_id: selectedMessage.id, expected_review_revision: selectedMessage.review?.revision ?? 0, review: draft, workflow: workflowDraft && workflowDirty ? workflowDraft : undefined, confirmAutoReset })
    if (!result) return
    clearDirty()
    if (moveNext) {
      const target = nextUnreviewedReply(inbox.thread?.messages ?? [], inbox.items, selectedMessage.id, selectedItem)
      if (target?.kind === 'message') { navigateWithoutGuard(selectedItem, target.value.id); return }
      navigateWithoutGuard(target?.kind === 'thread' ? target.value : null)
    }
  }, [actions, clearDirty, inbox.items, inbox.thread?.messages, navigateWithoutGuard, selectedItem, selectedMessage, workflowDirty, workflowDraft])
  const saveReview = useCallback((draft: ReplyReviewDraft, confirm?: boolean) => saveReviewDraft(draft, confirm), [saveReviewDraft])
  const saveReviewAndNext = useCallback((draft: ReplyReviewDraft, confirm?: boolean) => saveReviewDraft(draft, confirm, true), [saveReviewDraft])
  const saveWorkflow = useCallback((workflow: ReplyWorkflowMutation) => {
    if (!selectedItem) return Promise.resolve(null)
    return actions.saveWorkflow({ instance_id: selectedItem.instance_id, profile_url: selectedItem.profile_url, workflow }).then((result) => { if (result) { setReviewDirty(false); setWorkflowUserDirty(false); setAutoDncDerived(false); setAutoDncSnapshot(null); setWorkflowDncUserTouched(false) } return result })
  }, [actions, selectedItem])
  const handleReviewDraftChange = useCallback((draft: ReplyReviewDraft) => {
    if (!selectedItem) return
    const hasDncReason = draft.reason_ids.includes('do_not_contact')
    // DNC selected as a review reason must be saved atomically with workflow.
    // Removing the reason never clears an already-installed DNC decision.
    if (hasDncReason && !selectedItem.do_not_contact && !autoDncDerived) {
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
  }, [autoDncDerived, autoDncSnapshot, selectedItem, workflowDncUserTouched])
  const handleWorkflowDraftChange = useCallback((workflow: ReplyWorkflowMutation) => {
    const previous = workflowDraftRef.current
    if (previous && previous.do_not_contact !== workflow.do_not_contact) setWorkflowDncUserTouched(true)
    setWorkflowUserDirty(true)
    setWorkflowDraft(workflow)
  }, [])
  const handleWorkflowDirtyChange = useCallback((value: boolean) => { if (value) setWorkflowUserDirty(true) }, [])
  const hasData = inbox.loading || inbox.items.length > 0
  const currentName = selectedItem?.name || (inbox.scope.thread ? profileName(inbox.scope.thread.profile_url) : '')
  const selectedIsOutboundOnly = hasSelection && !!selectedMessage && selectedMessage.direction !== 'in'
  const ownerOptions = inbox.capabilities?.facets?.owners ?? []
  const capabilityReady = isReplyManualReady(inbox.capabilities)
  const actionWorkflow = selectedItem ? (() => {
    const base = inbox.thread?.workflow ?? { instance_id: selectedItem.instance_id, profile_url: selectedItem.profile_url, action: selectedItem.action, owner_id: selectedItem.owner_id, next_follow_up_date: selectedItem.next_follow_up_date, do_not_contact: selectedItem.do_not_contact, revision: selectedItem.revision, acknowledged_inbound_revision: selectedItem.acknowledged_inbound_revision, inbound_revision: selectedItem.inbound_revision }
    return workflowDraft ? { ...base, action: workflowDraft.action, owner_id: workflowDraft.owner_id, next_follow_up_date: workflowDraft.next_follow_up_date, do_not_contact: workflowDraft.do_not_contact, revision: workflowDraft.expected_revision } : base
  })() : null
  return <div className="replies-page">
    <NavigationGuard dirty={dirty} onDiscard={clearDirty} />
    <header className="replies-page-head"><div><div className="eyebrow">Рабочее место SDR</div><h1>Replies Inbox</h1><p className="muted">Читайте входящие ответы, вручную размечайте смысл и фиксируйте следующий шаг.</p></div><button className="secondary" type="button" onClick={inbox.refresh} disabled={inbox.loading}><RefreshCw size={15} /> Обновить</button></header>
    {!capabilityReady && <div className="replies-unavailable" role="status"><AlertCircle size={18} /> {capabilityMessage(inbox.capabilities)}</div>}
    <div className="replies-toolbar card"><label className="replies-search"><Search size={15} aria-hidden="true" /><input type="search" value={search} maxLength={200} placeholder="Имя, компания или текст ответа…" onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') guardedScope({ query: search, cursor: null }) }} /><button type="button" aria-label="Очистить поиск" onClick={() => { setSearch(''); guardedScope({ query: '', cursor: null }) }}><X size={14} /></button></label>
      <div className="replies-filter-row"><label className="replies-filter-select"><span className="muted small">View</span><select aria-label="View" value={inbox.scope.view} onChange={(event) => guardedScope({ view: event.target.value as ReplyInboxScope['view'], cursor: null })}>{VIEWS.map((view) => <option key={view} value={view}>{VIEW_LABELS[view]}</option>)}</select></label><div className="segmented" role="tablist" aria-label="Scope ответов">{(['new', 'historical', 'all'] as const).map((value) => <button key={value} type="button" className={`segmented-item ${inbox.scope.scope === value ? 'active' : ''}`} onClick={() => guardedScope({ scope: value, cursor: null })}>{value === 'new' ? 'Новые' : value === 'historical' ? 'История' : 'Все'}</button>)}</div><select aria-label="Account" value={inbox.scope.account ?? ''} onChange={(event) => guardedScope({ account: event.target.value || null, cursor: null })}><option value="">Все аккаунты</option>{inbox.capabilities?.instances?.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><select aria-label="Campaign" value={inbox.scope.campaign ?? ''} onChange={(event) => guardedScope({ campaign: event.target.value || null, cursor: null })}><option value="">Все кампании</option>{inbox.capabilities?.campaigns?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select aria-label="Conversation owner" value={inbox.scope.owner ?? ''} onChange={(event) => guardedScope({ owner: event.target.value || null, cursor: null })}><option value="">Все ответственные</option>{ownerOptions.map((owner) => <option key={owner.id} value={String(owner.id)}>{owner.name}</option>)}</select><select aria-label="Sentiment" value={inbox.scope.sentiment ?? ''} onChange={(event) => guardedScope({ sentiment: event.target.value as ReplyInboxScope['sentiment'], cursor: null })}><option value="">Все sentiment</option>{Object.entries(SENTIMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="Action" value={inbox.scope.action ?? ''} onChange={(event) => guardedScope({ action: (event.target.value || null) as ReplyInboxScope['action'], cursor: null })}><option value="">Все действия</option>{Object.entries(ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="Reason" value={inbox.scope.reason ?? ''} onChange={(event) => guardedScope({ reason: (event.target.value || null) as ReplyInboxScope['reason'], cursor: null })}><option value="">Все причины</option>{Object.entries(REASON_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{([['my', 'Мои'], ['unacknowledged', 'Нужен шаг'], ['unowned', 'Без ответственного'], ['overdue', 'Просрочены']] as const).map(([key, label]) => <label key={key} className="replies-toggle"><input type="checkbox" checked={inbox.scope[key]} onChange={(event) => guardedScope({ [key]: event.target.checked, cursor: null })} /> {label}</label>)}</div>
    </div>
    {inbox.stale && <div className="replies-stale" role="status">Показаны последние загруженные данные. <button type="button" onClick={inbox.refresh}>Повторить</button></div>}
    {capabilityReady ? <div className={`replies-workspace mobile-${mobileStep} ${hasSelection ? 'has-selection' : ''}`}>
      <aside className="replies-list-pane card" aria-label="Список диалогов"><div className="replies-pane-title"><h2>{inbox.scope.view === 'unreviewed' ? 'Очередь разбора' : 'Диалоги'}</h2><span className="muted small">{inbox.items.length}{inbox.nextCursor ? '+' : ''}</span></div>{inbox.loading && !inbox.items.length ? <div className="replies-loading">Загружаем ответы…</div> : inbox.error && !hasData ? <div className="replies-error"><AlertCircle size={18} />{inbox.error}<button type="button" onClick={inbox.refresh}>Повторить</button></div> : !inbox.items.length ? <EmptyState icon={Inbox} title="Очередь пуста" hint="Новые входящие ответы появятся здесь после синхронизации." /> : <div className="replies-list">{inbox.items.map((item) => { const selected = inbox.scope.thread?.instance_id === item.instance_id && inbox.scope.thread.profile_url === item.profile_url; const name = item.name || profileName(item.profile_url); return <button type="button" key={`${item.instance_id}|${item.profile_url}`} className={`replies-list-item ${selected ? 'selected' : ''}`} onClick={() => guardedSelect(item)}><span className="replies-list-item-top"><strong>{name}</strong><time>{formatTime(item.latest_sent_at)}</time></span><span className="muted small ellipsis">{[item.company, item.headline].filter(Boolean).join(' · ') || 'Без компании'}</span><span className="replies-list-item-bottom"><span className="ellipsis">{item.latest_snippet || 'Нет текста'}</span>{item.pending_count > 0 && <b>{item.pending_count}</b>}</span>{item.do_not_contact && <span className="replies-dnc-pill">DNC</span>}</button> })}</div>}{inbox.nextCursor && <button className="replies-load-more" type="button" onClick={inbox.loadMore} disabled={inbox.loadingMore}>{inbox.loadingMore ? 'Загружаем…' : 'Загрузить ещё'}</button>}</aside>
      <main className="replies-thread-pane card">{hasSelection && <button className="replies-mobile-back" type="button" onClick={() => { if (mobileStep === 'review') setMobileStep('thread'); else guardedSelect(null) }}><ArrowLeft size={14} /> {mobileStep === 'review' ? 'К переписке' : 'К списку'}</button>}{hasSelection ? <><div className="replies-thread-head"><div><h2>{currentName}</h2><p className="muted small">{[selectedItem?.company, selectedItem?.headline].filter(Boolean).join(' · ') || 'Identity из переписки'} · {inbox.scope.thread?.instance_id}</p></div><div className="replies-thread-status-chip">{selectedItem?.pending_count ? `${selectedItem.pending_count} не разобрано` : 'История просмотрена'}</div></div><ConversationThread messages={inbox.thread?.messages ?? []} selectedMessageId={selectedMessage?.id ?? null} focusMessageId={inbox.scope.thread?.focus_message_id} loading={inbox.loadingThread} error={inbox.threadError} olderCursor={inbox.thread?.older_cursor} newerCursor={inbox.thread?.newer_cursor} onSelectMessage={(message) => { if (confirmNavigation()) { clearDirty(); updateScope({ thread: { instance_id: message.instance_id, profile_url: message.profile_url, focus_message_id: message.id } }) } }} onLoadOlder={inbox.loadOlder} onLoadNewer={inbox.loadNewer} /><button type="button" className="replies-mobile-next" onClick={() => setMobileStep('review')}>К разметке и действию →</button></> : <div className="replies-select-empty"><Inbox size={30} /><h2>Выберите диалог</h2><p className="muted">Выберите ответ слева, чтобы открыть ограниченное окно переписки.</p></div>}</main>
      <aside className="replies-inspector-pane">{selectedItem && selectedMessage?.direction === 'in' ? <><ReplyReviewPanel message={selectedMessage} review={selectedMessage.review} saving={actions.saving} error={actions.error ?? (actions.conflict ? 'Данные изменились в другой вкладке. Обновите диалог и повторите.' : null)} history={inbox.history} historyLoading={inbox.historyLoading} historyCursor={inbox.historyCursor} onLoadHistoryMore={inbox.loadHistoryMore} onDirtyChange={setReviewDirty} onDraftChange={handleReviewDraftChange} onSave={saveReview} onSaveAndNext={saveReviewAndNext} /><ConversationActionPanel workflow={actionWorkflow} members={inbox.capabilities?.members} inboundRevision={inbox.thread?.inbound_revision ?? selectedItem.inbound_revision} persistedDoNotContact={inbox.thread?.workflow?.do_not_contact ?? selectedItem.do_not_contact} saving={actions.saving} error={actions.error} onDirtyChange={handleWorkflowDirtyChange} onDraftChange={handleWorkflowDraftChange} onSave={saveWorkflow} /></> : <div className="replies-inspector-empty">{selectedIsOutboundOnly ? 'Этот диалог содержит только исходящие сообщения — входящего ответа для разметки нет.' : selectedItem ? 'Выберите входящий ответ в переписке.' : 'Разметка и действие появятся здесь.'}</div>}</aside>
    </div> : <div className="replies-inactive-empty" role="status"><Inbox size={30} /><h2>Replies Inbox временно недоступен</h2><p className="muted">{capabilityMessage(inbox.capabilities)}</p></div>}
  </div>
}
