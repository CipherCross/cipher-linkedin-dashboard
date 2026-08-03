/**
 * Neon-backed harness for the shared `DataStore` contract suite.
 *
 * Every operation below is real SQL against the portable tenant baseline
 * (`postgres/tenant-baseline/v1`). Nothing is stubbed: the fixture rows are
 * inserted into `public.events`/`public.annotations`, and which of them an
 * actor can see is decided by the baseline's row-level security policies, not
 * by this file.
 *
 * The credential is read from the server-only environment. If it is absent the
 * harness throws with an actionable message — it never falls back to the fake,
 * because a green suite that touched no database is worse than a red one.
 */

import pgDefault from 'pg'
import type { Pool as PgPool, PoolClient } from 'pg'

import { DataStoreAuthorizationError } from '../../api/_lib/data/index.js'
import {
  NeonDataStore,
  NeonOperationRegistry,
  type NeonRow,
} from '../../api/_lib/data/neon.js'
import {
  isPooledConnectionString,
  NEON_DATABASE_URL_ENV,
  readNeonConnectionString,
  readNeonDirectConnectionString,
} from '../../api/_lib/data/neonConfig.js'

import {
  CONTRACT_ACTORS,
  CONTRACT_OPERATIONS,
  CONTRACT_SCOPE,
  PAGE_EVENT_TYPE,
  PAGE_FIXTURE_SIZE,
  RANGE_EVENT_TYPE,
  RANGE_FIXTURE,
  type DataStoreContractHarness,
} from './dataStoreContract.js'

const { Pool } = pgDefault

export interface NeonTestConnection {
  readonly pooled: string
  readonly direct: string
  readonly pooledEndpointConfirmed: boolean
}

/**
 * Resolve the connection strings, or fail closed. Called from module scope of
 * the Neon test file so a missing credential is a red suite, not a skip.
 */
export function requireNeonTestConnection(): NeonTestConnection {
  const pooled = readNeonConnectionString()
  return {
    pooled,
    direct: readNeonDirectConnectionString(),
    pooledEndpointConfirmed: isPooledConnectionString(pooled),
  }
}

/** Human-readable reason the Neon contract suite cannot run. */
export function neonCredentialFailure(): string | null {
  try {
    requireNeonTestConnection()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function buildContractRegistry(): NeonOperationRegistry {
  const registry = new NeonOperationRegistry()

  // The actor's own identity row. RLS decides whether there is one at all:
  // the policy requires a UUID-shaped `app.actor_id`, an active `users` row
  // and an active `team_members` row. Unknown, malformed and inactive actors
  // therefore get an empty result without this SQL saying anything about them.
  const actorSelfSql = {
    text: 'SELECT u.id::text AS actor_id FROM public.users u ORDER BY u.id',
    values: [] as unknown[],
  }
  const mapActorRow = (row: NeonRow) => ({ actorId: String(row.actor_id) })

  registry.registerQuery(CONTRACT_OPERATIONS.actorSelf, {
    build: () => actorSelfSql,
    mapRow: mapActorRow,
  })

  registry.registerQuery(CONTRACT_OPERATIONS.recordsAdmin, {
    // An adapter-side pre-check that can only narrow what the database allows.
    authorize: (actor) => {
      if (actor.role !== 'admin') {
        throw new DataStoreAuthorizationError('Admin actor required')
      }
    },
    build: () => actorSelfSql,
    mapRow: mapActorRow,
  })

  registry.registerQuery(CONTRACT_OPERATIONS.recordsRange, {
    build: ({ range }) => ({
      text: `SELECT e.profile_url AS record_key, e.occurred_at AS occurred_at
               FROM public.events e
              WHERE e.instance_id = $1
                AND e.event_type = $2
                AND ($3::timestamptz IS NULL OR e.occurred_at >= $3::timestamptz)
                AND ($4::timestamptz IS NULL OR e.occurred_at < $4::timestamptz)
              ORDER BY e.occurred_at, e.profile_url`,
      values: [
        CONTRACT_SCOPE,
        RANGE_EVENT_TYPE,
        range?.fromInclusive ?? null,
        range?.toExclusive ?? null,
      ],
    }),
    mapRow: (row) => ({
      key: String(row.record_key),
      // Already an ISO-8601 UTC string: the adapter normalizes timestamptz.
      occurredAt: row.occurred_at as string,
    }),
  })

  registry.registerQuery(CONTRACT_OPERATIONS.recordsPage, {
    build: () => ({
      text: `SELECT (e.raw ->> 'seq')::int AS seq
               FROM public.events e
              WHERE e.instance_id = $1
                AND e.event_type = $2
              ORDER BY (e.raw ->> 'seq')::int`,
      values: [CONTRACT_SCOPE, PAGE_EVENT_TYPE],
    }),
    mapRow: (row) => ({ seq: Number(row.seq) }),
  })

  registry.registerQuery(CONTRACT_OPERATIONS.notesCount, {
    build: () => ({
      text: 'SELECT count(*)::int AS count FROM public.annotations WHERE instance_id = $1',
      values: [CONTRACT_SCOPE],
    }),
    mapRow: (row) => ({ count: Number(row.count) }),
  })

  // A write. An inactive, unknown or malformed actor is refused by the
  // annotations policy's WITH CHECK, which arrives as SQLSTATE 42501 and is
  // translated into DataStoreAuthorizationError.
  registry.registerCommand<number, { note: string }>(
    CONTRACT_OPERATIONS.notesInsert,
    {
      build: ({ params }) => ({
        text: `INSERT INTO public.annotations (instance_id, note, noted_at)
               VALUES ($1, $2, DATE '2026-01-01')`,
        values: [CONTRACT_SCOPE, params?.note ?? ''],
      }),
      mapResult: (_rows, rowCount) => rowCount,
    },
  )

  // A command that fails mid-transaction without writing anything itself, so
  // the rollback assertion is about the *preceding* successful write.
  registry.registerCommand(CONTRACT_OPERATIONS.commandFail, {
    build: () => ({
      text: 'SELECT 1 / (SELECT 0)::int AS boom',
      values: [],
    }),
  })

  return registry
}

export interface NeonStoreOptions {
  readonly connectionString?: string
  readonly maxConnections?: number
  readonly statementTimeoutMs?: number
  readonly applicationName?: string
}

export function createNeonStore(options: NeonStoreOptions = {}): NeonDataStore {
  return new NeonDataStore({
    connectionString:
      options.connectionString ?? requireNeonTestConnection().pooled,
    operations: buildContractRegistry(),
    statementTimeoutMs: options.statementTimeoutMs ?? 10_000,
    maxConnections: options.maxConnections ?? 4,
    applicationName: options.applicationName ?? 'lh2-datastore-contract-suite',
  })
}

/**
 * Out-of-band access, on its own pool and its own transactions. Used to seed
 * fixtures and to verify rollback independently of the store under test.
 */
export class NeonFixtureClient {
  private readonly pool: PgPool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 })
    this.pool.on('error', () => {})
  }

  async asActor<TResult>(
    actorId: string,
    work: (client: PoolClient) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', [
        'app.actor_id',
        actorId,
      ])
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async end(): Promise<void> {
    await this.pool.end()
  }
}

