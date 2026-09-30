// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_REPLY_SCOPE, type ReplyReadClient, type RepliesThreadResponse } from '../src/lib/replyReview'
import { useRepliesInbox } from '../src/lib/useRepliesInbox'

const key = { instance_id: 'one', profile_url: 'https://linkedin.com/in/a' }
const message = (id: number) => ({ ...key, id, campaign_id: null, direction: 'in', body: String(id), sent_at: `2026-09-${String(id).padStart(2, '0')}T00:00:00.000Z` })
const item = { ...key, name: 'Alice', company: null, headline: null, latest_snippet: 'reply', latest_direction: 'in', latest_sent_at: '2026-09-03T00:00:00.000Z', selected_message_id: 3, pending_count: 2, owner_id: null, action: null, next_follow_up_date: null, do_not_contact: false, review_revision: 0, workflow_revision: 0, revision: 0, inbound_revision: 0, acknowledged_inbound_revision: 0 }

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter initialEntries={[`/?thread=${encodeURIComponent(`${key.instance_id}|${key.profile_url}`)}`]}>{children}</MemoryRouter>
}

describe('Replies Inbox directional pagination', () => {
  it('keeps the loaded list and thread when only the focused message changes', async () => {
    const thread = vi.fn().mockResolvedValue({ messages: [message(2), message(3)], older_cursor: null, newer_cursor: null, workflow: null })
    const inbox = vi.fn().mockResolvedValue({ items: [item], next_cursor: null, scope: DEFAULT_REPLY_SCOPE })
    // The counts are their own read now, so this is also where a queue that had
    // gone back to waiting for them would show up as a failure.
    const facets = vi.fn().mockResolvedValue({ facets: { owners: [{ id: null, count: 1 }, { id: 1, count: 0 }] }, scope: DEFAULT_REPLY_SCOPE })
    const client: ReplyReadClient = {
      capabilities: vi.fn().mockResolvedValue({ available: true, active: true, manual_ready: true, mode: 'manual' }),
      facets, inbox, thread, history: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    }
    const { result } = renderHook(() => useRepliesInbox(client), { wrapper })
    await waitFor(() => expect(result.current.thread?.messages).toHaveLength(2))
    await act(async () => result.current.setScope({ thread: { ...key, focus_message_id: 2 } }))
    expect(result.current.thread?.messages).toHaveLength(2)
    expect(result.current.scope.thread?.focus_message_id).toBe(2)
    expect(thread).toHaveBeenCalledTimes(1)
    expect(inbox).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.facets?.owners).toEqual([{ id: null, count: 1 }, { id: 1, count: 0 }]))
    // Selecting a message inside the open thread changes neither the queue nor
    // the selection the counts describe, so neither is read a second time.
    expect(facets).toHaveBeenCalledTimes(1)
  })
  it('fetches an out-of-window focus without discarding the loaded messages or list', async () => {
    const thread = vi.fn()
      .mockResolvedValueOnce({ messages: [message(2), message(3)], older_cursor: 'old', newer_cursor: 'new', workflow: null })
      .mockResolvedValueOnce({ messages: [message(6), message(7), message(8)], older_cursor: 'older-focus', newer_cursor: 'newer-focus', workflow: null })
    const inbox = vi.fn().mockResolvedValue({ items: [item], next_cursor: null, scope: DEFAULT_REPLY_SCOPE })
    const client: ReplyReadClient = {
      capabilities: vi.fn().mockResolvedValue({ available: true, active: true, manual_ready: true, mode: 'manual' }),
      facets: vi.fn().mockResolvedValue({ facets: {}, scope: DEFAULT_REPLY_SCOPE }),
      inbox, thread, history: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    }
    const { result } = renderHook(() => useRepliesInbox(client), { wrapper })
    await waitFor(() => expect(result.current.thread?.messages.map(({ id }) => id)).toEqual([2, 3]))
    await act(async () => result.current.setScope({ thread: { ...key, focus_message_id: 7 } }))
    await waitFor(() => expect(result.current.thread?.messages.map(({ id }) => id)).toEqual([2, 3, 6, 7, 8]))
    expect(result.current.items).toHaveLength(1)
    expect(inbox).toHaveBeenCalledTimes(1)
    expect(thread).toHaveBeenCalledTimes(2)
    expect(thread).toHaveBeenNthCalledWith(2, expect.objectContaining({ focus_message_id: 7 }), expect.anything())
  })
  it('does not expose the previous account thread while the same profile loads elsewhere', async () => {
    let finishSecond!: (value: RepliesThreadResponse) => void
    const second = new Promise<RepliesThreadResponse>((resolve) => { finishSecond = resolve })
    const thread = vi.fn().mockResolvedValueOnce({ messages: [message(2)], older_cursor: null, newer_cursor: null, workflow: null }).mockReturnValueOnce(second)
    const client: ReplyReadClient = {
      capabilities: vi.fn().mockResolvedValue({ available: true, active: true, manual_ready: true, mode: 'manual' }),
      facets: vi.fn().mockResolvedValue({ facets: {}, scope: DEFAULT_REPLY_SCOPE }),
      inbox: vi.fn().mockResolvedValue({ items: [item], next_cursor: null, scope: DEFAULT_REPLY_SCOPE }),
      thread, history: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    }
    const { result } = renderHook(() => useRepliesInbox(client), { wrapper })
    await waitFor(() => expect(result.current.thread?.messages[0]?.instance_id).toBe('one'))
    await act(async () => result.current.setScope({ thread: { instance_id: 'two', profile_url: key.profile_url, focus_message_id: null } }))
    expect(result.current.thread).toBeNull()
    expect(result.current.loadingThread).toBe(true)
    await act(async () => finishSecond({ messages: [{ ...message(4), instance_id: 'two' }], older_cursor: null, newer_cursor: null, workflow: null }))
    await waitFor(() => expect(result.current.thread?.messages[0]?.instance_id).toBe('two'))
  })
  it('passes direction only for directional pages and preserves cursors while merging', async () => {
    const initial: RepliesThreadResponse = { messages: [message(2), message(3)], older_cursor: 'old', newer_cursor: 'new', inbound_revision: 3, workflow: null }
    const older: RepliesThreadResponse = { messages: [message(1), message(2)], older_cursor: null }
    const newer: RepliesThreadResponse = { messages: [message(3), message(4)], newer_cursor: null }
    const thread = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(older).mockResolvedValueOnce(newer)
    const client: ReplyReadClient = {
      capabilities: vi.fn().mockResolvedValue({ available: true, active: true, manual_ready: true, mode: 'manual' }),
      facets: vi.fn().mockResolvedValue({ facets: {}, scope: DEFAULT_REPLY_SCOPE }),
      inbox: vi.fn().mockResolvedValue({ items: [item], next_cursor: null, scope: DEFAULT_REPLY_SCOPE }),
      thread,
      history: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    }
    const { result } = renderHook(() => useRepliesInbox(client), { wrapper })
    await waitFor(() => expect(result.current.thread?.messages).toHaveLength(2))
    expect(thread).toHaveBeenNthCalledWith(1, expect.objectContaining({ focus_message_id: null }), expect.anything())
    expect(thread.mock.calls[0][0]).not.toHaveProperty('direction')

    await act(async () => { result.current.loadOlder() })
    await waitFor(() => expect(result.current.thread?.messages.map(({ id }) => id)).toEqual([1, 2, 3]))
    expect(thread).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'old', direction: 'older' }), expect.anything())
    expect(result.current.thread?.newer_cursor).toBe('new')

    await act(async () => { result.current.loadNewer() })
    await waitFor(() => expect(result.current.thread?.messages.map(({ id }) => id)).toEqual([1, 2, 3, 4]))
    expect(thread).toHaveBeenNthCalledWith(3, expect.objectContaining({ cursor: 'new', direction: 'newer' }), expect.anything())
    expect(result.current.thread?.older_cursor).toBeNull()
    expect(result.current.thread?.newer_cursor).toBeNull()
  })
  it('runs one list page at a time when scrolling and Save and next both page', async () => {
    // The scroll sentinel and the Save-and-next walk page the same list. Each
    // used to run on its own and overwrite the other's abort controller, so a
    // scroll during a walk could abort it or append a page twice.
    const listItem = (n: number, pending: number) => ({ ...item, profile_url: `https://linkedin.com/in/p${n}`, name: `P${n}`, pending_count: pending })
    let inFlight = 0
    let overlapped = false
    const pages: Record<string, { items: ReturnType<typeof listItem>[]; next_cursor: string | null }> = {
      first: { items: [listItem(1, 0)], next_cursor: 'c2' },
      c2: { items: [listItem(2, 0)], next_cursor: 'c3' },
      c3: { items: [listItem(3, 1)], next_cursor: null },
    }
    const inbox = vi.fn(async (request: { cursor?: string | null }) => {
      inFlight += 1
      if (inFlight > 1) overlapped = true
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { ...pages[request.cursor ?? 'first'], scope: DEFAULT_REPLY_SCOPE }
    })
    const client: ReplyReadClient = {
      capabilities: vi.fn().mockResolvedValue({ available: true, active: true, manual_ready: true, mode: 'manual' }),
      facets: vi.fn().mockResolvedValue({ facets: {}, scope: DEFAULT_REPLY_SCOPE }),
      inbox: inbox as unknown as ReplyReadClient['inbox'],
      thread: vi.fn().mockResolvedValue({ messages: [], older_cursor: null, newer_cursor: null, workflow: null }),
      history: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    }
    const { result } = renderHook(() => useRepliesInbox(client), { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> })
    await waitFor(() => expect(result.current.nextCursor).toBe('c2'))
    let found: Awaited<ReturnType<typeof result.current.nextPendingPage>> = null
    await act(async () => {
      const scrolled = result.current.loadMore()
      const again = result.current.loadMore()
      const walk = result.current.nextPendingPage()
      await Promise.all([scrolled, again])
      found = await walk
    })
    expect(overlapped).toBe(false)
    expect(found).toMatchObject({ name: 'P3' })
    expect(result.current.items.map(({ name }) => name)).toEqual(['P1', 'P2', 'P3'])
    // first page, c2 (the scroll), c3 (the walk continuing from where it ended)
    expect(inbox.mock.calls.map(([request]) => request.cursor ?? 'first')).toEqual(['first', 'c2', 'c3'])
    expect(result.current.loadingMore).toBe(false)
  })
})
