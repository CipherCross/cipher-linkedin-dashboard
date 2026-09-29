/**
 * The copilot's ICP roster.
 *
 * It once went silently empty — `chat.ts` skipped it on one provider with no
 * error, no log and no failing request — so the assertions here are about the
 * two things silence could hide: that the fixed queries are actually issued,
 * and that a failure degrades the prompt instead of taking the chat down.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AI_OPERATIONS } from '../api/_lib/data/operations/ai.js'

/** What the fake AI store will answer, per operation. */
const answers = new Map<string, unknown[]>()
/** Every operation the AI store was asked for, in order. */
const askedOperations: string[] = []
let storeFails = false

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
  storeFails = false
  answers.set(AI_OPERATIONS.icpRoster, ICPS)
  answers.set(AI_OPERATIONS.hypothesisRoster, HYPOTHESES)
})

describe('the ICP roster', () => {
  it('asks the AI vocabulary for both lists — it is never skipped', () => {
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
