/**
 * The live proofs of the AI store's principal contract.
 *
 * Part A runs against the runtime credential every neon suite already require:
 * a store connected as `app_runtime` and handed the AI registry must see its
 * guard call REFUSED — EXECUTE on `ai_execute_sql` belongs to `app_system`
 * alone, and that refusal is what makes "the guard is the whole capability"
 * true rather than asserted. This part needs nothing new.
 *
 * Part B needs the second credential the owner supplies after applying
 * `postgres/tenant-baseline/v1/000_ai_execution_role_bootstrap.sql`:
 * `NEON_AI_DATABASE_URL`, the app_system login. Until it exists this part
 * SKIPS — loudly — because its absence is a slice state (owner action
 * pending), not a missed source. Once supplied, the same `npm run test:neon`
 * invocation runs it: the happy path, and the SELECT-only proof — INSERT,
 * UPDATE, DELETE and a two-statement string pushed through `ai.executeSql`
 * and refused, with the row counts observed unchanged.
 *
 * Refusals are asserted by class only, never by message: driver text is not
 * stable and must not appear in a test expectation any more than in a log.
 */
import { afterAll, describe, expect, it } from 'vitest'

import {
  getAiDataStore,
  resetAiDataStore,
  SYSTEM_ACTOR,
} from '../api/_lib/data/aiStore.js'
import { NEON_AI_DATABASE_URL_ENV } from '../api/_lib/data/neonConfig.js'
import { NeonDataStore } from '../api/_lib/data/neon.js'
import {
  AI_OPERATIONS,
  buildAiRegistry,
} from '../api/_lib/data/operations/ai.js'
import { requireNeonTestConnection } from './support/neonContractHarness.js'

const connection = requireNeonTestConnection()

async function guardRows(store: NeonDataStore, query: string): Promise<unknown[]> {
  const page = await store.query<unknown[]>(SYSTEM_ACTOR, {
    operation: AI_OPERATIONS.executeSql,
    params: { query },
  })
  return (page.items[0] as unknown[] | undefined) ?? []
}

describe('the AI guard, reached as app_runtime (principal separation)', () => {
  let runtimeWithAiRegistry: NeonDataStore

  afterAll(async () => {
    await runtimeWithAiRegistry?.close()
  })

  it('refuses the guard call: EXECUTE belongs to app_system alone', async () => {
    // Same registry the AI store uses, but connected with the RUNTIME
    // credential and entering no role. The refusal comes from the database's
    // grant graph, which is exactly where the design puts it.
    runtimeWithAiRegistry = new NeonDataStore({
      connectionString: connection.pooled,
      operations: buildAiRegistry(),
      statementTimeoutMs: 12_000,
      maxConnections: 2,
      applicationName: 'lh2-s15-principal-proof',
    })
    await expect(guardRows(runtimeWithAiRegistry, 'select 1 as one')).rejects.toThrow()
  })
})

const hasAiCredential = Boolean(
  (process.env[NEON_AI_DATABASE_URL_ENV] ?? '').trim(),
)

describe.skipIf(!hasAiCredential)(
  `the AI store as app_system (${
    hasAiCredential
      ? NEON_AI_DATABASE_URL_ENV
      : `${NEON_AI_DATABASE_URL_ENV} absent — owner has not applied 000_ai_execution_role_bootstrap.sql`
  })`,
  () => {
    afterAll(async () => {
      await resetAiDataStore()
    })

    it('serves a simple SELECT through the guard', async () => {
      const rows = await guardRows(
        getAiDataStore() as NeonDataStore,
        'select count(*)::int as n from public.campaigns',
      )
      expect(rows).toHaveLength(1)
      expect(typeof (rows[0] as { n: number }).n).toBe('number')
    })

    it('serves a fixed named query as its own allowlist entry', async () => {
      const page = await getAiDataStore().query<unknown[]>(SYSTEM_ACTOR, {
        operation: AI_OPERATIONS.weeklyFunnel,
      })
      expect(Array.isArray(page.items[0])).toBe(true)
    })

    it('refuses INSERT, UPDATE, DELETE and a two-statement string, changing nothing', async () => {
      const store = getAiDataStore() as NeonDataStore
      const before = await guardRows(store, 'select count(*)::int as n from public.annotations')

      const mutations = [
        "insert into public.annotations (note) values ('s15-select-only-proof')",
        "update public.messages set sentiment = 'positive' where id = 0",
        "delete from public.annotations where note = 's15-select-only-proof'",
        'select 1 as one; select 2 as two',
      ]
      for (const query of mutations) {
        await expect(guardRows(store, query)).rejects.toThrow()
      }

      const after = await guardRows(store, 'select count(*)::int as n from public.annotations')
      expect(after).toEqual(before)
    })

    it('keeps the column-scoped exclusions: no contact fields, no identity tables', async () => {
      const store = getAiDataStore() as NeonDataStore
      // team_members is granted on four columns only; email is not among them.
      await expect(guardRows(store, 'select email from public.team_members limit 1')).rejects.toThrow()
      // users and user_identities receive no AI grant and no AI policy at all.
      await expect(guardRows(store, 'select count(*) from public.users')).rejects.toThrow()
    })
  },
)
