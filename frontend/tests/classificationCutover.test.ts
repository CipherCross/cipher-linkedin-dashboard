import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateObject = vi.hoisted(() => vi.fn())
const anthropic = vi.hoisted(() => vi.fn(() => ({ model: 'fixture' })))
const deploymentAiPath = vi.hoisted(() => vi.fn())
const guardMachine = vi.hoisted(() => vi.fn(async () => null))
const guardAdmin = vi.hoisted(() => vi.fn(async () => ({ response: null })))
const db = vi.hoisted(() => vi.fn())
const neonWriter = vi.hoisted(() => vi.fn())
const replyReviewWriter = vi.hoisted(() => vi.fn())
const saveReplyReview = vi.hoisted(() => vi.fn())
const getAiDataStore = vi.hoisted(() => vi.fn())

vi.mock('ai', () => ({ generateObject }))
vi.mock('@ai-sdk/anthropic', () => ({ anthropic }))
vi.mock('../api/_lib/data/aiPath.js', () => ({ deploymentAiPath }))
vi.mock('../api/_lib/auth.js', () => ({
  guardMachine,
  guardAdmin,
  authorizationResponse: () => null,
}))
vi.mock('../api/_lib/core.js', () => ({ db }))
vi.mock('../api/_lib/neonWrites.js', () => ({ neonWriter }))
vi.mock('../api/_lib/neonReplyReviewWrites.js', () => ({ replyReviewWriter, saveReplyReview }))
vi.mock('../api/_lib/data/operations/replyReviews.js', () => ({
  REPLY_REVIEW_OPERATIONS: { reviewForMessage: 'replies.reviewForMessage' },
}))
vi.mock('../api/_lib/data/aiStore.js', () => ({
  getAiDataStore,
  SYSTEM_ACTOR: {
    actorId: '00000000-0000-0000-0000-000000000000',
    kind: 'system',
    role: 'system',
    tenantId: 'primary',
  },
}))

const { GET, POST } = await import('../api/classify.js')
const { classifyWriteLabelsOperation, classifyReclassifyOperation, classifyAutoAdvanceOperation } =
  await import('../api/_lib/data/operations/aiWrites.js')

const ADMIN = {
  actorId: '11111111-1111-4111-8111-111111111111',
  kind: 'user',
  role: 'admin',
  tenantId: 'primary',
} as const

const MEMBER = {
  actorId: '33333333-3333-4333-8333-333333333333',
  kind: 'user',
  role: 'member',
  tenantId: 'primary',
} as const

const lead = {
  id: 'lead-1',
  instance_id: 'notebook-1',
  profile_url: 'https://www.linkedin.com/in/alice',
  full_name: 'Alice Example',
  headline: 'Founder',
}

function responseBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

function demographicsStore() {
  const query = vi.fn(async (_actor: unknown, request: { operation: string }) =>
    request.operation === 'classify.genderBatch'
      ? { items: [lead], hasMore: false, nextCursor: null }
      : { items: [{ remaining: 0 }], hasMore: false, nextCursor: null },
  )
  const execute = vi.fn(async () => ({ updated: 1 }))
  const transaction = vi.fn(async (_actor: unknown, callback: (tx: unknown) => Promise<unknown>) =>
    callback({ execute }),
  )
  return { store: { query, transaction }, query, execute, transaction }
}

beforeEach(() => {
  vi.clearAllMocks()
  deploymentAiPath.mockReturnValue('neon')
  neonWriter.mockResolvedValue({ store: {}, actor: ADMIN })
  replyReviewWriter.mockResolvedValue({ store: {}, actor: ADMIN })
})

