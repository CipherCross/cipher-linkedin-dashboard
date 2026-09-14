import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  decodeReplyScope, defaultReplyReadClient, encodeReplyScope, isReplyManualReady,
  type ReplyCapabilities, type ReplyInboxScope, type ReplyReadClient,
  type RepliesInboxItem, type RepliesThreadResponse, type ReplyReviewHistoryEntry, type ReplyListFacets,
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
  facets: ReplyListFacets | null
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
  loadMore: () => Promise<RepliesInboxItem[]>
  nextPendingPage: () => Promise<RepliesInboxItem | null>
  loadOlder: () => void
  loadNewer: () => void
  refresh: () => void
}

function messageFromScope(scope: ReplyInboxScope): string {
  return JSON.stringify({ ...scope, thread: null })
}

export function useRepliesInbox(client: ReplyReadClient = defaultReplyReadClient): RepliesInboxState {
  const [params, setParams] = useSearchParams()
  const scope = useMemo(() => decodeReplyScope(params), [params])
  const [items, setItems] = useState<RepliesInboxItem[]>([])
  const [facets, setFacets] = useState<ReplyListFacets | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [threadState, setThread] = useState<RepliesThreadResponse | null>(null)
  const [loadedThreadKey, setLoadedThreadKey] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<ReplyCapabilities | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingThread, setLoadingThread] = useState(false)
  const [focusLoading, setFocusLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [history, setHistory] = useState<ReplyReviewHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const listAbort = useRef<AbortController | null>(null)
  const moreAbort = useRef<AbortController | null>(null)
  const threadAbort = useRef<AbortController | null>(null)
  const historyAbort = useRef<AbortController | null>(null)
  const requestedFocus = useRef<string | null>(null)
  const listScopeKey = messageFromScope({ ...scope, thread: null })
  const activeListScope = useRef(listScopeKey)
  activeListScope.current = listScopeKey
  const threadKey = scope.thread ? `${scope.thread.instance_id}|${scope.thread.profile_url}` : null
  const thread = loadedThreadKey === threadKey ? threadState : null
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
    if (lastLoadedScope.current !== listScopeKey) moreAbort.current?.abort()
    listAbort.current = controller
    setLoading(true)
    setError(null)
    setStale(false)
    if (!capabilities) return () => { cancelled = true; controller.abort() }
    if (!isReplyManualReady(capabilities)) {
      setItems([]); setFacets(null); setNextCursor(null); setLoading(false)
      return () => { cancelled = true; controller.abort() }
    }
    if (lastLoadedScope.current !== listScopeKey) { setItems([]); setFacets(null) }
    lastLoadedScope.current = listScopeKey
    client.inbox(scope, controller.signal)
      .then((response) => {
        if (cancelled) return
        setItems(response.items ?? [])
        setFacets(response.facets ?? null)
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
    setThreadError(null)
    const selected = scope.thread
    if (!selected || !capabilities || !isReplyManualReady(capabilities)) { setLoadingThread(false); return () => { cancelled = true; controller.abort() } }
    setLoadingThread(true)
    client.thread({ ...selected, limit: 50 }, controller.signal)
      .then((response) => { if (!cancelled) { setLoadedThreadKey(threadKey); setThread(response); setLoadingThread(false) } })
      .catch((reason: unknown) => {
        if (cancelled || (reason instanceof DOMException && reason.name === 'AbortError')) return
        setThreadError(reason instanceof Error ? reason.message : String(reason)); setLoadingThread(false)
      })
    return () => { cancelled = true; controller.abort() }
  }, [capabilities, client, refreshToken, threadKey])

  // A deep link or browser Back can select a message beyond the current
  // 50-message window. Keep the visible thread while retrieving that window.
  const focusMessageId = scope.thread?.focus_message_id ?? null
  useEffect(() => {
    if (!scope.thread || focusMessageId == null || !thread || loadingThread || !isReplyManualReady(capabilities) || thread.messages.some((message) => message.id === focusMessageId)) { setFocusLoading(false); return }
    const requestKey = `${threadKey}|${focusMessageId}`
    if (requestedFocus.current === requestKey) return
    requestedFocus.current = requestKey
    const controller = new AbortController()
    let finished = false
    setFocusLoading(true)
    setThreadError(null)
    client.thread({ ...scope.thread, limit: 50 }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        finished = true
        setThread((current) => {
          if (!current) return response
          const byId = new Map([...current.messages, ...response.messages].map((message) => [message.id, message]))
          const messages = [...byId.values()].sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id - b.id)
          const older = response.messages[0] && current.messages[0] && response.messages[0].sent_at < current.messages[0].sent_at
          const responseLast = response.messages[response.messages.length - 1]
          const currentLast = current.messages[current.messages.length - 1]
          const newer = responseLast && currentLast && responseLast.sent_at > currentLast.sent_at
          return { ...current, ...response, messages, older_cursor: older ? response.older_cursor : current.older_cursor, newer_cursor: newer ? response.newer_cursor : current.newer_cursor }
        })
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setThreadError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (!controller.signal.aborted) setFocusLoading(false) })
    return () => {
      controller.abort()
      if (!finished && requestedFocus.current === requestKey) requestedFocus.current = null
    }
  }, [capabilities, client, focusMessageId, loadingThread, scope.thread, thread, threadKey])

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
  }, [capabilities, client, refreshToken, threadKey, selectedMessageId])

  useEffect(() => {
    let cancelled = false
    client.capabilities().then((value) => { if (!cancelled) setCapabilities(value) }).catch(() => { if (!cancelled) setCapabilities({ available: false, reason: 'schema_unavailable', unavailable_reason: 'Could not determine whether manual review is available.' }) })
    return () => { cancelled = true }
  }, [client])

  const loadMore = useCallback(async (): Promise<RepliesInboxItem[]> => {
    if (!nextCursor || loadingMore || !isReplyManualReady(capabilities)) return []
    const controller = new AbortController()
    moreAbort.current = controller
    const requestedScope = listScopeKey
    setLoadingMore(true)
    try {
      const response = await client.inbox({ ...scope, cursor: nextCursor }, controller.signal)
      if (controller.signal.aborted || activeListScope.current !== requestedScope) return []
      const incoming = response.items ?? []
      setItems((current) => { const seen = new Set(current.map((item) => `${item.instance_id}|${item.profile_url}`)); return [...current, ...incoming.filter((item) => { const key = `${item.instance_id}|${item.profile_url}`; if (seen.has(key)) return false; seen.add(key); return true })] })
      setNextCursor(response.next_cursor ?? null)
      return incoming
    } catch (reason: unknown) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      return []
    } finally { setLoadingMore(false) }
  }, [capabilities, client, listScopeKey, loadingMore, nextCursor, scope])

  const nextPendingPage = useCallback(async (): Promise<RepliesInboxItem | null> => {
    if (!nextCursor || !isReplyManualReady(capabilities)) return null
    const requestedScope = listScopeKey
    const controller = new AbortController()
    moreAbort.current = controller
    let cursor: string | null = nextCursor
    const visited = new Set<string>()
    setLoadingMore(true)
    try {
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor)
        const response = await client.inbox({ ...scope, cursor }, controller.signal)
        if (controller.signal.aborted || activeListScope.current !== requestedScope) return null
        const incoming = response.items ?? []
        setItems((current) => { const seen = new Set(current.map((item) => `${item.instance_id}|${item.profile_url}`)); return [...current, ...incoming.filter((item) => { const key = `${item.instance_id}|${item.profile_url}`; if (seen.has(key)) return false; seen.add(key); return true })] })
        cursor = response.next_cursor ?? null
        setNextCursor(cursor)
        const next = incoming.find((item) => item.pending_count > 0)
        if (next) return next
      }
    } catch (reason: unknown) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setLoadingMore(false) }
    return null
  }, [capabilities, client, listScopeKey, nextCursor, scope])

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
  return { scope, items, facets, nextCursor, thread, capabilities, loading, loadingThread: loadingThread || focusLoading, loadingMore, error, threadError, history, historyLoading, historyCursor, loadHistoryMore, stale, setScope, selectThread, loadMore, nextPendingPage, loadOlder, loadNewer, refresh }
}
