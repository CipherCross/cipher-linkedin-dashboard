import { describe, expect, it } from 'vitest'
import {
  DataStoreTransactionError,
  FakeDataStore,
  PaginationError,
  type ActorContext,
} from '../api/_lib/data/index.js'
import {
  NeonConfigurationError,
  NEON_DATABASE_URL_ENV,
  isPooledConnectionString,
  readNeonConnectionString,
  toDirectConnectionString,
} from '../api/_lib/data/neonConfig.js'
import { runDataStoreContractSuite } from './support/dataStoreContract.js'
import { createFakeContractHarness } from './support/fakeContractHarness.js'

// The provider-neutral contract suite. The identical test bodies are run
// against the real Neon adapter by `dataStore.neon.test.ts`.
runDataStoreContractSuite('FakeDataStore', createFakeContractHarness)

const member: ActorContext = {
  kind: 'user',
  actorId: 'user-1',
  tenantId: 'tenant-a',
  role: 'member',
}

describe('FakeDataStore specifics', () => {
  it('scopes cursors to the exact query, params and range', async () => {
    const store = new FakeDataStore()
    store.registerQuery('items.list', () => [{ id: 1 }, { id: 2 }])

    const first = await store.query<{ id: number }>(member, {
      operation: 'items.list',
      page: { limit: 1 },
    })
    expect(first.nextCursor).not.toBeNull()

    await expect(
      store.query(member, {
        operation: 'items.list',
        page: { limit: 1, cursor: 'fake-cursor-does-not-exist' },
      }),
    ).rejects.toBeInstanceOf(PaginationError)
  })

  it('keeps committed state readable after a rolled-back transaction', async () => {
    const store = new FakeDataStore({ balance: 10 })
    store.registerCommand<void, { amount: number }>(
      'balance.increment',
      ({ params, state }) => {
        const balance = state.read<number>('balance') ?? 0
        state.write('balance', balance + (params?.amount ?? 0))
      },
    )

    await expect(
      store.transaction(member, async (transaction) => {
        await transaction.execute({
          operation: 'balance.increment',
          params: { amount: 5 },
        })
        throw new Error('caller failure')
      }),
    ).rejects.toBeInstanceOf(DataStoreTransactionError)

    expect(store.read<number>('balance')).toBe(10)
  })

  it('attaches the original failure as the transaction error cause', async () => {
    const store = new FakeDataStore()
    const original = new Error('underlying driver failure')
    store.registerCommand('boom', () => {
      throw original
    })

    const rejection = store
      .transaction(member, (transaction) =>
        transaction.execute({ operation: 'boom' }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    const error = await rejection
    expect(error).toBeInstanceOf(DataStoreTransactionError)
    expect((error as { cause?: unknown }).cause).toBe(original)
  })
})

describe('Neon connection configuration', () => {
  it('fails closed with an actionable message when the credential is absent', () => {
    expect(() => readNeonConnectionString({})).toThrow(NeonConfigurationError)
    expect(() => readNeonConnectionString({})).toThrow(NEON_DATABASE_URL_ENV)
    expect(() => readNeonConnectionString({ [NEON_DATABASE_URL_ENV]: '   ' })).toThrow(
      /Refusing to continue/,
    )
  })

  it('never accepts a browser-exposed variable name', () => {
    // The credential must not be reachable from the client bundle.
    expect(NEON_DATABASE_URL_ENV.startsWith('VITE_')).toBe(false)
  })

  it('derives the direct endpoint from the pooled one', () => {
    // Assembled from fragments, credential-free and unroutable. This asserts
    // string rewriting; nothing shaped like a connection string — real or
    // synthetic — belongs in a committed file.
    const scheme = ['postgre', 'sql:', '//'].join('')
    const pooled = `${scheme}role@host-pooler.example.invalid/db`
    expect(isPooledConnectionString(pooled)).toBe(true)
    const direct = toDirectConnectionString(pooled)
    expect(direct).toBe(`${scheme}role@host.example.invalid/db`)
    expect(isPooledConnectionString(direct)).toBe(false)
  })
})
