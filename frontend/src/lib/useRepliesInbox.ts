import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  decodeReplyScope, defaultReplyReadClient, encodeReplyScope, isReplyManualReady,
  type ReplyCapabilities, type ReplyInboxScope, type ReplyReadClient,
  type RepliesInboxItem, type RepliesThreadResponse, type ReplyReviewHistoryEntry,
} from './replyReview'

export function mergeThreadPage(current: RepliesThreadResponse, response: RepliesThreadResponse, direction: 'older' | 'newer'): RepliesThreadResponse {
  const ordered = direction === 'older' ? [...response.messages, ...current.messages] : [...current.messages, ...response.messages]
  const seen = new Set<number>()
  const messages = ordered.filter((message) => {
    if (seen.has(message.id)) return false
    seen.add(message.id)
    return true
  })
  return {
    ...current,
    ...response,
    messages,
    older_cursor: direction === 'older' ? response.older_cursor ?? null : current.older_cursor ?? null,
    newer_cursor: direction === 'newer' ? response.newer_cursor ?? null : current.newer_cursor ?? null,
    inbound_revision: response.inbound_revision === undefined ? current.inbound_revision : response.inbound_revision,
    workflow: response.workflow === undefined ? current.workflow : response.workflow,
    next_focus_message_id: response.next_focus_message_id === undefined ? current.next_focus_message_id : response.next_focus_message_id,
  }
}

export interface RepliesInboxState {
  scope: ReplyInboxScope
  items: RepliesInboxItem[]
  nextCursor: string | null
  thread: RepliesThreadResponse | null
  capabilities: ReplyCapabilities | null
  loading: boolean
  loadingThread: boolean
  loadingMore: boolean
  error: string | null
  threadError: string | null
  history: ReplyReviewHistoryEntry[]
  historyLoading: boolean
  historyCursor: string | null
  loadHistoryMore: () => void
  stale: boolean
  setScope: (patch: Partial<ReplyInboxScope>, options?: { replace?: boolean }) => void
  selectThread: (item: RepliesInboxItem | null, focusMessageId?: number | null) => void
  loadMore: () => void
  loadOlder: () => void
  loadNewer: () => void
  refresh: () => void
}

function messageFromScope(scope: ReplyInboxScope): string {
  return JSON.stringify({ ...scope, thread: scope.thread ? [scope.thread.instance_id, scope.thread.profile_url, scope.thread.focus_message_id] : null })
}

