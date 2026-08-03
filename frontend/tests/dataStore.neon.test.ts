/**
 * The S03 contract suite against the real Neon project, plus the assertions
 * that only mean something against a real provider: that the actor context
 * cannot leak across pooled connections, that every transaction arms a
 * statement timeout (risk R3), and that the connection pool survives failure.
 *
 * There is no fallback and no skip. If the server-only credential is absent
 * this file fails at import with an actionable message.
 */

import pgDefault from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DataStoreAuthorizationError,
  DataStoreTransactionError,
} from '../api/_lib/data/index.js'
import {
  NeonDataStore,
  NeonOperationRegistry,
} from '../api/_lib/data/neon.js'
import {
  CONTRACT_ACTORS,
  runDataStoreContractSuite,
} from './support/dataStoreContract.js'
import {
  createNeonContractHarness,
  NeonFixtureClient,
  requireNeonTestConnection,
} from './support/neonContractHarness.js'

const { Client } = pgDefault

// Fail closed at import time rather than inside a test, so a missing
// credential can never be mistaken for a suite that ran and passed.
const connection = requireNeonTestConnection()

const STATEMENT_TIMEOUT_MS = 1_500

interface SessionRow {
  readonly actorId: string
  readonly statementTimeoutMs: number
  readonly timezone: string
  readonly backendPid: number
  readonly roleName: string
  readonly superuser: boolean
  readonly bypassRls: boolean
  readonly rowSecurity: string
}

/**
 * Diagnostics live in their own allowlist: they observe the session the driver
 * establishes, and they have no business being reachable from the contract
 * registry the application will eventually use.
 */
function buildDiagnosticsRegistry(): NeonOperationRegistry {
  const registry = new NeonOperationRegistry()

  registry.registerQuery('diag.session', {
    build: () => ({
      text: `SELECT coalesce(current_setting('app.actor_id', true), '') AS actor_id,
                    (extract(epoch FROM current_setting('statement_timeout')::interval) * 1000)::bigint AS statement_timeout_ms,
                    current_setting('TimeZone') AS timezone,
                    pg_backend_pid() AS backend_pid,
                    current_user::text AS role_name,
                    r.rolsuper AS superuser,
                    r.rolbypassrls AS bypass_rls,
                    current_setting('row_security') AS row_security
               FROM pg_roles r
              WHERE r.rolname = CURRENT_USER`,
      values: [],
    }),
    mapRow: (row): SessionRow => ({
      actorId: String(row.actor_id),
      statementTimeoutMs: Number(row.statement_timeout_ms),
      timezone: String(row.timezone),
      backendPid: Number(row.backend_pid),
      roleName: String(row.role_name),
      superuser: Boolean(row.superuser),
      bypassRls: Boolean(row.bypass_rls),
      rowSecurity: String(row.row_security),
    }),
  })

  registry.registerQuery('diag.sleep', {
    build: ({ params }) => ({
      text: 'SELECT pg_sleep($1::float8) IS NOT NULL AS slept',
      values: [params?.seconds ?? 1],
    }),
    mapRow: (row) => ({ slept: Boolean(row.slept) }),
  })

  registry.registerCommand('diag.noop', {
    build: () => ({ text: 'SELECT 1 AS ok', values: [] }),
    mapResult: (_rows, rowCount) => rowCount,
  })

  registry.registerCommand('diag.fail', {
    build: () => ({ text: 'SELECT 1 / (SELECT 0)::int AS boom', values: [] }),
  })

  return registry
}

function createDiagnosticStore(options: {
  connectionString: string
  maxConnections?: number
  statementTimeoutMs?: number
}): NeonDataStore {
  return new NeonDataStore({
    connectionString: options.connectionString,
    operations: buildDiagnosticsRegistry(),
    maxConnections: options.maxConnections ?? 1,
    statementTimeoutMs: options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS,
    applicationName: 'lh2-datastore-diagnostics',
  })
}

async function readSession(
  store: NeonDataStore,
  actor = CONTRACT_ACTORS.activeMember,
): Promise<SessionRow> {
  const page = await store.query<SessionRow>(actor, { operation: 'diag.session' })
  const row = page.items[0]
  if (!row) throw new Error('diag.session returned no row')
  return row
}

// ---------------------------------------------------------------------------
// The provider-neutral contract suite, same bodies as the fake.
// ---------------------------------------------------------------------------

runDataStoreContractSuite('NeonDataStore (real Neon project)', createNeonContractHarness)

// ---------------------------------------------------------------------------
// Provider-specific evidence.
// ---------------------------------------------------------------------------

