// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authPost } from '../src/lib/api'
import { useReplyReviewActions } from '../src/lib/useReplyReviewActions'

vi.mock('../src/lib/api', () => ({ authFetch: vi.fn(), authPost: vi.fn() }))

const post = vi.mocked(authPost)
const input = {
  instance_id: 'one', profile_url: 'https://linkedin.com/in/a', message_id: 1,
  expected_review_revision: 0,
  review: { sentiment: null, intent_state: 'level' as const, intent_level: 'p2' as const, reason_ids: [], comment: '' },
}

describe('Replies Inbox mutation retry contract', () => {
  beforeEach(() => post.mockReset())

  it('reuses the mutation id after an uncertain network failure', async () => {
    post.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(new Response(JSON.stringify({
      review: { ...input.review, message_id: 1, taxonomy_version: 'v1', reviewed_by: 1, reviewed_at: null, revision: 1, provenance: 'human', complete: true },
      workflow: null, inbound_revision: 0, needs_action_confirmation: false, mutation_id: 'server-id',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { result } = renderHook(() => useReplyReviewActions())

    await act(async () => { await result.current.saveReview(input) })
    await act(async () => { await result.current.saveReview(input) })

    expect(post).toHaveBeenCalledTimes(2)
    const first = post.mock.calls[0][1] as { mutation_id: string }
    const second = post.mock.calls[1][1] as { mutation_id: string }
    expect(first.mutation_id).toBe(second.mutation_id)
  })
})
