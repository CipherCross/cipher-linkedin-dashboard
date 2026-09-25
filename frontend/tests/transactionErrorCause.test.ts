/**
 * Errors raised inside a transaction keep their meaning at the endpoint.
 *
 * The data store rethrows whatever the transaction work throws as
 * `DataStoreTransactionError(TRANSACTION_INVALID)`, keeping the original as
 * `cause`. The reply-review and follow-up handlers classified the wrapper, so a
 * stale-revision conflict became a generic 500 ("Could not save reply review",
 * "Could not update the follow-up") — seen in production on 23 and 24 Sep — and
 * the client, which recovers from a 409 by taking the current state, could not.
 * These run the real FakeDataStore transaction so the wrapping is the real one.
 */
import { describe, expect, it, vi } from 'vitest'
import { FakeDataStore } from '../api/_lib/data/fake.js'
import { DataStoreTransactionError, type ActorContext } from '../api/_lib/data/contracts.js'
import { raisedMessageOf, sqlStateOf, transactionCause } from '../api/_lib/data/errorCause.js'
import { ReplyReviewConflictError, ReplyReviewNotFoundError } from '../api/_lib/replyReview.js'
import { writeFailure } from '../api/_lib/neonReplyReviewWrites.js'
import { followUpFailure } from '../api/_lib/neonWrites.js'

const actor: ActorContext = { kind: 'user', actorId: '00000000-0000-4000-8000-000000000001', tenantId: 'tenant', role: 'member' }

async function thrownFromTransaction(error: unknown): Promise<unknown> {
  const store = new FakeDataStore()
  try {
    await store.transaction(actor, async () => { throw error })
  } catch (caught) {
    return caught
  }
  throw new Error('transaction did not throw')
}

/** What the Neon driver throws for a statement PostgreSQL refused. */
function pgFailure(code: string, message: string): DataStoreTransactionError {
  const pg = Object.assign(new Error(message), { code })
  const wrapped = new DataStoreTransactionError(`Command operation conversations.applyFollowUpAction: ${message}`)
  Object.defineProperty(wrapped, 'cause', { value: pg, enumerable: false })
  return wrapped
}

describe('a reply-review error raised inside the transaction', () => {
  it('is wrapped by the store, which is why the handler must look at the cause', async () => {
    const conflict = new ReplyReviewConflictError('review revision is stale', { revision: 2 })
    const thrown = await thrownFromTransaction(conflict)
    expect(thrown).toBeInstanceOf(DataStoreTransactionError)
    expect(transactionCause(thrown)).toBe(conflict)
  })

  it('answers a stale revision as 409 with the current review, not a 500', async () => {
    const thrown = await thrownFromTransaction(new ReplyReviewConflictError('review revision is stale', { revision: 2 }))
    const response = writeFailure(thrown, 'save reply review')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ current: { revision: 2 } })
  })

  it('answers a missing message as 404', async () => {
    const thrown = await thrownFromTransaction(new ReplyReviewNotFoundError('The requested message or thread was not found'))
    expect(writeFailure(thrown, 'save reply review').status).toBe(404)
  })

  it('still answers an unknown database failure as a 500, and logs its SQLSTATE', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = writeFailure(pgFailure('23514', 'violates check constraint'), 'save reply review')
    expect(response.status).toBe(500)
    expect(String(error.mock.calls[0]?.[1])).toContain('sqlstate=23514')
    error.mockRestore()
  })
})

describe('a follow-up refusal from apply_follow_up_action', () => {
  const input = {
    action: 'schedule' as never, instanceId: 'notebook-1', profileUrl: 'https://example.invalid/in/alice',
    expectedRevision: 0, mutationId: '00000000-0000-4000-8000-000000000009', ownerId: 1, nextFollowUpDate: '2026-10-01', reason: null,
  }

  it('answers 40001 FOLLOW_UP_CONFLICT as 409 with the current state, like the Supabase path', async () => {
    const store = new FakeDataStore()
    const current = { instance_id: input.instanceId, profile_url: input.profileUrl, revision: 3 }
    store.registerQuery('conversations.followUpState', () => [current])
    const response = await followUpFailure({ store, actor }, input, pgFailure('40001', 'FOLLOW_UP_CONFLICT: stale revision'))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'stale revision', state: current })
  })

  it('answers 22023 as 400 with the function\'s own message', async () => {
    const response = await followUpFailure({ store: new FakeDataStore(), actor }, input, pgFailure('22023', 'next_follow_up_date cannot be in the past'))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'next_follow_up_date cannot be in the past' })
  })
})

describe('errorCause helpers', () => {
  it('read the SQLSTATE and raised message through the cause chain', () => {
    const wrapped = pgFailure('40001', 'FOLLOW_UP_CONFLICT: stale revision')
    expect(sqlStateOf(wrapped)).toBe('40001')
    expect(raisedMessageOf(wrapped)).toBe('FOLLOW_UP_CONFLICT: stale revision')
    expect(sqlStateOf(new Error('plain'))).toBeNull()
  })
})
