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
  it('passes direction only for directional pages and preserves cursors while merging', async () => {
    const initial: RepliesThreadResponse = { messages: [message(2), message(3)], older_cursor: 'old', newer_cursor: 'new', inbound_revision: 3, workflow: null }
    const older: RepliesThreadResponse = { messages: [message(1), message(2)], older_cursor: null }
    const newer: RepliesThreadResponse = { messages: [message(3), message(4)], newer_cursor: null }
    const thread = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(older).mockResolvedValueOnce(newer)
    const client: ReplyReadClient = {
      capabilities: vi.fn().mockResolvedValue({ available: true, active: true, manual_ready: true, mode: 'manual' }),
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
})
