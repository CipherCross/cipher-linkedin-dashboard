import { describe, expect, it, vi } from 'vitest'

import { CONTRACT_ACTORS } from './support/dataStoreContract'
import { REPLY_REVIEW_OPERATIONS } from '../api/_lib/data/operations/replyReviews.js'
import type { DataStore } from '../api/_lib/data/contracts.js'
import { followUpRepliesHref } from '../src/pages/FollowUps'

const actor = CONTRACT_ACTORS.activeMember
const thread = { instanceId: 'notebook-1', profileUrl: 'https://linkedin.com/in/alice' }

const rows = {
  capabilities: {
    available: true, active: true, manual_ready: true, mode: 'manual',
    schema_version: 'v1', capture_started_at: '2026-09-01T00:00:00.000Z',
    activated_at: '2026-09-01T00:00:00.000Z', activation_in_progress: false,
  },
  workflow: {
    instance_id: thread.instanceId, profile_url: thread.profileUrl, action: 'needs_reply',
    owner_id: actor.actorId, next_follow_up_date: null, do_not_contact: false,
    revision: 3, acknowledged_inbound_revision: 4, inbound_revision: 4,
  },
}

const queried: Array<{ operation: string; params?: Record<string, unknown> }> = []
/** Overrides the merged context row for the refusal cases. */
let threadContext: Record<string, unknown> | null = null
const store = {
  security: {},
  resolveActor: vi.fn(async () => ({ actorId: actor.actorId, role: actor.role })),
  resolveMachineActor: vi.fn(),
  transaction: vi.fn(),
  query: vi.fn(async (_caller: unknown, request: { operation: string; params?: Record<string, unknown>; page?: { limit?: number; cursor?: string | null } }) => {
    queried.push({ operation: request.operation, params: request.params })
    if (request.operation === REPLY_REVIEW_OPERATIONS.capabilities) return { items: [rows.capabilities], nextCursor: null, hasMore: false }
    // One read where there were four. Existence, focus membership, workflow and
    // inbound revision all come from `replies.threadContext` now; the four
    // single-purpose operations remain, used by the write path inside its own
    // transaction where they cost no extra round trip.
    if (request.operation === REPLY_REVIEW_OPERATIONS.threadContext) {
      return { items: [threadContext ?? { thread_exists: true, focus_exists: true, inbound_revision: 4, workflow: rows.workflow }], nextCursor: null, hasMore: false }
    }
    if (request.operation === REPLY_REVIEW_OPERATIONS.thread) {
      if (request.params?.direction === 'older') return { items: [{ id: 2, direction: 'in' }, { id: 1, direction: 'in' }], nextCursor: 'older-next', hasMore: true }
      return { items: [{ id: 2, direction: 'in' }, { id: 3, direction: 'in' }], nextCursor: 'newer-next', hasMore: true }
    }
    return { items: [], nextCursor: null, hasMore: false }
  }),
} as unknown as DataStore

vi.mock('../api/_lib/data/store.js', () => ({ getDataStore: () => store }))
vi.mock('../api/_lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/_lib/auth.js')>()),
  requireUser: async () => ({ userId: 'subject-one', email: null }),
}))

const { createActivityDailyHandler } = await import('../api/activity-daily.js')
const GET = createActivityDailyHandler({ legacyProviderName: 'fixture' })

function request(params: Record<string, string>): Request {
  const url = new URL('https://dashboard.test/api/activity-daily')
  url.searchParams.set('op', REPLY_REVIEW_OPERATIONS.thread)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return new Request(url, { headers: { authorization: 'Bearer fixture-token' } })
}

