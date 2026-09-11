import { describe, expect, it } from 'vitest'
import {
  REPLY_ACTIONS,
  REPLY_REASON_IDS,
  REPLY_SENTIMENTS,
  decodeReplyCursor,
  encodeReplyCursor,
  ReplyReviewValidationError,
  replyMetricRate,
  replyMutationFingerprint,
  validateReplyReviewInput,
  validateReplyWorkflowInput,
} from '../api/_lib/replyReview.js'

describe('manual reply-review contract', () => {
  it('keeps the product enums closed and stable', () => {
    expect(REPLY_SENTIMENTS).toEqual(['positive', 'neutral', 'negative', 'objection', 'referral', 'auto'])
    expect(REPLY_REASON_IDS).toHaveLength(9)
    expect(REPLY_ACTIONS).toEqual(['needs_reply', 'follow_up', 'awaiting_reply', 'resolved', 'closed_soft', 'closed_hard'])
  })

  it('requires reason detail for negative/objection and other', () => {
    expect(() => validateReplyReviewInput({ sentiment: 'negative', intent_state: 'none', intent_level: null, reason_ids: [], comment: null })).toThrow(ReplyReviewValidationError)
    expect(() => validateReplyReviewInput({ sentiment: 'objection', intent_state: 'none', intent_level: null, reason_ids: ['other'], comment: null })).toThrow(/comment/)
    expect(validateReplyReviewInput({ sentiment: 'negative', intent_state: 'none', intent_level: null, reason_ids: ['budget', 'timing'], comment: 'later' }).reason_ids).toEqual(['budget', 'timing'])
  })

  it('does not infer or overwrite intent when sentiment is positive', () => {
    expect(validateReplyReviewInput({ sentiment: 'positive', intent_state: 'unreviewed', intent_level: null, reason_ids: [], comment: null }).intent_state).toBe('unreviewed')
    expect(() => validateReplyReviewInput({ sentiment: 'auto', intent_state: 'none', intent_level: null, reason_ids: [], comment: null })).toThrow()
  })

  it('requires an owner for work and a comment only when clearing DNC', () => {
    expect(() => validateReplyWorkflowInput({ expected_revision: 0, observed_inbound_revision: 0, action: 'needs_reply', owner_id: null, next_follow_up_date: null, do_not_contact: false, change_reason: null })).toThrow(/owner/)
    expect(validateReplyWorkflowInput({ expected_revision: 0, observed_inbound_revision: 0, action: 'resolved', owner_id: 1, next_follow_up_date: null, do_not_contact: true, change_reason: null }).do_not_contact).toBe(true)
  })

  it('hashes object key order canonically and leaves rates undefined at zero', () => {
    expect(replyMutationFingerprint({ b: 2, a: 1 })).toBe(replyMutationFingerprint({ a: 1, b: 2 }))
    expect(replyMetricRate(0, 0)).toBeNull()
    expect(replyMetricRate(1, 2)).toBe(0.5)
  })

  it('binds cursors to the complete filter scope and rejects foreign scopes', () => {
    const scope = { view: 'unreviewed', scope: 'new', account: 'n1', campaign: null, my: false }
    const token = encodeReplyCursor(scope, { sort: 'first_seen', direction: 'older', key: ['2026-09-11T00:00:00.000Z', 'n1', 'profile'] })
    expect(decodeReplyCursor(token, scope).key).toEqual(['2026-09-11T00:00:00.000Z', 'n1', 'profile'])
    expect(() => decodeReplyCursor(token, { ...scope, account: 'n2' })).toThrow(/scope/)
  })
})
