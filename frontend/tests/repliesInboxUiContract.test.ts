import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPLY_SCOPE, REPLY_ACTIONS, REPLY_INTENT_LEVELS, REPLY_INTENT_STATES, REPLY_REASON_IDS,
  REPLY_SENTIMENTS, decodeReplyScope, encodeReplyScope, needsAutoResetConfirmation, nextUnreviewedReply,
  validateReview, REPLY_SEARCH_DEBOUNCE_MS, isReplyManualReady,
} from '../src/lib/replyReview'
import { mergeThreadPage } from '../src/lib/useRepliesInbox'

describe('Replies Inbox UI contract', () => {
  it('uses independent plan views and inbox scopes', () => {
    expect(DEFAULT_REPLY_SCOPE.view).toBe('unreviewed')
    expect(encodeReplyScope({ view: 'completed', scope: 'historical' }).toString()).toContain('view=completed')
    expect(decodeReplyScope(new URLSearchParams('view=needs_reply&scope=all')).view).toBe('needs_reply')
    expect(decodeReplyScope(new URLSearchParams('view=deferred&scope=new')).scope).toBe('new')
    expect(REPLY_ACTIONS).toContain('awaiting_reply')
  })
  it('keeps literal search debounce at the contract value', () => expect(REPLY_SEARCH_DEBOUNCE_MS).toBe(300))
  it('does not treat prepared or activating capability as usable manual data', () => {
    expect(isReplyManualReady({ available: true, mode: 'prepared', active: false, manual_ready: false })).toBe(false)
    expect(isReplyManualReady({ available: true, mode: 'manual', active: true, manual_ready: true, activation_in_progress: true })).toBe(false)
    expect(isReplyManualReady({ available: true, mode: 'manual', active: true, manual_ready: true })).toBe(true)
  })
  it('merges directional thread pages without duplicate messages or losing the opposite cursor', () => {
    const message = (id: number) => ({ id, instance_id: 'one', profile_url: 'https://linkedin.com/in/a', campaign_id: null, direction: 'in', body: String(id), sent_at: `2026-09-${String(id).padStart(2, '0')}` })
    const current = { messages: [message(2), message(3)], older_cursor: 'older-1', newer_cursor: 'newer-1', workflow: null, inbound_revision: 3 }
    const older = mergeThreadPage(current, { messages: [message(1), message(2)], older_cursor: null }, 'older')
    expect(older.messages.map((item) => item.id)).toEqual([1, 2, 3])
    expect(older.older_cursor).toBeNull()
    expect(older.newer_cursor).toBe('newer-1')
    const newer = mergeThreadPage(current, { messages: [message(3), message(4)], newer_cursor: null }, 'newer')
    expect(newer.messages.map((item) => item.id)).toEqual([2, 3, 4])
    expect(newer.older_cursor).toBe('older-1')
    expect(newer.newer_cursor).toBeNull()
  })
  it('round-trips typed metric scope, UTC bounds and ownership toggles', () => {
    const value = encodeReplyScope({ ...DEFAULT_REPLY_SCOPE, metric_scope: { kind: 'reason', value: 'budget' }, from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', my: true, unacknowledged: true, unowned: true, overdue: true })
    const decoded = decodeReplyScope(value)
    expect(decoded.metric_scope).toEqual({ kind: 'reason', value: 'budget' })
    expect(decoded.from).toBe('2026-09-01T00:00:00.000Z')
    expect(decoded.to).toBe('2026-10-01T00:00:00.000Z')
    expect(decoded.my && decoded.unacknowledged && decoded.unowned && decoded.overdue).toBe(true)
  })
  it('keeps a direct thread focus null unless focus is a positive safe integer', () => {
    const base = new URLSearchParams('thread=one%7Chttps%3A%2F%2Flinkedin.com%2Fin%2Falice')
    expect(decodeReplyScope(base).thread?.focus_message_id).toBeNull()
    expect(decodeReplyScope(new URLSearchParams(`${base}&focus=0`)).thread?.focus_message_id).toBeNull()
    expect(decodeReplyScope(new URLSearchParams(`${base}&focus=-1`)).thread?.focus_message_id).toBeNull()
    expect(decodeReplyScope(new URLSearchParams(`${base}&focus=12`)).thread?.focus_message_id).toBe(12)
  })
  it('allows intent-only review and requires auto cleanup confirmation', () => {
    expect(validateReview({ sentiment: null, intent_state: 'level', intent_level: 'p2', reason_ids: [], comment: '' })).toEqual({})
    expect(validateReview({ sentiment: null, intent_state: 'not_applicable', intent_level: null, reason_ids: [], comment: '' })).toHaveProperty('intent_state')
    expect(needsAutoResetConfirmation({ sentiment: 'auto', intent_state: 'level', intent_level: 'p3', reason_ids: ['other'], comment: 'context' })).toBe(true)
    expect(needsAutoResetConfirmation({ sentiment: 'auto', intent_state: 'not_applicable', intent_level: null, reason_ids: [], comment: '' })).toBe(false)
    expect(REPLY_SENTIMENTS).toHaveLength(6); expect(REPLY_REASON_IDS).toHaveLength(9); expect(REPLY_INTENT_STATES).toHaveLength(4); expect(REPLY_INTENT_LEVELS).toHaveLength(3)
  })
  it('selects next unreviewed inbound in the same thread before another dialog', () => {
    const key = { instance_id: 'one', profile_url: 'https://linkedin.com/in/a' }
    const messages = [
      { ...key, id: 1, campaign_id: null, direction: 'in', body: 'done', sent_at: '2026-09-01', review: { complete: true } as never },
      { ...key, id: 2, campaign_id: null, direction: 'in', body: 'pending', sent_at: '2026-09-02', review: null },
    ]
    const items = [{ ...key, name: null, company: null, campaign_id: null, latest_snippet: 'pending', latest_direction: 'in', latest_sent_at: '2026-09-02', selected_message_id: 2, pending_count: 1, owner_id: null, action: null, next_follow_up_date: null, do_not_contact: false, review_revision: 0, workflow_revision: 0, revision: 0, inbound_revision: 0, acknowledged_inbound_revision: 0 }]
    expect(nextUnreviewedReply(messages, items, 1, key)?.kind).toBe('message')
  })
})
