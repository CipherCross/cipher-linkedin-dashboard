import { describe, expect, it } from 'vitest'
import {
  ActorContextError,
  asUtcTimestamp,
  DATASTORE_SECURITY_CONTRACT,
  DataStoreAuthorizationError,
  DataStoreTransactionError,
  FakeDataStore,
  PaginationError,
  utcRange,
  type ActorContext,
  type DataStoreTransaction,
  type Page,
} from '../api/_lib/data/index.js'

const member: ActorContext = {
  kind: 'user',
  actorId: 'user-1',
  tenantId: 'tenant-a',
  role: 'member',
}

const admin: ActorContext = {
  kind: 'user',
  actorId: 'admin-1',
  tenantId: 'tenant-a',
  role: 'admin',
}

describe('DataStore contract', () => {
  it('keeps execution server-owned and non-owner/non-bypass by contract', () => {
    const store = new FakeDataStore()

    expect(store.security).toEqual(DATASTORE_SECURITY_CONTRACT)
    expect(store.security.execution).toBe('server-runtime')
    expect(store.security.owner).toBe(false)
    expect(store.security.bypassRowSecurity).toBe(false)
  })

  it('normalizes offset timestamps and applies a half-open UTC range', async () => {
    const store = new FakeDataStore()
    const rows = [
      { id: 'before', occurredAt: asUtcTimestamp('2026-07-31T20:59:59Z') },
      { id: 'first', occurredAt: asUtcTimestamp('2026-07-31T21:00:00Z') },
      { id: 'last', occurredAt: asUtcTimestamp('2026-07-31T22:59:59Z') },
      { id: 'boundary', occurredAt: asUtcTimestamp('2026-07-31T23:00:00Z') },
    ]
    store.registerQuery('events.list', ({ range }) => {
      const from = range?.fromInclusive
        ? Date.parse(range.fromInclusive)
        : Number.NEGATIVE_INFINITY
      const to = range?.toExclusive
        ? Date.parse(range.toExclusive)
        : Number.POSITIVE_INFINITY
      return rows.filter((row) => {
        const occurredAt = Date.parse(row.occurredAt)
        return occurredAt >= from && occurredAt < to
      })
    })

    const page = await store.query<{ id: string; occurredAt: string }>(member, {
      operation: 'events.list',
      range: utcRange(
        '2026-07-31T23:00:00+02:00',
        '2026-08-01T01:00:00+02:00',
      ),
      page: { limit: 10 },
    })

    expect(page.items.map((row) => row.id)).toEqual(['first', 'last'])
    expect(page.nextCursor).toBeNull()
    expect(utcRange('2026-07-31T23:00:00+02:00')).toEqual({
      fromInclusive: '2026-07-31T21:00:00.000Z',
      toExclusive: undefined,
    })
  })

  it('rejects non-UTC instants and inverted ranges', () => {
    expect(() => asUtcTimestamp('2026-07-31 23:00:00')).toThrow(
      'ISO-8601 instant',
    )
    expect(() => utcRange('2026-08-01T00:00:00Z', '2026-07-31T23:00:00Z')).toThrow(
      'fromInclusive to be before toExclusive',
    )
  })

  it('paginates with stable opaque cursors without duplicates or gaps', async () => {
    const store = new FakeDataStore()
    const rows = Array.from({ length: 205 }, (_, id) => ({ id }))
    store.registerQuery('items.list', () => rows)

    const received: number[] = []
    let cursor: string | null = null
    let pageCount = 0
    do {
      const page: Page<{ id: number }> = await store.query<{ id: number }>(member, {
        operation: 'items.list',
        page: { limit: 100, cursor },
      })
      received.push(...page.items.map((row) => row.id))
      cursor = page.nextCursor
      pageCount += 1
      if (pageCount === 1) expect(page.items).toHaveLength(100)
      if (pageCount === 2) expect(page.items).toHaveLength(100)
      if (pageCount === 3) expect(page.items).toHaveLength(5)
    } while (cursor !== null)

    expect(pageCount).toBe(3)
    expect(received).toEqual(rows.map((row) => row.id))
    expect(new Set(received).size).toBe(205)
  })

  it('rejects invalid page sizes and cursors from a different actor scope', async () => {
    const store = new FakeDataStore()
    store.registerQuery('items.list', () => [{ id: 1 }, { id: 2 }])

    await expect(
      store.query(member, { operation: 'items.list', page: { limit: 0 } }),
    ).rejects.toBeInstanceOf(PaginationError)

    const first = await store.query<{ id: number }>(member, {
      operation: 'items.list',
      page: { limit: 1 },
    })
    const otherActor: ActorContext = {
      ...member,
      actorId: 'user-2',
    }
    await expect(
      store.query(otherActor, {
        operation: 'items.list',
        page: { limit: 1, cursor: first.nextCursor },
      }),
    ).rejects.toBeInstanceOf(PaginationError)
    await expect(
      store.query(member, {
        operation: 'items.list',
        params: { filter: 'changed' },
        page: { limit: 1, cursor: first.nextCursor },
      }),
    ).rejects.toBeInstanceOf(PaginationError)
  })

  it('requires a valid actor and lets each operation enforce its authorization', async () => {
    const store = new FakeDataStore()
    store.registerQuery(
      'admin.audit',
      ({ actor }) => [{ actorId: actor.actorId }],
      (actor) => {
        if (actor.role !== 'admin') {
          throw new DataStoreAuthorizationError('Admin actor required')
        }
      },
    )

    await expect(
      store.query(undefined as unknown as ActorContext, {
        operation: 'admin.audit',
      }),
    ).rejects.toBeInstanceOf(ActorContextError)
    await expect(
      store.query(member, { operation: 'admin.audit' }),
    ).rejects.toBeInstanceOf(DataStoreAuthorizationError)
    await expect(
      store.query<{ actorId: string }>(admin, { operation: 'admin.audit' }),
    ).resolves.toMatchObject({ items: [{ actorId: 'admin-1' }] })

    const invalidActor = {
      kind: 'user',
      actorId: 'user-1',
      tenantId: 'tenant-a',
      role: 'machine',
    } as unknown as ActorContext
    await expect(
      store.query(invalidActor, { operation: 'admin.audit' }),
    ).rejects.toBeInstanceOf(ActorContextError)
  })

  it('passes actor context into transactions and commits successful work', async () => {
    const store = new FakeDataStore({ balance: 10 })
    store.registerCommand<number, { amount: number }>(
      'balance.increment',
      ({ params, state }) => {
        const amount = params?.amount ?? 0
        const balance = state.read<number>('balance') ?? 0
        state.write('balance', balance + amount)
        return balance + amount
      },
    )
    store.registerQuery('balance.read', ({ state }) => [
      { balance: state.read<number>('balance') ?? 0 },
    ])

    const seenActors: ActorContext[] = []
    const result = await store.transaction(admin, async (transaction) => {
      seenActors.push(transaction.actor)
      await transaction.execute<{ balance: number }, { amount: number }>({
        operation: 'balance.increment',
        params: { amount: 5 },
      })
      const page = await transaction.query<{ balance: number }>({
        operation: 'balance.read',
      })
      return page.items[0]?.balance
    })

    expect(result).toBe(15)
    expect(seenActors).toEqual([admin])
    await expect(
      store.query<{ balance: number }>(admin, { operation: 'balance.read' }),
    ).resolves.toMatchObject({ items: [{ balance: 15 }] })
  })

  it('rolls back every transaction mutation when work or a command fails', async () => {
    const store = new FakeDataStore({ balance: 10 })
    store.registerCommand<void, { amount: number }>(
      'balance.increment',
      ({ params, state }) => {
        const balance = state.read<number>('balance') ?? 0
        state.write('balance', balance + (params?.amount ?? 0))
      },
    )
    store.registerCommand('balance.fail', ({ state }) => {
      state.write('balance', 999)
      throw new Error('simulated datastore failure')
    })
    store.registerQuery('balance.read', ({ state }) => [
      { balance: state.read<number>('balance') ?? 0 },
    ])

    await expect(
      store.transaction(member, async (transaction) => {
        await transaction.execute({
          operation: 'balance.increment',
          params: { amount: 5 },
        })
        throw new Error('caller failure')
      }),
    ).rejects.toThrow('caller failure')

    await expect(
      store.query<{ balance: number }>(member, { operation: 'balance.read' }),
    ).resolves.toMatchObject({ items: [{ balance: 10 }] })

    await expect(
      store.transaction(member, async (transaction) => {
        await transaction.execute({ operation: 'balance.fail' })
      }),
    ).rejects.toThrow('simulated datastore failure')
    await expect(
      store.query<{ balance: number }>(member, { operation: 'balance.read' }),
    ).resolves.toMatchObject({ items: [{ balance: 10 }] })
  })

  it('does not permit nested or post-transaction use', async () => {
    const store = new FakeDataStore()
    const getTransaction = async (): Promise<DataStoreTransaction> => {
      let captured: DataStoreTransaction | undefined
      await store.transaction(member, async (transaction) => {
        captured = transaction
      })
      if (!captured) throw new Error('transaction was not captured')
      return captured
    }

    const transactionRef = await getTransaction()
    await expect(
      transactionRef.query({ operation: 'anything' }),
    ).rejects.toBeInstanceOf(DataStoreTransactionError)
    await expect(
      store.transaction(member, () =>
        store.transaction(member, async () => 'nested'),
      ),
    ).rejects.toBeInstanceOf(DataStoreTransactionError)
  })
})