describe('manual reply review routes', () => {
  it('builds a scoped Follow-ups deep link with the latest message focus', () => {
    const href = followUpRepliesHref('notebook-1', 'https://linkedin.com/in/alice', 42)
    const query = new URLSearchParams(href.split('?')[1])
    expect(query.get('view')).toBe('all')
    expect(query.get('scope')).toBe('all')
    expect(query.get('thread')).toBe('notebook-1|https://linkedin.com/in/alice')
    expect(query.get('instance_id')).toBe('notebook-1')
    expect(query.get('profile_url')).toBe('https://linkedin.com/in/alice')
    expect(query.get('focus')).toBe('42')
  })

  it('returns canonical workflow, inbound revision, focus and directional cursors', async () => {
    queried.length = 0
    const response = await GET(request({
      instance_id: thread.instanceId, profile_url: thread.profileUrl, focus: '2', limit: '4',
    }))
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect((body.messages as Array<{ id: number }>).map((item) => item.id)).toEqual([1, 2, 3])
    expect(body.older_cursor).toBe('older-next')
    expect(body.newer_cursor).toBe('newer-next')
    expect(body.next_focus_message_id).toBe(2)
    expect(body.inbound_revision).toBe(4)
    expect(body.workflow).toEqual(rows.workflow)
    expect(queried.filter(({ operation }) => operation === REPLY_REVIEW_OPERATIONS.thread).map(({ params }) => params?.direction)).toEqual(['older', 'newer'])
    // Four reads for a focused open, not seven: the capability probe, the
    // merged context, and the two directional message pages.
    expect(queried.map(({ operation }) => operation)).toEqual([
      REPLY_REVIEW_OPERATIONS.capabilities,
      REPLY_REVIEW_OPERATIONS.threadContext,
      REPLY_REVIEW_OPERATIONS.thread,
      REPLY_REVIEW_OPERATIONS.thread,
    ])
    // The focus is passed to the context read, which is what makes its
    // membership check a check and not a formality.
    expect(queried.find(({ operation }) => operation === REPLY_REVIEW_OPERATIONS.threadContext)?.params).toMatchObject({ messageId: 2 })
  })

  // Merging four reads into one is only safe if the refusals it used to make
  // sequentially still happen, and still happen before any message is fetched.
  it('still answers 404 for an unknown thread, and reads no messages for it', async () => {
    queried.length = 0
    threadContext = { thread_exists: false, focus_exists: true, inbound_revision: 0, workflow: null }
    const response = await GET(request({ instance_id: thread.instanceId, profile_url: thread.profileUrl }))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'REPLY_REVIEW_NOT_FOUND' })
    expect(queried.some(({ operation }) => operation === REPLY_REVIEW_OPERATIONS.thread)).toBe(false)
    threadContext = null
  })

  it('still answers 404 for a focus message that belongs to another thread', async () => {
    queried.length = 0
    threadContext = { thread_exists: true, focus_exists: false, inbound_revision: 4, workflow: null }
    const response = await GET(request({ instance_id: thread.instanceId, profile_url: thread.profileUrl, focus: '99' }))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'The requested focus message was not found' })
    expect(queried.some(({ operation }) => operation === REPLY_REVIEW_OPERATIONS.thread)).toBe(false)
    threadContext = null
  })

  it('rejects unknown metric drilldowns instead of silently widening the inbox', async () => {
    const url = new URL('https://dashboard.test/api/activity-daily')
    url.searchParams.set('op', REPLY_REVIEW_OPERATIONS.inbox)
    url.searchParams.set('metric_scope', 'sentiment:not-a-real-bucket')
    const response = await GET(new Request(url, { headers: { authorization: 'Bearer fixture-token' } }))
    expect(response.status).toBe(400)
  })

  it('uses the latest bounded page for an un-focused thread and exposes a candidate', async () => {
    queried.length = 0
    const response = await GET(request({
      instance_id: thread.instanceId, profile_url: thread.profileUrl, limit: '2',
    }))
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect((body.messages as Array<{ id: number }>).map((item) => item.id)).toEqual([1, 2])
    expect(body.next_focus_message_id).toBe(1)
    expect(body.older_cursor).toBe('older-next')
    expect(body.newer_cursor).toBeNull()
  })
})