describe('Neon driver — session, actor context and R3', () => {
  let store: NeonDataStore

  beforeAll(() => {
    store = createDiagnosticStore({ connectionString: connection.pooled })
  })

  afterAll(async () => {
    await store?.close()
  })

  it('runs as a least-privilege principal that cannot bypass row-level security', async () => {
    const session = await readSession(store)

    expect(session.superuser).toBe(false)
    expect(session.bypassRls).toBe(false)
    expect(session.rowSecurity).toBe('on')
    // Corroborates the contract the store advertises.
    expect(store.security.owner).toBe(false)
    expect(store.security.bypassRowSecurity).toBe(false)
  })

  it('publishes the actor to the database and forces UTC date semantics', async () => {
    const session = await readSession(store, CONTRACT_ACTORS.activeAdmin)

    expect(session.actorId).toBe(CONTRACT_ACTORS.activeAdmin.actorId)
    expect(session.timezone).toBe('UTC')
  })

  it('arms SET LOCAL statement_timeout in every transaction (R3)', async () => {
    // The exact configured value, read back from inside the transaction.
    const fromQuery = await readSession(store)
    expect(fromQuery.statementTimeoutMs).toBe(STATEMENT_TIMEOUT_MS)

    // ...and in an explicit read-write transaction, not just the read path.
    const fromTransaction = await store.transaction(
      CONTRACT_ACTORS.activeMember,
      async (transaction) => {
        const page = await transaction.query<SessionRow>({
          operation: 'diag.session',
        })
        return page.items[0]
      },
    )
    expect(fromTransaction?.statementTimeoutMs).toBe(STATEMENT_TIMEOUT_MS)
  })

  it('actually aborts a statement that exceeds the armed timeout', async () => {
    // Not an assumption about configuration: the guard is exercised. The
    // timeout must already be armed when the long statement *begins*, because
    // PostgreSQL cannot abort a call that is already in flight.
    const startedAt = Date.now()
    const rejection = store.query(CONTRACT_ACTORS.activeMember, {
      operation: 'diag.sleep',
      params: { seconds: 30 },
    })

    await expect(rejection).rejects.toBeInstanceOf(DataStoreTransactionError)
    await expect(rejection).rejects.toThrow('statement timeout')

    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(STATEMENT_TIMEOUT_MS - 250)
    // Aborted at the timeout, nowhere near the 30s the statement asked for.
    expect(elapsed).toBeLessThan(10_000)
  })

  it('leaves the pool usable after a timeout abort', async () => {
    const session = await readSession(store)
    expect(session.actorId).toBe(CONTRACT_ACTORS.activeMember.actorId)
    expect(store.poolStats.total).toBeLessThanOrEqual(1)
  })

  it('has no statement timeout on a session the driver did not open', async () => {
    // Proves the guard comes from the driver, not from a server default.
    const fixtures = new NeonFixtureClient(connection.pooled)
    try {
      const timeout = await fixtures.asActor(
        CONTRACT_ACTORS.activeMember.actorId,
        async (client) => {
          const result = await client.query<{ t: string }>(
            "SELECT current_setting('statement_timeout') AS t",
          )
          return result.rows[0]?.t
        },
      )
      expect(timeout).toBe('0')
    } finally {
      await fixtures.end()
    }
  })
})

