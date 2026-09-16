// @vitest-environment jsdom
/**
 * Opening a conversation cost seven server reads, and the hook then forgot it:
 * stepping back to the thread you were just in re-fetched the whole window, and
 * the change-history audit was fetched for every selection whether or not
 * anyone opened the panel it lives in.
 *
 * These are the two client-side halves of that fix. Each assertion is about a
 * request that must *not* happen, so each one fails on the code as it was.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_REPLY_SCOPE, type ReplyReadClient } from '../src/lib/replyReview'
import { useRepliesInbox } from '../src/lib/useRepliesInbox'

const alice = { instance_id: 'one', profile_url: 'https://linkedin.com/in/a' }
const bob = { instance_id: 'one', profile_url: 'https://linkedin.com/in/b' }
const threadKey = (key: typeof alice) => `${key.instance_id}|${key.profile_url}`

const message = (id: number, key = alice) => ({
  ...key, id, campaign_id: null, direction: 'in', body: String(id),
  sent_at: `2026-09-${String(id).padStart(2, '0')}T00:00:00.000Z`,
})
const listItem = (key: typeof alice, selected: number) => ({
  ...key, name: 'Someone', company: null, headline: null, latest_snippet: 'reply',
  latest_direction: 'in', latest_sent_at: '2026-09-03T00:00:00.000Z',
  selected_message_id: selected, pending_count: 1, owner_id: null, action: null,
  next_follow_up_date: null, do_not_contact: false, review_revision: 0,
  workflow_revision: 0, revision: 0, inbound_revision: 0, acknowledged_inbound_revision: 0,
})

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter initialEntries={[`/?thread=${encodeURIComponent(threadKey(alice))}`]}>{children}</MemoryRouter>
}

function clientWith(overrides: Partial<ReplyReadClient> = {}): ReplyReadClient {
  return {
    capabilities: vi.fn().mockResolvedValue({ available: true, active: true, manual_ready: true, mode: 'manual' }),
    facets: vi.fn().mockResolvedValue({ facets: {}, scope: DEFAULT_REPLY_SCOPE }),
    inbox: vi.fn().mockResolvedValue({ items: [listItem(alice, 3), listItem(bob, 9)], next_cursor: null, scope: DEFAULT_REPLY_SCOPE }),
    // Profile-aware, so a selected conversation actually contains the message
    // that was selected in it — otherwise the out-of-window focus fetch fires
    // and the call counts below would be measuring the mock, not the cache.
    thread: vi.fn(async (request: { profile_url: string }) => ({
      messages: request.profile_url === alice.profile_url ? [message(2), message(3)] : [message(9, bob)],
      older_cursor: null, newer_cursor: null, workflow: null,
    })) as unknown as ReplyReadClient['thread'],
    history: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    ...overrides,
  }
}

describe('a reviewed conversation is not read twice', () => {
  it('restores a window it has already been shown instead of re-reading it', async () => {
    const thread = vi.fn(async (request: { profile_url: string }) => ({
      messages: request.profile_url === alice.profile_url ? [message(2), message(3)] : [message(9, bob)],
      older_cursor: null, newer_cursor: null, workflow: null,
    }))
    const client = clientWith({ thread: thread as unknown as ReplyReadClient['thread'] })
    const { result } = renderHook(() => useRepliesInbox(client), { wrapper })

    await waitFor(() => expect(result.current.thread?.messages).toHaveLength(2))
    expect(thread).toHaveBeenCalledTimes(1)

    await act(async () => result.current.selectThread(listItem(bob, 9)))
    await waitFor(() => expect(result.current.thread?.messages.map((m) => m.id)).toEqual([9]))
    expect(thread).toHaveBeenCalledTimes(2)

    // Back to the first conversation — the move a review pass makes constantly.
    await act(async () => result.current.selectThread(listItem(alice, 3)))
    await waitFor(() => expect(result.current.thread?.messages.map((m) => m.id)).toEqual([2, 3]))
    expect(thread).toHaveBeenCalledTimes(2)
    // And it is shown immediately, not behind a spinner.
    expect(result.current.loadingThread).toBe(false)
  })

  it('forgets every window on refresh, because that is the path a save takes', async () => {
    const client = clientWith()
    const { result } = renderHook(() => useRepliesInbox(client), { wrapper })
    await waitFor(() => expect(result.current.thread?.messages).toHaveLength(2))
    expect(client.thread).toHaveBeenCalledTimes(1)

    await act(async () => result.current.refresh())
    await waitFor(() => expect(client.thread).toHaveBeenCalledTimes(2))

    await act(async () => result.current.selectThread(listItem(bob, 9)))
    await waitFor(() => expect(client.thread).toHaveBeenCalledTimes(3))
    await act(async () => result.current.selectThread(listItem(alice, 3)))
    // The post-refresh window was remembered, so this one is a hit again.
    await waitFor(() => expect(result.current.thread?.messages).toHaveLength(2))
    expect(client.thread).toHaveBeenCalledTimes(3)
  })
})

describe('the change-history audit is read when it is opened', () => {
  it('reads nothing until the panel asks for it', async () => {
    const client = clientWith()
    const { result } = renderHook(() => useRepliesInbox(client), { wrapper })
    await waitFor(() => expect(result.current.thread?.messages).toHaveLength(2))
    expect(client.history).not.toHaveBeenCalled()
    expect(result.current.historyRequested).toBe(false)

    await act(async () => result.current.requestHistory())
    await waitFor(() => expect(client.history).toHaveBeenCalledTimes(1))
    expect(result.current.historyRequested).toBe(true)
  })

  it('goes back to unrequested when the selection moves to another conversation', async () => {
    const client = clientWith()
    const { result } = renderHook(() => useRepliesInbox(client), { wrapper })
    await waitFor(() => expect(result.current.thread?.messages).toHaveLength(2))
    await act(async () => result.current.requestHistory())
    await waitFor(() => expect(client.history).toHaveBeenCalledTimes(1))

    await act(async () => result.current.selectThread(listItem(bob, 9)))
    await waitFor(() => expect(result.current.historyRequested).toBe(false))
    // No second audit read: the panel on the new conversation is closed again.
    expect(client.history).toHaveBeenCalledTimes(1)
  })
})
