/**
 * The S03 `DataStore` contract suite, written once.
 *
 * Both the in-memory `FakeDataStore` and the Neon adapter are driven through
 * *these* test bodies. Nothing here knows which implementation it is talking
 * to: a harness supplies a store whose allowlist implements the operation
 * semantics documented below, plus an out-of-band channel used to verify that
 * a rolled-back transaction really left nothing behind.
 *
 * Operation semantics a harness must provide:
 *
 * | operation                 | kind    | semantics                                                        |
 * |---------------------------|---------|------------------------------------------------------------------|
 * | `contract.actor.self`     | query   | the current actor's own identity row, or no rows if it fails closed |
 * | `contract.records.range`  | query   | fixture records with `occurredAt`, half-open `[from, to)` filter, ordered |
 * | `contract.records.page`   | query   | `PAGE_FIXTURE_SIZE` records `{ seq }`, ordered ascending from 1    |
 * | `contract.records.admin`  | query   | same rows as `contract.actor.self`, refused unless the actor is an admin |
 * | `contract.notes.count`    | query   | one row `{ count }` of notes written by this suite                 |
 * | `contract.notes.insert`   | command | insert one note, resolve with the number of rows written           |
 * | `contract.command.fail`   | command | always fail, without writing anything itself                       |
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  ActorContextError,
  asUtcTimestamp,
  DATASTORE_SECURITY_CONTRACT,
  DataStoreAuthorizationError,
  DataStoreTransactionError,
  MAX_PAGE_SIZE,
  PaginationError,
  utcRange,
  type ActorContext,
  type DataStore,
  type DataStoreTransaction,
  type Page,
} from '../../api/_lib/data/index.js'

export const CONTRACT_OPERATIONS = {
  actorSelf: 'contract.actor.self',
  recordsRange: 'contract.records.range',
  recordsPage: 'contract.records.page',
  recordsAdmin: 'contract.records.admin',
  notesCount: 'contract.notes.count',
  notesInsert: 'contract.notes.insert',
  commandFail: 'contract.command.fail',
} as const

/** Namespacing for every row this suite creates in a real database. */
export const CONTRACT_SCOPE = 's11-contract'
export const RANGE_EVENT_TYPE = 's11_contract_range'
export const PAGE_EVENT_TYPE = 's11_contract_page'

/**
 * Deliberately more than twice the 1000-row page cap, so a full walk needs
 * three pages and the last one is short.
 */
export const PAGE_FIXTURE_SIZE = 2_500

export interface RangeFixtureRow {
  readonly key: string
  readonly occurredAt: string
}

/**
 * Instants chosen so that a range expressed in a non-UTC offset selects
 * exactly the two middle rows: `[21:00Z, 23:00Z)`.
 */
export const RANGE_FIXTURE: readonly RangeFixtureRow[] = [
  { key: 'before', occurredAt: '2026-07-31T20:59:59.000Z' },
  { key: 'first', occurredAt: '2026-07-31T21:00:00.000Z' },
  { key: 'last', occurredAt: '2026-07-31T22:59:59.000Z' },
  { key: 'boundary', occurredAt: '2026-07-31T23:00:00.000Z' },
]

export interface ContractActors {
  /** Exists, is active, is an active team member. Reads and writes. */
  readonly activeMember: ActorContext
  /** As above, with the admin role. */
  readonly activeAdmin: ActorContext
  /** Exists but is inactive. Must fail closed. */
  readonly inactive: ActorContext
  /** Well-formed identifier that matches no row. Must fail closed. */
  readonly unknown: ActorContext
  /** Non-empty but not a canonical identifier. Must fail closed. */
  readonly malformed: ActorContext
}

/**
 * The same actor identities are used against both implementations, so a parity
 * failure cannot hide behind different inputs. They match the identity fixture
 * rows in `postgres/tests/portable_identity_roles_rls_fixture_seed.sql`.
 */
export const CONTRACT_ACTORS: ContractActors = {
  activeMember: {
    kind: 'user',
    actorId: '00000000-0000-0000-0000-000000000001',
    tenantId: 'tenant-a',
    role: 'member',
  },
  activeAdmin: {
    kind: 'user',
    actorId: '00000000-0000-0000-0000-000000000002',
    tenantId: 'tenant-a',
    role: 'admin',
  },
  inactive: {
    kind: 'user',
    actorId: '00000000-0000-0000-0000-000000000003',
    tenantId: 'tenant-a',
    role: 'member',
  },
  unknown: {
    kind: 'user',
    actorId: '00000000-0000-0000-0000-0000000000ff',
    tenantId: 'tenant-a',
    role: 'member',
  },
  malformed: {
    kind: 'user',
    actorId: 'not-a-canonical-identifier',
    tenantId: 'tenant-a',
    role: 'member',
  },
}