describe('Neon driver — the actor context cannot leak between transactions', () => {
  it('gives each interleaved actor its own context on a single pooled connection', async () => {
    // maxConnections: 1 forces every transaction onto the same client-side
    // connection, which is the only way this test can prove anything.
    const store = createDiagnosticStore({
      connectionString: connection.pooled,
      maxConnections: 1,
    })
    try {
      const seen: string[] = []
      const order = [
        CONTRACT_ACTORS.activeMember,
        CONTRACT_ACTORS.activeAdmin,
        CONTRACT_ACTORS.activeMember,
        CONTRACT_ACTORS.activeAdmin,
      ]
      for (const actor of order) {
        const session = await readSession(store, actor)
        seen.push(session.actorId)
      }

      expect(seen).toEqual(order.map((actor) => actor.actorId))
      // One client-side connection served all four transactions.
      expect(store.poolStats.total).toBe(1)
    } finally {
      await store.close()
    }
  })

  it('does not let a transaction that failed leave its actor behind', async () => {
    const store = createDiagnosticStore({
      connectionString: connection.pooled,
      maxConnections: 1,
    })
    try {
      await expect(
        store.transaction(CONTRACT_ACTORS.activeAdmin, async (transaction) => {
          await transaction.execute({ operation: 'diag.fail' })
        }),
      ).rejects.toBeInstanceOf(DataStoreTransactionError)

      const next = await readSession(store, CONTRACT_ACTORS.activeMember)
      expect(next.actorId).toBe(CONTRACT_ACTORS.activeMember.actorId)
      expect(store.poolStats.total).toBe(1)
    } finally {
      await store.close()
    }
  })

  it('discards app.actor_id and statement_timeout at COMMIT on the very same backend', async () => {
    // The tightest form of the proof: one raw session, so the physical backend
    // is guaranteed to be reused, and pg_backend_pid() is asserted equal
    // across the transaction boundary. On the pooled endpoint PgBouncer may
    // hand the next transaction a different backend, which is why this
    // particular assertion uses the direct endpoint.
    const client = new Client({ connectionString: connection.direct })
    await client.connect()
    try {
      const before = await client.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )

      await client.query('BEGIN')
      await client.query(
        'SELECT set_config($1,$2,true), set_config($3,$4,true)',
        [
          'statement_timeout',
          String(STATEMENT_TIMEOUT_MS),
          'app.actor_id',
          CONTRACT_ACTORS.activeMember.actorId,
        ],
      )
      const inside = await client.query<{
        actor: string
        timeout: string
        pid: number
      }>(
        `SELECT coalesce(current_setting('app.actor_id', true), '') AS actor,
                current_setting('statement_timeout') AS timeout,
                pg_backend_pid() AS pid`,
      )
      await client.query('COMMIT')

      const after = await client.query<{
        actor: string
        timeout: string
        pid: number
      }>(
        `SELECT coalesce(current_setting('app.actor_id', true), '') AS actor,
                current_setting('statement_timeout') AS timeout,
                pg_backend_pid() AS pid`,
      )

      expect(inside.rows[0]?.actor).toBe(CONTRACT_ACTORS.activeMember.actorId)
      expect(inside.rows[0]?.timeout).not.toBe('0')

      // Same physical backend, before, during and after.
      expect(inside.rows[0]?.pid).toBe(before.rows[0]?.pid)
      expect(after.rows[0]?.pid).toBe(before.rows[0]?.pid)

      // And yet nothing survived the COMMIT.
      expect(after.rows[0]?.actor).toBe('')
      expect(after.rows[0]?.timeout).toBe('0')
    } finally {
      await client.end()
    }
  })

  it('confirms the same transaction scoping through the pooled endpoint', async () => {
    const client = new Client({ connectionString: connection.pooled })
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1,$2,true)', [
        'app.actor_id',
        CONTRACT_ACTORS.activeAdmin.actorId,
      ])
      const inside = await client.query<{ actor: string }>(
        "SELECT coalesce(current_setting('app.actor_id', true), '') AS actor",
      )
      await client.query('COMMIT')

      const after = await client.query<{ actor: string }>(
        "SELECT coalesce(current_setting('app.actor_id', true), '') AS actor",
      )

      expect(connection.pooledEndpointConfirmed).toBe(true)
      expect(inside.rows[0]?.actor).toBe(CONTRACT_ACTORS.activeAdmin.actorId)
      expect(after.rows[0]?.actor).toBe('')
    } finally {
      await client.end()
    }
  })
})

describe('Neon driver — connection lifecycle', () => {
  it('acquires and releases a connection per transaction', async () => {
    const store = createDiagnosticStore({
      connectionString: connection.pooled,
      maxConnections: 2,
    })
    try {
      expect(store.poolStats.total).toBe(0)

      await readSession(store)
      // Released, not leaked: the connection is idle in the pool afterwards.
      expect(store.poolStats.total).toBeGreaterThanOrEqual(1)
      expect(store.poolStats.idle).toBe(store.poolStats.total)
      expect(store.poolStats.waiting).toBe(0)

      await Promise.all(
        Array.from({ length: 8 }, () => readSession(store)),
      )
      expect(store.poolStats.total).toBeLessThanOrEqual(2)
      expect(store.poolStats.idle).toBe(store.poolStats.total)
      expect(store.poolStats.waiting).toBe(0)
    } finally {
      await store.close()
    }
  })

  it('returns a failed transaction connection to the pool instead of poisoning it', async () => {
    const store = createDiagnosticStore({
      connectionString: connection.pooled,
      maxConnections: 1,
    })
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          store.transaction(CONTRACT_ACTORS.activeMember, async (transaction) => {
            await transaction.execute({ operation: 'diag.noop' })
            await transaction.execute({ operation: 'diag.fail' })
          }),
        ).rejects.toBeInstanceOf(DataStoreTransactionError)
      }

      // Never grew past the ceiling, and never lost the one connection it had.
      expect(store.poolStats.total).toBe(1)
      expect(store.poolStats.idle).toBe(1)

      const session = await readSession(store)
      expect(session.actorId).toBe(CONTRACT_ACTORS.activeMember.actorId)
      expect(store.poolStats.total).toBe(1)
    } finally {
      await store.close()
    }
  })

  it('refuses work after the store is closed', async () => {
    const store = createDiagnosticStore({ connectionString: connection.pooled })
    await readSession(store)
    await store.close()

    await expect(
      store.query(CONTRACT_ACTORS.activeMember, { operation: 'diag.session' }),
    ).rejects.toThrow('Data store is closed')
    // Closing twice is safe.
    await expect(store.close()).resolves.toBeUndefined()
  })

  it('rejects an unauthorized actor without holding a connection', async () => {
    const store = createDiagnosticStore({
      connectionString: connection.pooled,
      maxConnections: 1,
    })
    try {
      await expect(
        store.query(CONTRACT_ACTORS.activeMember, {
          operation: 'diag.not.registered',
        }),
      ).rejects.toBeInstanceOf(DataStoreAuthorizationError)
      // Refused before any connection was acquired.
      expect(store.poolStats.total).toBe(0)
    } finally {
      await store.close()
    }
  })
})
