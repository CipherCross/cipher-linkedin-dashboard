import { describe, expect, it } from 'vitest'
import { FakeDataStore } from '../api/_lib/data/fake.js'
import { ReplyReviewValidationError, type SaveReplyReviewRequest, type SetReplyWorkflowRequest } from '../api/_lib/replyReview.js'
import { saveReplyReview, setReplyWorkflow } from '../api/_lib/neonReplyReviewWrites.js'
import type { ActorContext } from '../api/_lib/data/contracts.js'

const actor: ActorContext = { kind: 'user', actorId: '00000000-0000-4000-8000-000000000001', tenantId: 'tenant', role: 'member' }
const reviewRequest = (overrides: Partial<SaveReplyReviewRequest> = {}): SaveReplyReviewRequest => ({
  action: 'save_reply_review', mutation_id: '00000000-0000-4000-8000-000000000002', instance_id: 'notebook-1', profile_url: 'https://example.invalid/in/alice', message_id: 1, expected_review_revision: 0,
  review: { sentiment: 'positive', intent_state: 'unreviewed', intent_level: null, reason_ids: [], comment: null }, ...overrides,
})

describe('Neon reply-review transaction boundary', () => {
  it('rejects invalid input before opening a transaction', async () => {
    const store = new FakeDataStore()
    const request = reviewRequest({ review: { sentiment: 'negative', intent_state: 'none', intent_level: null, reason_ids: [], comment: null } })
    await expect(saveReplyReview(store, actor, request)).rejects.toBeInstanceOf(ReplyReviewValidationError)
  })

  it('rejects workflow actions that could bypass DNC or owner requirements', async () => {
    const store = new FakeDataStore()
    const request: SetReplyWorkflowRequest = {
      action: 'set_reply_workflow', mutation_id: '00000000-0000-4000-8000-000000000003', instance_id: 'notebook-1', profile_url: 'https://example.invalid/in/alice',
      workflow: { expected_revision: 0, observed_inbound_revision: 0, action: 'needs_reply', owner_id: null, next_follow_up_date: null, do_not_contact: false, change_reason: null },
    }
    await expect(setReplyWorkflow(store, actor, request)).rejects.toThrow(/owner/)
  })
})