describe('reply-classification AI cutover', () => {
  it('default scheduled GET disables reply AI but continues gender demographics', async () => {
    const fixture = demographicsStore()
    getAiDataStore.mockReturnValue(fixture.store)
    generateObject.mockResolvedValue({ object: { results: [{ ref: 0, gender: 'female', confidence: 0.9 }] } })

    const response = await GET(new Request('https://example.test/api/classify'))
    expect(response.status).toBe(200)
    const body = await responseBody(response)
    expect(body).toMatchObject({
      reply_classification: 'disabled',
      manual_only: true,
      reason: 'manual_review_required',
      demographics: { processed: 1, failed: 0 },
    })
    expect(body).not.toHaveProperty('auto_advanced')
    expect(generateObject).toHaveBeenCalledTimes(1)
    expect(anthropic).toHaveBeenCalledWith('claude-haiku-4-5')
    expect(fixture.transaction).toHaveBeenCalledTimes(1)
    expect(fixture.execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'classify.writeGender',
    }))
    expect(fixture.query.mock.calls.map(([, request]) => request.operation)).toEqual([
      'classify.genderBatch',
      'classify.genderBacklog',
    ])
    expect(db).not.toHaveBeenCalled()
  })

  it('leaves old worker operation names fail-closed during registry rollout', () => {
    expect(() => classifyWriteLabelsOperation.build({} as never)).toThrow(/disabled/i)
    expect(() => classifyReclassifyOperation.build({} as never)).toThrow(/disabled/i)
    expect(() => classifyAutoAdvanceOperation.build({} as never)).toThrow(/disabled/i)
  })

  it('admin POST returns explicit manual-only result without touching the store', async () => {
    const response = await POST(new Request('https://example.test/api/classify', { method: 'POST' }))
    expect(response.status).toBe(200)
    expect(await responseBody(response)).toMatchObject({
      reply_classification: 'disabled',
      manual_only: true,
    })
    expect(neonWriter).toHaveBeenCalledTimes(1)
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('Supabase fallback is unavailable and cannot perform a legacy reply write', async () => {
    deploymentAiPath.mockReturnValue('supabase')
    const response = await POST(new Request('https://example.test/api/classify', { method: 'POST' }))
    expect(response.status).toBe(503)
    expect(await responseBody(response)).toMatchObject({
      code: 'REPLY_REVIEW_UNAVAILABLE',
      manual_only: true,
    })
    expect(generateObject).not.toHaveBeenCalled()
    expect(db).not.toHaveBeenCalled()
  })

  it('keeps POST demographics as the only model-backed classify branch', async () => {
    const fixture = demographicsStore()
    neonWriter.mockResolvedValue({ store: fixture.store, actor: ADMIN })
    generateObject.mockResolvedValue({ object: { results: [{ ref: 0, gender: 'female', confidence: 0.9 }] } })

    const response = await POST(new Request('https://example.test/api/classify?mode=demographics', { method: 'POST' }))
    expect(response.status).toBe(200)
    expect((await responseBody(response)).demographics).toMatchObject({ processed: 1, failed: 0 })
    expect(generateObject).toHaveBeenCalledTimes(1)
    expect(anthropic).toHaveBeenCalledWith('claude-haiku-4-5')
    expect(fixture.transaction).toHaveBeenCalledTimes(1)
    expect(fixture.execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'classify.writeGender',
    }))
  })

  it('keeps GET demographics on the system gender path only', async () => {
    const fixture = demographicsStore()
    getAiDataStore.mockReturnValue(fixture.store)
    generateObject.mockResolvedValue({ object: { results: [{ ref: 0, gender: 'unknown', confidence: 0.2 }] } })

    const response = await GET(new Request('https://example.test/api/classify?mode=demographics'))
    expect(response.status).toBe(200)
    expect((await responseBody(response)).demographics).toMatchObject({ processed: 1 })
    expect(generateObject).toHaveBeenCalledTimes(1)
    expect(neonWriter).not.toHaveBeenCalled()
  })

  it('requires revision and mutation_id for legacy reclassify after cutover', async () => {
    const response = await POST(new Request('https://example.test/api/classify?mode=reclassify', {
      method: 'POST',
      body: JSON.stringify({ id: 42, sentiment: 'positive' }),
      headers: { 'content-type': 'application/json' },
    }))
    expect(response.status).toBe(409)
    expect(await responseBody(response)).toMatchObject({ code: 'review_refresh_required' })
    expect(saveReplyReview).not.toHaveBeenCalled()
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('delegates a valid legacy reclassify in-process to manual review service', async () => {
    const store = { query: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })) }
    replyReviewWriter.mockResolvedValue({ store, actor: ADMIN })
    saveReplyReview.mockResolvedValue({
      review: { message_id: 42, sentiment: 'positive', intent_state: 'unreviewed', intent_level: null },
      workflow: null,
      inbound_revision: 1,
      needs_action_confirmation: false,
      mutation_id: '22222222-2222-4222-8222-222222222222',
    })
    const mutationId = '22222222-2222-4222-8222-222222222222'
    const response = await POST(new Request('https://example.test/api/classify?mode=reclassify', {
      method: 'POST',
      body: JSON.stringify({
        id: 42,
        instance_id: 'notebook-1',
        profile_url: lead.profile_url,
        sentiment: 'positive',
        expected_review_revision: 0,
        mutation_id: mutationId,
      }),
      headers: { 'content-type': 'application/json' },
    }))
    expect(response.status).toBe(200)
    expect(saveReplyReview).toHaveBeenCalledWith(expect.anything(), ADMIN, expect.objectContaining({
      action: 'save_reply_review',
      message_id: 42,
      expected_review_revision: 0,
      mutation_id: mutationId,
    }))
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('allows an active member, not only an admin, through legacy reclassify', async () => {
    const store = { query: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })) }
    replyReviewWriter.mockResolvedValue({ store, actor: MEMBER })
    saveReplyReview.mockResolvedValue({
      review: { message_id: 42, sentiment: 'positive', intent_state: 'unreviewed', intent_level: null },
      workflow: null,
      inbound_revision: 1,
      needs_action_confirmation: false,
      mutation_id: '44444444-4444-4444-8444-444444444444',
    })
    const response = await POST(new Request('https://example.test/api/classify?mode=reclassify', {
      method: 'POST',
      body: JSON.stringify({
        id: 42,
        instance_id: 'notebook-1',
        profile_url: lead.profile_url,
        sentiment: 'positive',
        expected_review_revision: 0,
        mutation_id: '44444444-4444-4444-8444-444444444444',
      }),
      headers: { 'content-type': 'application/json' },
    }))
    expect(response.status).toBe(200)
    expect(saveReplyReview).toHaveBeenCalledWith(expect.anything(), MEMBER, expect.anything())
  })
})
