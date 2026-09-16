/**
 * The Replies reads had no server telemetry, which is why the 2026-09-15
 * diagnosis could show that the queue took 2.5 s but not say what it spent the
 * time on. `op.startsWith('replies.')` returned before the dispatcher's
 * `dashboard_read` line and before `Server-Timing`, so neither the log nor
 * Chrome carried a single number for them.
 *
 * Two things are asserted here, because fixing one without the other leaves the
 * measurement useless:
 *
 * 1. The stage collector itself splits a `DataStore` call into acquisition,
 *    preamble, execution and commit, and sums them across a request. Without
 *    this, "the database was slow" and "the request waited for one of two pooled
 *    connections" stay indistinguishable.
 * 2. The reply reads now emit the same `dashboard_read` line and the same
 *    `Server-Timing` header as every other read — on success *and* on refusal,
 *    since a read that 503s slowly is exactly the case a log is needed for.
 *
 * No database: the store is a stub, so the stage list is legitimately empty
 * here. What that proves is that the endpoint reports whatever the driver
 * recorded rather than inventing numbers; the driver's own stages are exercised
 * against real PostgreSQL by the `neon` suite.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  collectDataStoreStages,
  recordDataStoreStage,
  summarizeDataStoreStages,
  totalDataStoreStages,
  type DataStoreStageTiming,
} from '../api/_lib/data/telemetry.js'
import { CONTRACT_ACTORS } from './support/dataStoreContract'
import { REPLY_REVIEW_OPERATIONS } from '../api/_lib/data/operations/replyReviews.js'
import type { DataStore } from '../api/_lib/data/contracts.js'

const actor = CONTRACT_ACTORS.activeMember

const stage = (over: Partial<DataStoreStageTiming> = {}): DataStoreStageTiming => ({
  operation: 'replies.inbox',
  acquire_ms: 1,
  preamble_ms: 2,
  execute_ms: 3,
  commit_ms: 4,
  total_ms: 10,
  outcome: 'ok',
  ...over,
})

const capability = {
  available: true, active: true, manual_ready: true, mode: 'manual',
  schema_version: 'v1', capture_started_at: '2026-09-01T00:00:00.000Z',
  activated_at: '2026-09-01T00:00:00.000Z', activation_in_progress: false,
}

let manualReviewAvailable = true

const store = {
  security: {},
  resolveActor: vi.fn(async () => ({ actorId: actor.actorId, role: actor.role })),
  resolveMachineActor: vi.fn(),
  transaction: vi.fn(),
  query: vi.fn(async (_caller: unknown, request: { operation: string }) => {
    if (request.operation === REPLY_REVIEW_OPERATIONS.capabilities) {
      return { items: manualReviewAvailable ? [capability] : [{ ...capability, mode: 'prepared' }], nextCursor: null, hasMore: false }
    }
    if (request.operation === REPLY_REVIEW_OPERATIONS.inbox) {
      return { items: [{ instance_id: 'notebook-1', profile_url: 'https://linkedin.com/in/alice' }], nextCursor: 'next-page', hasMore: true }
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

function read(op: string, params: Record<string, string> = {}): Request {
  const url = new URL('https://dashboard.test/api/activity-daily')
  url.searchParams.set('op', op)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return new Request(url, { headers: { authorization: 'Bearer fixture-token' } })
}

/** Run the handler and return the one `dashboard_read` payload it logged. */
async function readsLoggedBy(request: Request): Promise<{ response: Response; log: Record<string, unknown> }> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'info').mockImplementation((label: unknown, payload: unknown) => {
    if (label === 'dashboard_read') lines.push(String(payload))
  })
  try {
    const response = await GET(request)
    expect(lines).toHaveLength(1)
    return { response, log: JSON.parse(lines[0]) as Record<string, unknown> }
  } finally {
    spy.mockRestore()
  }
}