export interface DataStoreContractHarness {
  readonly name: string
  readonly store: DataStore
  readonly actors: ContractActors
  /**
   * Count notes without going through the store under test. Rollback
   * assertions depend on an independent channel: a store that both wrote and
   * reported the write could hide a partial commit from itself.
   */
  countNotesOutOfBand(): Promise<number>
  /** Return the notes table to empty. */
  resetNotes(): Promise<void>
  dispose(): Promise<void>
}

interface SeqRow {
  readonly seq: number
}

interface ActorRow {
  readonly actorId: string
}

interface CountRow {
  readonly count: number
}

export function runDataStoreContractSuite(
  label: string,
  createHarness: () => Promise<DataStoreContractHarness>,
): void {
  describe(`DataStore contract — ${label}`, () => {
    let harness: DataStoreContractHarness
    let store: DataStore
    let actors: ContractActors

    beforeAll(async () => {
      harness = await createHarness()
      store = harness.store
      actors = harness.actors
    })

    afterAll(async () => {
      await harness?.dispose()
    })

    beforeEach(async () => {
      await harness.resetNotes()
    })

    it('keeps execution server-owned and non-owner/non-bypass by contract', () => {
      expect(store.security).toEqual(DATASTORE_SECURITY_CONTRACT)
      expect(store.security.execution).toBe('server-runtime')
      expect(store.security.owner).toBe(false)
      expect(store.security.bypassRowSecurity).toBe(false)
    })

    it('normalizes offset timestamps and applies a half-open UTC range', async () => {
      const page = await store.query<RangeFixtureRow>(actors.activeMember, {
        operation: CONTRACT_OPERATIONS.recordsRange,
        // 23:00+02:00 is 21:00Z; 01:00+02:00 the next day is 23:00Z.
        range: utcRange('2026-07-31T23:00:00+02:00', '2026-08-01T01:00:00+02:00'),
        page: { limit: 10 },
      })

      expect(page.items.map((row) => row.key)).toEqual(['first', 'last'])
      expect(page.hasMore).toBe(false)
      expect(page.nextCursor).toBeNull()
    })

    it('returns instants as ISO-8601 UTC strings regardless of the process time zone', async () => {
      const page = await store.query<RangeFixtureRow>(actors.activeMember, {
        operation: CONTRACT_OPERATIONS.recordsRange,
        page: { limit: 10 },
      })

      const byKey = new Map(page.items.map((row) => [row.key, row.occurredAt]))
      for (const fixture of RANGE_FIXTURE) {
        const actual = byKey.get(fixture.key)
        expect(typeof actual).toBe('string')
        expect(actual).toMatch(/Z$/)
        // Identical instant *and* identical spelling, so no adapter can drift
        // into a local-time or offset-bearing representation.
        expect(actual).toBe(fixture.occurredAt)
        expect(asUtcTimestamp(actual as string)).toBe(fixture.occurredAt)
      }
    })

    it('rejects non-UTC instants and inverted ranges', () => {
      expect(() => asUtcTimestamp('2026-07-31 23:00:00')).toThrow(
        'ISO-8601 instant',
      )
      expect(() =>
        utcRange('2026-08-01T00:00:00Z', '2026-07-31T23:00:00Z'),
      ).toThrow('fromInclusive to be before toExclusive')
    })

    it('paginates past the 1000-row cap with stable cursors, no duplicates and no gaps', async () => {
      const received: number[] = []
      const pageSizes: number[] = []
      let cursor: string | null = null
      let guard = 0

      do {
        const page: Page<SeqRow> = await store.query<SeqRow>(
          actors.activeMember,
          {
            operation: CONTRACT_OPERATIONS.recordsPage,
            page: { limit: MAX_PAGE_SIZE, cursor },
          },
        )
        received.push(...page.items.map((row) => row.seq))
        pageSizes.push(page.items.length)
        expect(page.hasMore).toBe(page.nextCursor !== null)
        cursor = page.nextCursor
        guard += 1
        expect(guard).toBeLessThan(10)
      } while (cursor !== null)

      expect(pageSizes).toEqual([
        MAX_PAGE_SIZE,
        MAX_PAGE_SIZE,
        PAGE_FIXTURE_SIZE - 2 * MAX_PAGE_SIZE,
      ])
      expect(received).toHaveLength(PAGE_FIXTURE_SIZE)
      expect(new Set(received).size).toBe(PAGE_FIXTURE_SIZE)
      expect(received).toEqual(
        Array.from({ length: PAGE_FIXTURE_SIZE }, (_, index) => index + 1),
      )
    })

    it('rejects invalid page sizes', async () => {
      await expect(
        store.query(actors.activeMember, {
          operation: CONTRACT_OPERATIONS.recordsPage,
          page: { limit: 0 },
        }),
      ).rejects.toBeInstanceOf(PaginationError)

      await expect(
        store.query(actors.activeMember, {
          operation: CONTRACT_OPERATIONS.recordsPage,
          page: { limit: MAX_PAGE_SIZE + 1 },
        }),
      ).rejects.toBeInstanceOf(PaginationError)
    })

    it('refuses a cursor from a different actor or a different query scope', async () => {
      const first = await store.query<SeqRow>(actors.activeMember, {
        operation: CONTRACT_OPERATIONS.recordsPage,
        page: { limit: 1 },
      })
      expect(first.nextCursor).not.toBeNull()

      await expect(
        store.query(actors.activeAdmin, {
          operation: CONTRACT_OPERATIONS.recordsPage,
          page: { limit: 1, cursor: first.nextCursor },
        }),
      ).rejects.toBeInstanceOf(PaginationError)

      await expect(
        store.query(actors.activeMember, {
          operation: CONTRACT_OPERATIONS.recordsPage,
          params: { filter: 'changed' },
          page: { limit: 1, cursor: first.nextCursor },
        }),
      ).rejects.toBeInstanceOf(PaginationError)

      await expect(
        store.query(actors.activeMember, {
          operation: CONTRACT_OPERATIONS.recordsRange,
          page: { limit: 1, cursor: first.nextCursor },
        }),
      ).rejects.toBeInstanceOf(PaginationError)
    })

    it('emits opaque cursors that leak no operation name, parameter or identifier', async () => {
      const first = await store.query<SeqRow>(actors.activeMember, {
        operation: CONTRACT_OPERATIONS.recordsPage,
        page: { limit: 1 },
      })
      const cursor = first.nextCursor as string

      expect(typeof cursor).toBe('string')
      expect(cursor.length).toBeGreaterThan(0)
      expect(cursor).not.toContain(CONTRACT_OPERATIONS.recordsPage)
      expect(cursor).not.toContain(actors.activeMember.actorId)
      expect(cursor).not.toContain(actors.activeMember.tenantId)
    })

    it('requires an actor context at the boundary', async () => {
      await expect(
        store.query(undefined as unknown as ActorContext, {
          operation: CONTRACT_OPERATIONS.actorSelf,
        }),
      ).rejects.toBeInstanceOf(ActorContextError)

      await expect(
        store.query(
          { ...actors.activeMember, actorId: '  ' } as ActorContext,
          { operation: CONTRACT_OPERATIONS.actorSelf },
        ),
      ).rejects.toBeInstanceOf(ActorContextError)

      await expect(
        store.query(
          {
            kind: 'user',
            actorId: actors.activeMember.actorId,
            tenantId: actors.activeMember.tenantId,
            role: 'machine',
          } as unknown as ActorContext,
          { operation: CONTRACT_OPERATIONS.actorSelf },
        ),
      ).rejects.toBeInstanceOf(ActorContextError)
    })

    it('lets a valid active actor read its own row', async () => {
      const page = await store.query<ActorRow>(actors.activeMember, {
        operation: CONTRACT_OPERATIONS.actorSelf,
      })
      expect(page.items).toEqual([{ actorId: actors.activeMember.actorId }])
    })

    it('fails an unknown, malformed or inactive actor closed on read', async () => {
      for (const actor of [actors.unknown, actors.malformed, actors.inactive]) {
        const page = await store.query<ActorRow>(actor, {
          operation: CONTRACT_OPERATIONS.actorSelf,
        })
        expect(page.items).toEqual([])
        expect(page.hasMore).toBe(false)
        expect(page.nextCursor).toBeNull()
      }
    })

    it('lets a valid active actor write, and fails every other actor closed on write', async () => {
      await store.transaction(actors.activeMember, async (transaction) => {
        await transaction.execute({
          operation: CONTRACT_OPERATIONS.notesInsert,
          params: { note: 'written by an active member' },
        })
      })
      expect(await harness.countNotesOutOfBand()).toBe(1)

      for (const actor of [actors.unknown, actors.malformed, actors.inactive]) {
        await expect(
          store.transaction(actor, async (transaction) => {
            await transaction.execute({
              operation: CONTRACT_OPERATIONS.notesInsert,
              params: { note: `written by ${actor.actorId}` },
            })
          }),
        ).rejects.toBeInstanceOf(DataStoreAuthorizationError)
      }

      // The denied writes left nothing behind.
      expect(await harness.countNotesOutOfBand()).toBe(1)
    })

    it('lets each operation enforce its own authorization on top of the database', async () => {
      await expect(
        store.query(actors.activeMember, {
          operation: CONTRACT_OPERATIONS.recordsAdmin,
        }),
      ).rejects.toBeInstanceOf(DataStoreAuthorizationError)

      await expect(
        store.query<ActorRow>(actors.activeAdmin, {
          operation: CONTRACT_OPERATIONS.recordsAdmin,
        }),
      ).resolves.toMatchObject({
        items: [{ actorId: actors.activeAdmin.actorId }],
      })
    })

    it('refuses an operation that is not allowlisted', async () => {
      await expect(
        store.query(actors.activeMember, { operation: 'contract.not.registered' }),
      ).rejects.toBeInstanceOf(DataStoreAuthorizationError)

      await expect(
        store.transaction(actors.activeMember, (transaction) =>
          transaction.execute({ operation: 'contract.not.registered' }),
        ),
      ).rejects.toBeInstanceOf(DataStoreAuthorizationError)
    })

    it('passes the actor into the transaction and commits successful work', async () => {
      const seenActors: ActorContext[] = []

      const committed = await store.transaction(
        actors.activeMember,
        async (transaction) => {
          seenActors.push(transaction.actor)
          await transaction.execute({
            operation: CONTRACT_OPERATIONS.notesInsert,
            params: { note: 'first committed note' },
          })
          await transaction.execute({
            operation: CONTRACT_OPERATIONS.notesInsert,
            params: { note: 'second committed note' },
          })
          const page = await transaction.query<CountRow>({
            operation: CONTRACT_OPERATIONS.notesCount,
          })
          return page.items[0]?.count
        },
      )

      // Reads inside the transaction see the transaction's own writes.
      expect(committed).toBe(2)
      expect(seenActors).toEqual([actors.activeMember])
      expect(await harness.countNotesOutOfBand()).toBe(2)
    })

    it('rolls back every mutation when the caller throws', async () => {
      const rejection = store.transaction(
        actors.activeMember,
        async (transaction) => {
          await transaction.execute({
            operation: CONTRACT_OPERATIONS.notesInsert,
            params: { note: 'note that must not survive' },
          })
          throw new Error('caller failure')
        },
      )

      await expect(rejection).rejects.toBeInstanceOf(DataStoreTransactionError)
      await expect(rejection).rejects.toThrow('caller failure')
      expect(await harness.countNotesOutOfBand()).toBe(0)
    })

    it('rolls back every mutation when a command throws mid-transaction', async () => {
      const rejection = store.transaction(
        actors.activeMember,
        async (transaction) => {
          await transaction.execute({
            operation: CONTRACT_OPERATIONS.notesInsert,
            params: { note: 'note written before the failing command' },
          })
          await transaction.execute({
            operation: CONTRACT_OPERATIONS.commandFail,
          })
          throw new Error('unreachable: the failing command must reject')
        },
      )

      await expect(rejection).rejects.toBeInstanceOf(DataStoreTransactionError)
      // No partial write: the successful command before the failure is gone.
      expect(await harness.countNotesOutOfBand()).toBe(0)
    })

    it('keeps working after a failed transaction', async () => {
      await expect(
        store.transaction(actors.activeMember, async (transaction) => {
          await transaction.execute({ operation: CONTRACT_OPERATIONS.commandFail })
        }),
      ).rejects.toBeInstanceOf(DataStoreTransactionError)

      await store.transaction(actors.activeMember, async (transaction) => {
        await transaction.execute({
          operation: CONTRACT_OPERATIONS.notesInsert,
          params: { note: 'written after a failed transaction' },
        })
      })

      expect(await harness.countNotesOutOfBand()).toBe(1)
    })

    it('does not permit nested or post-transaction use', async () => {
      let captured: DataStoreTransaction | undefined
      await store.transaction(actors.activeMember, async (transaction) => {
        captured = transaction
      })
      if (!captured) throw new Error('transaction was not captured')

      await expect(
        captured.query({ operation: CONTRACT_OPERATIONS.notesCount }),
      ).rejects.toBeInstanceOf(DataStoreTransactionError)
      await expect(
        captured.execute({
          operation: CONTRACT_OPERATIONS.notesInsert,
          params: { note: 'after close' },
        }),
      ).rejects.toBeInstanceOf(DataStoreTransactionError)

      await expect(
        store.transaction(actors.activeMember, () =>
          store.transaction(actors.activeMember, async () => 'nested'),
        ),
      ).rejects.toBeInstanceOf(DataStoreTransactionError)

      expect(await harness.countNotesOutOfBand()).toBe(0)
    })
  })
}