export function useRepliesInbox(client: ReplyReadClient = defaultReplyReadClient): RepliesInboxState {
  const [params, setParams] = useSearchParams()
  const scope = useMemo(() => decodeReplyScope(params), [params])
  const [items, setItems] = useState<RepliesInboxItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [thread, setThread] = useState<RepliesThreadResponse | null>(null)
  const [capabilities, setCapabilities] = useState<ReplyCapabilities | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingThread, setLoadingThread] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [history, setHistory] = useState<ReplyReviewHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const listAbort = useRef<AbortController | null>(null)
  const threadAbort = useRef<AbortController | null>(null)
  const historyAbort = useRef<AbortController | null>(null)
  const listScopeKey = messageFromScope({ ...scope, thread: null })
  const lastLoadedScope = useRef('')

  const setScope = useCallback((patch: Partial<ReplyInboxScope>, options: { replace?: boolean } = {}) => {
    const next = { ...scope, ...patch, cursor: patch.cursor === undefined ? null : patch.cursor }
    setParams(encodeReplyScope(next), { replace: options.replace ?? false })
  }, [scope, setParams])

  const selectThread = useCallback((item: RepliesInboxItem | null, focusMessageId: number | null = null) => {
    setScope({ thread: item ? { instance_id: item.instance_id, profile_url: item.profile_url, focus_message_id: focusMessageId ?? item.selected_message_id } : null })
  }, [setScope])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    listAbort.current?.abort()
    listAbort.current = controller
    setLoading(true)
    setError(null)
    setStale(false)
    if (!capabilities) return () => { cancelled = true; controller.abort() }
    if (!isReplyManualReady(capabilities)) {
      setItems([]); setNextCursor(null); setLoading(false)
      return () => { cancelled = true; controller.abort() }
    }
    if (lastLoadedScope.current !== listScopeKey) setItems([])
    lastLoadedScope.current = listScopeKey
    client.inbox(scope, controller.signal)
      .then((response) => {
        if (cancelled) return
        setItems(response.items ?? [])
        setNextCursor(response.next_cursor ?? null)
        setLoading(false)
      })
      .catch((reason: unknown) => {
        if (cancelled || (reason instanceof DOMException && reason.name === 'AbortError')) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setStale(items.length > 0)
        setLoading(false)
      })
    return () => { cancelled = true; controller.abort() }
    // `items` is intentionally not a dependency: stale data is only a fallback marker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities, client, listScopeKey, refreshToken])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    threadAbort.current?.abort()
    threadAbort.current = controller
    setThread(null)
    setThreadError(null)
    const selected = scope.thread
    if (!selected || !capabilities || !isReplyManualReady(capabilities)) { setLoadingThread(false); return () => { cancelled = true; controller.abort() } }
    setLoadingThread(true)
    client.thread({ ...selected, limit: 50 }, controller.signal)
      .then((response) => { if (!cancelled) { setThread(response); setLoadingThread(false) } })
      .catch((reason: unknown) => {
        if (cancelled || (reason instanceof DOMException && reason.name === 'AbortError')) return
        setThreadError(reason instanceof Error ? reason.message : String(reason)); setLoadingThread(false)
      })
    return () => { cancelled = true; controller.abort() }
  }, [capabilities, client, refreshToken, scope.thread])

  const selectedMessageId = scope.thread?.focus_message_id ?? (scope.thread ? items.find((item) => item.instance_id === scope.thread?.instance_id && item.profile_url === scope.thread?.profile_url)?.selected_message_id ?? null : null)
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    historyAbort.current?.abort()
    historyAbort.current = controller
    setHistory([]); setHistoryCursor(null)
    if (!scope.thread || selectedMessageId == null || !capabilities || !isReplyManualReady(capabilities)) { setHistoryLoading(false); return () => { cancelled = true; controller.abort() } }
    setHistoryLoading(true)
    client.history({ instance_id: scope.thread.instance_id, profile_url: scope.thread.profile_url, message_id: selectedMessageId, limit: 50 }, controller.signal)
      .then((response) => { if (!cancelled) { setHistory(response.items ?? []); setHistoryCursor(response.next_cursor ?? null); setHistoryLoading(false) } })
      .catch((reason: unknown) => { if (!cancelled && !(reason instanceof DOMException && reason.name === 'AbortError')) setHistoryLoading(false) })
    return () => { cancelled = true; controller.abort() }
  }, [capabilities, client, refreshToken, scope.thread, selectedMessageId])

  useEffect(() => {
    let cancelled = false
    client.capabilities().then((value) => { if (!cancelled) setCapabilities(value) }).catch(() => { if (!cancelled) setCapabilities({ available: false, reason: 'schema_unavailable', unavailable_reason: 'Не удалось определить состояние ручной разметки.' }) })
    return () => { cancelled = true }
  }, [client])

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore || !isReplyManualReady(capabilities)) return
    const controller = new AbortController()
    setLoadingMore(true)
    client.inbox({ ...scope, cursor: nextCursor }, controller.signal)
      .then((response) => { setItems((current) => [...current, ...(response.items ?? [])]); setNextCursor(response.next_cursor ?? null) })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoadingMore(false))
  }, [capabilities, client, loadingMore, nextCursor, scope])

  const loadOlder = useCallback(() => {
    if (!thread?.older_cursor || !scope.thread || loadingThread || !isReplyManualReady(capabilities)) return
    const controller = new AbortController()
    setLoadingThread(true)
    client.thread({ ...scope.thread, cursor: thread.older_cursor, direction: 'older', limit: 50 }, controller.signal)
      .then((response) => setThread((current) => current ? mergeThreadPage(current, response, 'older') : response))
      .catch((reason: unknown) => setThreadError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoadingThread(false))
  }, [capabilities, client, loadingThread, scope.thread, thread])

  const loadNewer = useCallback(() => {
    if (!thread?.newer_cursor || !scope.thread || loadingThread || !isReplyManualReady(capabilities)) return
    const controller = new AbortController()
    setLoadingThread(true)
    client.thread({ ...scope.thread, cursor: thread.newer_cursor, direction: 'newer', limit: 50 }, controller.signal)
      .then((response) => setThread((current) => current ? mergeThreadPage(current, response, 'newer') : response))
      .catch((reason: unknown) => setThreadError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoadingThread(false))
  }, [capabilities, client, loadingThread, scope.thread, thread])

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), [])
  const loadHistoryMore = useCallback(() => {
    if (!historyCursor || historyLoading || !scope.thread || selectedMessageId == null || !isReplyManualReady(capabilities)) return
    setHistoryLoading(true)
    client.history({ instance_id: scope.thread.instance_id, profile_url: scope.thread.profile_url, message_id: selectedMessageId, cursor: historyCursor, limit: 50 })
      .then((response) => { setHistory((current) => [...current, ...(response.items ?? [])]); setHistoryCursor(response.next_cursor ?? null) })
      .catch(() => { /* keep the already loaded audit visible */ })
      .finally(() => setHistoryLoading(false))
  }, [capabilities, client, historyCursor, historyLoading, scope.thread, selectedMessageId])
  return { scope, items, nextCursor, thread, capabilities, loading, loadingThread, loadingMore, error, threadError, history, historyLoading, historyCursor, loadHistoryMore, stale, setScope, selectThread, loadMore, loadOlder, loadNewer, refresh }
}