describe('data store stage collection', () => {
  it('collects the calls made inside one scope and nothing from outside it', async () => {
    recordDataStoreStage(stage({ operation: 'before.scope' }))
    const collected = await collectDataStoreStages(async (stages) => {
      recordDataStoreStage(stage({ operation: 'replies.capabilities' }))
      // Read mid-flight: the endpoint attributes stages to the phase that just
      // finished, so the sink has to be live rather than settled at the end.
      expect(stages).toHaveLength(1)
      recordDataStoreStage(stage({ operation: 'replies.inbox' }))
      return stages
    })
    expect(collected.map((entry) => entry.operation)).toEqual(['replies.capabilities', 'replies.inbox'])
  })

  it('keeps concurrent requests apart', async () => {
    const [first, second] = await Promise.all([
      collectDataStoreStages(async (stages) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        recordDataStoreStage(stage({ operation: 'first' }))
        return stages
      }),
      collectDataStoreStages(async (stages) => {
        recordDataStoreStage(stage({ operation: 'second' }))
        return stages
      }),
    ])
    expect(first.map((entry) => entry.operation)).toEqual(['first'])
    expect(second.map((entry) => entry.operation)).toEqual(['second'])
  })

  it('sums each stage separately so pool waiting is distinguishable from SQL', () => {
    const totals = totalDataStoreStages([
      stage({ acquire_ms: 900, preamble_ms: 40, execute_ms: 60, commit_ms: 30, total_ms: 1030 }),
      stage({ acquire_ms: 10, preamble_ms: 40, execute_ms: 500, commit_ms: 30, total_ms: 580 }),
    ])
    expect(totals).toEqual({
      calls: 2, acquire_ms: 910, preamble_ms: 80, execute_ms: 560, commit_ms: 60, total_ms: 1610,
    })
  })

  it('names each call and keeps a failed one visible', () => {
    expect(summarizeDataStoreStages([
      stage({ operation: 'replies.facets', acquire_ms: 0, preamble_ms: 0, commit_ms: 0, execute_ms: 12.34, total_ms: 12.34 }),
      stage({ operation: 'replies.thread', outcome: 'error' }),
    ])).toEqual([
      { op: 'replies.facets', total: 12.3, execute: 12.3 },
      { op: 'replies.thread', total: 10, acquire: 1, preamble: 2, execute: 3, commit: 4, outcome: 'error' },
    ])
  })
})

describe('reply reads report the same telemetry as every other read', () => {
  it('logs and times a successful queue read', async () => {
    manualReviewAvailable = true
    const { response, log } = await readsLoggedBy(read(REPLY_REVIEW_OPERATIONS.inbox, { view: 'unreviewed', scope: 'new' }))
    expect(response.status).toBe(200)
    expect(log.operation).toBe(REPLY_REVIEW_OPERATIONS.inbox)
    expect(log.status).toBe(200)
    expect(log.rows).toBe(1)
    expect(Number(log.bytes)).toBeGreaterThan(0)
    // The four names are the point of the change: one `query_ms` could not say
    // which of them the time went to.
    expect(log).toHaveProperty('db_acquire_ms')
    expect(log).toHaveProperty('db_preamble_ms')
    expect(log).toHaveProperty('db_execute_ms')
    expect(log).toHaveProperty('db_commit_ms')
    expect(log).toHaveProperty('db_stages')

    const timing = response.headers.get('server-timing') ?? ''
    for (const name of ['actor', 'db_acquire', 'db_preamble', 'db_execute', 'db_commit', 'total']) {
      expect(timing).toContain(`${name};dur=`)
    }
    expect(response.headers.get('x-request-id')).toBeTruthy()
  })

  it('logs a refused read too, which is the case the timing is most needed for', async () => {
    manualReviewAvailable = false
    const { response, log } = await readsLoggedBy(read(REPLY_REVIEW_OPERATIONS.inbox, { view: 'all', scope: 'all' }))
    expect(response.status).toBe(503)
    expect(log.status).toBe(503)
    expect(log.operation).toBe(REPLY_REVIEW_OPERATIONS.inbox)
    expect(response.headers.get('server-timing')).toContain('total;dur=')
    manualReviewAvailable = true
  })

  it('reports response size and row count on every answer', async () => {
    manualReviewAvailable = true
    const { response } = await readsLoggedBy(read(REPLY_REVIEW_OPERATIONS.inbox))
    expect(Number(response.headers.get('x-response-bytes'))).toBeGreaterThan(0)
    expect(response.headers.get('x-result-rows')).toBe('1')
  })
})
