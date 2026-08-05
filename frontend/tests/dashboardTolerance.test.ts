/**
 * The endpoint's half of the missing-relation tolerance, with no database.
 *
 * Ten of the twenty-two allowlisted reads answer an *absent relation* with an
 * empty page rather than a failure, because `DataContext` already does: it
 * excludes those reads' errors from the one error it reports, so a database
 * missing a not-yet-applied table renders a blank Search Library instead of an
 * empty dashboard. Moving them behind an endpoint that 500s on the same input
 * would have been a regression against today's behaviour.
 *
 * That behaviour has exactly two moving parts, and they are tested in the two
 * places they live:
 *
 * 1. **The adapter classifies.** SQLSTATE 42P01 becomes `DataStoreSchemaError`,
 *    and nothing else does. Proved against a real database in
 *    `tests/dashboardSliceRest.neon.test.ts` — including that a missing *column*
 *    is deliberately a different failure.
 * 2. **The handler decides.** This file. The tolerant branch cannot be reached on
 *    the live path at all, because every one of those relations exists in the Neon
 *    baseline: on a correct deployment the branch is dead code. So it is driven
 *    directly, by a store that raises what the adapter would raise.
 *
 * A test that skipped part 2 would be asserting a behaviour nothing had ever
 * executed — which is the specific way an error path rots.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DataStoreAuthorizationError,
  DataStoreSchemaError,
  DataStoreTransactionError,
  type DataStore,
} from '../api/_lib/data/contracts.js'
import { CONTRACT_ACTORS } from './support/dataStoreContract'

/** What the store will do on the next `query()`. Set per test. */
let queryBehaviour: () => never | Promise<never> = () => {
  throw new Error('no behaviour set')
}

let queriedOperations: string[] = []

vi.mock('../api/_lib/data/store.js', () => ({
  getDataStore: (): DataStore =>
    ({
      query: async (_actor: unknown, request: { operation: string }) => {
        queriedOperations.push(request.operation)
        return queryBehaviour()
      },
    }) as unknown as DataStore,
  dataStoreExists: () => true,
  resetDataStore: async () => undefined,
}))

/**
 * The actor is resolved for real on the live path and stubbed here, because this
 * file is about one `catch` branch. The deny matrix that proves the real
 * resolution is in the live suite, over these same operations — including the
 * tolerated ones, so a denial cannot come back as a tolerated empty page.
 */
vi.mock('../api/_lib/identity/session.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../api/_lib/identity/session.js')>()
  return {
    ...actual,
    resolveRequestActor: async () => ({
      actor: CONTRACT_ACTORS.activeMember,
      subject: 'subject-one',
    }),
  }
})

const { createActivityDailyHandler, TOLERANT_OPERATION_NAMES } = await import(
  '../api/activity-daily.js'
)
const GET = createActivityDailyHandler({})

interface Body {
  items?: unknown[]
  nextCursor?: string | null
  hasMore?: boolean
  unavailable?: boolean
  error?: string
}

async function call(op: string, extra: Record<string, string> = {}) {
  const url = new URL('https://dashboard.test/api/activity-daily')
  url.searchParams.set('op', op)
  for (const [key, value] of Object.entries(extra)) {
    url.searchParams.set(key, value)
  }
  const response = await GET(
    new Request(url, {
      method: 'GET',
      headers: { authorization: 'Bearer stub-token' },
    }),
  )
  return { status: response.status, body: (await response.json()) as Body }
}

/** Parameters for the reads that require them, so validation is not what fails. */
const REQUIRED_PARAMS: Record<string, Record<string, string>> = {
  'conversations.followUpHistory': {
    instance_id: 'notebook-1',
    profile_url: 'https://example.invalid/in/somebody',
  },
  'messages.thread': {
    instance_id: 'notebook-1',
    profile_url: 'https://example.invalid/in/somebody',
  },
  'leads.notes': { lead_id: '00000000-0000-4000-8000-000000000001' },
}

beforeEach(() => {
  queriedOperations = []
  vi.restoreAllMocks()
})

describe('a tolerated read answers an absent relation with an empty page', () => {
  it.each(TOLERANT_OPERATION_NAMES)('%s returns 200 and unavailable', async (op) => {
    queryBehaviour = () => {
      throw new DataStoreSchemaError(
        `Query operation ${op} referenced a relation that does not exist`,
      )
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = await call(op, REQUIRED_PARAMS[op] ?? {})

    expect(response.status).toBe(200)
    expect(response.body.items).toEqual([])
    expect(response.body.hasMore).toBe(false)
    expect(response.body.nextCursor).toBeNull()
    // The marker is the whole point: the browser has to distinguish an empty
    // follow-up queue from an absent one, which is what `followUpsAvailable` does
    // today. A bare `[]` would erase that.
    expect(response.body.unavailable).toBe(true)

    // Tolerated, not silent. Every one of these relations exists on the provider
    // this path reads, so reaching here at all is a fact about a deployment.
    expect(warn).toHaveBeenCalledTimes(1)
    // And the log line carries the adapter's own name and code — never the
    // driver's message, which for a connection-level failure embeds the database
    // hostname.
    expect(String(warn.mock.calls[0][1])).toBe(
      'DataStoreSchemaError/SCHEMA_OBJECT_MISSING',
    )
  })
})

describe('tolerance applies to an absent relation and to nothing else', () => {
  const INTOLERABLE = [
    [
      'an authorization denial',
      () => new DataStoreAuthorizationError('denied by database authorization'),
    ],
    [
      'a statement timeout',
      () => new DataStoreTransactionError('exceeded the statement timeout'),
    ],
    [
      'a connection failure',
      () => new DataStoreTransactionError('Acquiring a database connection: boom'),
    ],
  ] as const

  it.each(INTOLERABLE)('%s still fails a tolerated read', async (_label, make) => {
    queryBehaviour = () => {
      throw make()
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await call('searches.saved')

    expect(response.status).toBe(500)
    expect(response.body.items).toBeUndefined()
    expect(response.body.unavailable).toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('does not tolerate an absent relation on a read that is not marked', async () => {
    // The reads that compute a number are not tolerant, and this is the assertion
    // that says so through the handler rather than through the allowlist: for them
    // an empty answer is a *wrong* answer, so an absent relation must be a 500.
    queryBehaviour = () => {
      throw new DataStoreSchemaError('referenced a relation that does not exist')
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    for (const op of [
      'leads.directory',
      'messages.inboundHistory',
      'campaigns.performance',
      'messages.thread',
      'leads.notes',
      'conversations.followUpHistory',
    ]) {
      const response = await call(op, REQUIRED_PARAMS[op] ?? {})
      expect(response.status, op).toBe(500)
      expect(response.body.unavailable, op).toBeUndefined()
    }
    expect(error).toHaveBeenCalledTimes(6)
  })

  it('never reaches the store when input is malformed', async () => {
    queryBehaviour = () => {
      throw new Error('the store must not be called')
    }

    // A required parameter missing, a bad uuid, and a bad watermark: each refused
    // before any query, which is what keeps a caller's typo out of the 500s.
    expect((await call('messages.thread')).status).toBe(400)
    expect((await call('leads.notes', { lead_id: 'nope' })).status).toBe(400)
    expect(
      (await call('pipeline.eventLog', { occurred_since: 'yesterday' })).status,
    ).toBe(400)

    expect(queriedOperations).toEqual([])
  })
})
