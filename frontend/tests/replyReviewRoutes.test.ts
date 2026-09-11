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
const store = {
  security: {},
  resolveActor: vi.fn(async () => ({ actorId: actor.actorId, role: actor.role })),
  resolveMachineActor: vi.fn(),
  transaction: vi.fn(),
  query: vi.fn(async (_caller: unknown, request: { operation: string; params?: Record<string, unknown>; page?: { limit?: number; cursor?: string | null } }) => {
    queried.push({ operation: request.operation, params: request.params })
    if (request.operation === REPLY_REVIEW_OPERATIONS.capabilities) return { items: [rows.capabilities], nextCursor: null, hasMore: false }
    if (request.operation === REPLY_REVIEW_OPERATIONS.threadExists) return { items: [{ exists: true }], nextCursor: null, hasMore: false }
    if (request.operation === REPLY_REVIEW_OPERATIONS.messageForReview) return { items: [{ id: 2, direction: 'in', sent_at: '2026-09-11T02:00:00.000Z' }], nextCursor: null, hasMore: false }
    if (request.operation === REPLY_REVIEW_OPERATIONS.workflowForThread) return { items: [rows.workflow], nextCursor: null, hasMore: false }
    if (request.operation === REPLY_REVIEW_OPERATIONS.inboundRevision) return { items: [{ inbound_revision: 4 }], nextCursor: null, hasMore: false }
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
