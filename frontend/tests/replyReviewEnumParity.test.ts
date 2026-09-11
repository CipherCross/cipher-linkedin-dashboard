import { describe, expect, it } from 'vitest'
import { REPLY_ACTIONS, REPLY_INTENT_LEVELS, REPLY_INTENT_STATES, REPLY_REASON_IDS, REPLY_SENTIMENTS } from '../src/lib/replyReview'

// Temporary clean-room wire fixture. The integration worker should replace the
// fixture source with an import from frontend/api/_lib/replyReview.ts once that
// owned module exists; this keeps the browser contract test useful in isolation.
const API_ENUM_FIXTURE = {
  sentiments: ['positive', 'neutral', 'negative', 'objection', 'referral', 'auto'],
  reasons: ['no_need', 'timing', 'budget', 'existing_solution', 'offer_fit', 'wrong_person', 'trust_information', 'do_not_contact', 'other'],
  intentStates: ['unreviewed', 'none', 'level', 'not_applicable'],
  intentLevels: ['p1', 'p2', 'p3'],
  actions: ['needs_reply', 'follow_up', 'awaiting_reply', 'resolved', 'closed_soft', 'closed_hard'],
} as const

describe('reply review browser/API enum fixture', () => {
  it('keeps the exact wire vocabulary until the API module is integrated', () => {
    expect(REPLY_SENTIMENTS).toEqual(API_ENUM_FIXTURE.sentiments)
    expect(REPLY_REASON_IDS).toEqual(API_ENUM_FIXTURE.reasons)
    expect(REPLY_INTENT_STATES).toEqual(API_ENUM_FIXTURE.intentStates)
    expect(REPLY_INTENT_LEVELS).toEqual(API_ENUM_FIXTURE.intentLevels)
    expect(REPLY_ACTIONS).toEqual(API_ENUM_FIXTURE.actions)
  })
})
