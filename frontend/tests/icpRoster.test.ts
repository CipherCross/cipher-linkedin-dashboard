/**
 * The copilot's ICP roster, on both providers.
 *
 * This was the last Supabase-only surface in the API, and the way it failed is
 * the reason it needs a test rather than just a fix: `chat.ts` read
 * `neon ? '' : await loadIcpRoster()`, so on the Neon path the copilot lost its
 * ICP awareness with no error, no log and no failing request. Nothing that green
 * tests or a 200 response could ever show.
 *
 * So the assertions here are about the two things that silence could hide: that
 * **both** providers issue the same fixed query, and that a failure degrades the
 * prompt instead of taking the chat down — deliberately, rather than by
 * accidentally destructuring an error away as the PostgREST pair did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AI_NAMED_SQL, AI_OPERATIONS } from '../api/_lib/data/operations/ai.js'

/** What the fake AI store will answer, per operation. */
const answers = new Map<string, unknown[]>()
/** Every operation the AI store was asked for, in order. */
const askedOperations: string[] = []
/** Every SQL text the Supabase RPC was handed, in order. */
const rpcQueries: string[] = []
let storeFails = false
let rpcFails = false

vi.mock('../api/_lib/data/aiStore.js', () => ({
  SYSTEM_ACTOR: {
    kind: 'system',
    actorId: '00000000-0000-0000-0000-000000000000',
    tenantId: 'tenant',
  },
  getAiDataStore: () => ({
    query: async (_actor: unknown, request: { operation: string }) => {
      askedOperations.push(request.operation)
      if (storeFails) throw new Error('connect ECONNREFUSED db.example.test:5432')
      // The guard's shape: one row holding the aggregate of the real rows.
      return {
        items: [answers.get(request.operation) ?? []],
        hasMore: false,
        nextCursor: null,
      }
    },
  }),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async (_fn: string, args: { query: string }) => {
      rpcQueries.push(args.query)
      if (rpcFails) return { data: null, error: { message: 'boom' } }
      for (const [name, sql] of Object.entries(AI_NAMED_SQL)) {
        if (sql === args.query) {
          return { data: answers.get(AI_OPERATIONS[name as keyof typeof AI_OPERATIONS]) ?? [], error: null }
        }
      }
      return { data: [], error: null }
    },
  }),
}))

const { loadIcpRoster } = await import('../api/_lib/core.js')

const ICPS = [
  { id: 1, name: 'Fintech scale-ups', main_product: 'payments', core_sphere: 'finance' },
  { id: 2, name: 'Agencies', main_product: null, core_sphere: null },
]
const HYPOTHESES = [
  { name: 'Cost pressure', icp_id: 1, description: 'they are cutting spend' },
  { name: 'Orphan', icp_id: 99, description: null },
]

beforeEach(() => {
  answers.clear()
  askedOperations.length = 0
  rpcQueries.length = 0
  storeFails = false
  rpcFails = false
  answers.set(AI_OPERATIONS.icpRoster, ICPS)
  answers.set(AI_OPERATIONS.hypothesisRoster, HYPOTHESES)
  process.env.SUPABASE_URL = 'https://example.supabase.test'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
})

afterEach(() => {
  delete process.env.NEON_AI_PATH_DEFAULT
  vi.unstubAllEnvs()
})

describe('the ICP roster on the Neon path', () => {
  beforeEach(() => {
    process.env.NEON_AI_PATH_DEFAULT = 'neon'
  })

  it('asks the AI vocabulary for both lists — it is no longer skipped', () => {
    // The defect, stated as a test: on this path the roster used to be ''.
    return loadIcpRoster().then((roster) => {
      expect(askedOperations).toEqual([
        AI_OPERATIONS.icpRoster,
        AI_OPERATIONS.hypothesisRoster,
      ])
      expect(roster).toContain('Fintech scale-ups')
      expect(roster).toContain('Cost pressure')
    })
  })

  it('renders products, bare names and the ICP each hypothesis belongs to', async () => {
    const roster = await loadIcpRoster()
    expect(roster).toContain('- "Fintech scale-ups": payments — finance')
    expect(roster).toContain('- "Agencies"')
    expect(roster).toContain('- "Cost pressure" (ICP: "Fintech scale-ups"): they are cutting spend')
  })

  it('reads a hypothesis whose ICP is not in the live list as unassigned', async () => {
    // The behaviour a LEFT JOIN would have changed: an archived ICP is absent
    // from the roster, so a hypothesis pointing at it has no scope to show.
    const roster = await loadIcpRoster()
    expect(roster).toContain('- "Orphan" (no ICP assigned)')
  })

  it('says so when the list was trimmed, instead of reading as complete', async () => {
    answers.set(
      AI_OPERATIONS.icpRoster,
      Array.from({ length: 400 }, (_, i) => ({
        id: i + 1,
        name: `ICP ${i + 1}`,
        main_product: null,
        core_sphere: null,
      })),
    )
    const roster = await loadIcpRoster()
    expect(roster).toContain('truncated')
  })

  it('degrades to no roster rather than failing the chat', async () => {
    storeFails = true
    await expect(loadIcpRoster()).resolves.toBe('')
  })

  it('is empty when the team has neither ICPs nor hypotheses', async () => {
    answers.set(AI_OPERATIONS.icpRoster, [])
    answers.set(AI_OPERATIONS.hypothesisRoster, [])
    await expect(loadIcpRoster()).resolves.toBe('')
  })
})

describe('the ICP roster on the Supabase path', () => {
  it('runs the very same two statements through the guard RPC', async () => {
    const roster = await loadIcpRoster()
    // One definition of each query, shared by both providers: the texts the RPC
    // received are the adapter's own, not a second copy living in this loader.
    expect(rpcQueries).toEqual([
      AI_NAMED_SQL.icpRoster,
      AI_NAMED_SQL.hypothesisRoster,
    ])
    expect(roster).toContain('Fintech scale-ups')
    expect(roster).toContain('- "Cost pressure" (ICP: "Fintech scale-ups")')
  })

  it('degrades to no roster here too', async () => {
    rpcFails = true
    await expect(loadIcpRoster()).resolves.toBe('')
  })
})
