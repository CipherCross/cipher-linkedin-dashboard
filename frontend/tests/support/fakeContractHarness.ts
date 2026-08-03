/**
 * Fake-backed harness for the shared `DataStore` contract suite.
 *
 * It models exactly the operation semantics documented in
 * `dataStoreContract.ts` — including failing closed for unknown, malformed and
 * inactive actors, which a real deployment gets from row-level security.
 */

import {
  DataStoreAuthorizationError,
  FakeDataStore,
  type ActorContext,
} from '../../api/_lib/data/index.js'

import {
  CONTRACT_ACTORS,
  CONTRACT_OPERATIONS,
  PAGE_FIXTURE_SIZE,
  RANGE_FIXTURE,
  type DataStoreContractHarness,
} from './dataStoreContract.js'

const NOTES_KEY = 'contract.notes'

/** Mirrors the fixture rows seeded into `public.users`/`public.team_members`. */
const ACTIVE_ACTOR_IDS = new Set([
  CONTRACT_ACTORS.activeMember.actorId,
  CONTRACT_ACTORS.activeAdmin.actorId,
])

function isActive(actor: ActorContext): boolean {
  return ACTIVE_ACTOR_IDS.has(actor.actorId)
}

const PAGE_ROWS = Object.freeze(
  Array.from({ length: PAGE_FIXTURE_SIZE }, (_, index) => ({
    seq: index + 1,
  })),
)

export async function createFakeContractHarness(): Promise<DataStoreContractHarness> {
  const store = new FakeDataStore({ [NOTES_KEY]: [] as string[] })

  // Reads: the row set an actor can see, exactly as RLS would decide it.
  store.registerQuery(CONTRACT_OPERATIONS.actorSelf, ({ actor }) =>
    isActive(actor) ? [{ actorId: actor.actorId }] : [],
  )

  store.registerQuery(
    CONTRACT_OPERATIONS.recordsAdmin,
    ({ actor }) => (isActive(actor) ? [{ actorId: actor.actorId }] : []),
    (actor) => {
      if (actor.role !== 'admin') {
        throw new DataStoreAuthorizationError('Admin actor required')
      }
    },
  )

  store.registerQuery(CONTRACT_OPERATIONS.recordsRange, ({ actor, range }) => {
    if (!isActive(actor)) return []
    const from = range?.fromInclusive
      ? Date.parse(range.fromInclusive)
      : Number.NEGATIVE_INFINITY
    const to = range?.toExclusive
      ? Date.parse(range.toExclusive)
      : Number.POSITIVE_INFINITY
    return RANGE_FIXTURE.filter((row) => {
      const occurredAt = Date.parse(row.occurredAt)
      return occurredAt >= from && occurredAt < to
    }).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
  })

  store.registerQuery(CONTRACT_OPERATIONS.recordsPage, ({ actor }) =>
    isActive(actor) ? PAGE_ROWS : [],
  )

  store.registerQuery(CONTRACT_OPERATIONS.notesCount, ({ actor, state }) => [
    { count: isActive(actor) ? (state.read<string[]>(NOTES_KEY) ?? []).length : 0 },
  ])

  // Writes: the fake raises the same authorization error the database raises
  // through a WITH CHECK violation.
  store.registerCommand<number, { note: string }>(
    CONTRACT_OPERATIONS.notesInsert,
    ({ actor, params, state }) => {
      if (!isActive(actor)) {
        throw new DataStoreAuthorizationError(
          'Insert was denied by row-level authorization',
        )
      }
      const notes = [...(state.read<string[]>(NOTES_KEY) ?? [])]
      notes.push(params?.note ?? '')
      state.write(NOTES_KEY, notes)
      return 1
    },
  )

  store.registerCommand(CONTRACT_OPERATIONS.commandFail, () => {
    throw new Error('simulated datastore command failure')
  })

  return {
    name: 'FakeDataStore',
    store,
    actors: CONTRACT_ACTORS,
    async countNotesOutOfBand() {
      // Independent of the store's query path: reads committed state directly.
      return (store.read<string[]>(NOTES_KEY) ?? []).length
    },
    async resetNotes() {
      store.seed(NOTES_KEY, [])
    },
    async dispose() {
      /* nothing to release */
    },
  }
}