/**
 * Idempotent. The fixture rows are namespaced by `instance_id` and event type,
 * so re-running the suite neither duplicates nor re-inserts them.
 */
export async function seedContractFixtures(
  fixtures: NeonFixtureClient,
): Promise<{ rangeRows: number; pageRows: number }> {
  return fixtures.asActor(CONTRACT_ACTORS.activeMember.actorId, async (client) => {
    await client.query(
      `INSERT INTO public.instances (id, label)
       VALUES ($1, 'S11 contract fixture')
       ON CONFLICT (id) DO NOTHING`,
      [CONTRACT_SCOPE],
    )

    await client.query(
      `INSERT INTO public.events (instance_id, profile_url, event_type, occurred_at)
       SELECT $1, fixture.record_key, $2, fixture.occurred_at::timestamptz
         FROM unnest($3::text[], $4::text[]) AS fixture(record_key, occurred_at)
       ON CONFLICT DO NOTHING`,
      [
        CONTRACT_SCOPE,
        RANGE_EVENT_TYPE,
        RANGE_FIXTURE.map((row) => row.key),
        RANGE_FIXTURE.map((row) => row.occurredAt),
      ],
    )

    // Real volume, not a stub: enough rows that a full walk needs three pages
    // at the 1000-row cap.
    await client.query(
      `INSERT INTO public.events (instance_id, profile_url, event_type, occurred_at, raw)
       SELECT $1,
              'seq/' || lpad(g::text, 6, '0'),
              $2,
              timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => g),
              jsonb_build_object('seq', g)
         FROM generate_series(1, $3::int) AS g
       ON CONFLICT DO NOTHING`,
      [CONTRACT_SCOPE, PAGE_EVENT_TYPE, PAGE_FIXTURE_SIZE],
    )

    const counts = await client.query<{ range_rows: string; page_rows: string }>(
      `SELECT count(*) FILTER (WHERE event_type = $2) AS range_rows,
              count(*) FILTER (WHERE event_type = $3) AS page_rows
         FROM public.events
        WHERE instance_id = $1`,
      [CONTRACT_SCOPE, RANGE_EVENT_TYPE, PAGE_EVENT_TYPE],
    )

    return {
      rangeRows: Number(counts.rows[0]?.range_rows ?? 0),
      pageRows: Number(counts.rows[0]?.page_rows ?? 0),
    }
  })
}

export async function createNeonContractHarness(): Promise<DataStoreContractHarness> {
  const connection = requireNeonTestConnection()
  const fixtures = new NeonFixtureClient(connection.pooled)
  const seeded = await seedContractFixtures(fixtures)

  if (seeded.rangeRows !== RANGE_FIXTURE.length) {
    throw new Error(
      `Range fixture is incomplete: expected ${RANGE_FIXTURE.length} rows, found ${seeded.rangeRows}`,
    )
  }
  if (seeded.pageRows !== PAGE_FIXTURE_SIZE) {
    throw new Error(
      `Pagination fixture is incomplete: expected ${PAGE_FIXTURE_SIZE} rows, found ${seeded.pageRows}`,
    )
  }

  const store = createNeonStore({ connectionString: connection.pooled })

  return {
    name: `NeonDataStore (${NEON_DATABASE_URL_ENV})`,
    store,
    actors: CONTRACT_ACTORS,
    async countNotesOutOfBand() {
      return fixtures.asActor(
        CONTRACT_ACTORS.activeMember.actorId,
        async (client) => {
          const result = await client.query<{ count: string }>(
            'SELECT count(*) AS count FROM public.annotations WHERE instance_id = $1',
            [CONTRACT_SCOPE],
          )
          return Number(result.rows[0]?.count ?? 0)
        },
      )
    },
    async resetNotes() {
      await fixtures.asActor(
        CONTRACT_ACTORS.activeMember.actorId,
        async (client) => {
          await client.query(
            'DELETE FROM public.annotations WHERE instance_id = $1',
            [CONTRACT_SCOPE],
          )
        },
      )
    },
    async dispose() {
      await store.close()
      await fixtures.end()
    },
  }
}
