/**
 * Neon/PostgreSQL data-plane adapter for the provider-neutral `DataStore`
 * contract (S03).
 *
 * Scope and boundaries:
 *
 * - This is the **data plane**. The Neon *control plane* (project/branch/role
 *   provisioning through Neon's management API) is a separate adapter owned by
 *   `ops/`. The two share no code and no credential: this one only ever holds a
 *   least-privilege runtime connection string.
 * - Authorization is enforced by the **database**, not by this driver. Every
 *   transaction publishes the actor through `SET LOCAL app.actor_id`; the RLS
 *   policies in `postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql`
 *   read it back behind a strict UUID regex plus active-`users` and
 *   active-`team_members` `EXISTS` checks. Missing, malformed, unknown and
 *   inactive actors therefore fail closed in the policy expression. The driver
 *   deliberately does not second-guess the actor id beyond the contract's own
 *   `assertActorContext`.
 * - SQL text lives in an adapter-owned operation registry. Handlers submit
 *   named operations; SQL, driver objects, provider resource IDs and
 *   credentials never cross the contract boundary.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

import pgDefault from 'pg'
import type { Pool as PgPool, PoolClient, PoolConfig } from 'pg'

import {
  assertActorContext,
  assertOperationName,
  asUtcTimestamp,
  DATASTORE_SECURITY_CONTRACT,
  DataStoreAuthorizationError,
  DataStoreContractError,
  DataStoreTransactionError,
  normalizePageRequest,
  normalizeUtcRange,
  PaginationError,
  type ActorContext,
  type DataStore,
  type DataStoreCommand,
  type DataStoreParams,
  type DataStoreSecurityContract,
  type DataStoreTransaction,
  type NormalizedPageRequest,
  type Page,
  type QueryRequest,
  type UtcRange,
} from './contracts.js'

// `pg` ships CommonJS; the package is consumed from ESM everywhere here.
const { Pool, types: pgTypes } = pgDefault

/** PostgreSQL type OIDs the adapter normalizes on the way out. */
const OID_TIMESTAMPTZ = 1184
const OID_TIMESTAMP = 1114
const OID_DATE = 1082

/** SQLSTATEs the adapter translates into contract errors. */
const SQLSTATE_QUERY_CANCELED = '57014'
const SQLSTATE_INSUFFICIENT_PRIVILEGE = '42501'

export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000

/** Row shape handed to an operation's `mapRow`; column names are as selected. */
export type NeonRow = Record<string, unknown>

export interface NeonStatement {
  /** Parameterized SQL. Never interpolate caller input into this text. */
  readonly text: string
  readonly values?: readonly unknown[]
}

export interface NeonQueryContext<TParams> {
  readonly actor: ActorContext
  readonly params: TParams | undefined
  readonly page: NormalizedPageRequest
  readonly range: UtcRange | undefined
}

export interface NeonCommandContext<TParams> {
  readonly actor: ActorContext
  readonly params: TParams | undefined
}

export interface NeonQueryOperation<
  TRow,
  TParams extends DataStoreParams = DataStoreParams,
> {
  /**
   * Optional coarse pre-check. It may only ever *narrow* what the database
   * already permits — it is never the authorization decision itself.
   */
  readonly authorize?: (actor: ActorContext) => void
  readonly build: (context: NeonQueryContext<TParams>) => NeonStatement
  readonly mapRow?: (row: NeonRow) => TRow
}

export interface NeonCommandOperation<
  TResult,
  TParams extends DataStoreParams = DataStoreParams,
> {
  readonly authorize?: (actor: ActorContext) => void
  readonly build: (context: NeonCommandContext<TParams>) => NeonStatement
  readonly mapResult?: (rows: readonly NeonRow[], rowCount: number) => TResult
}

type StoredQueryOperation = NeonQueryOperation<unknown, DataStoreParams>
type StoredCommandOperation = NeonCommandOperation<unknown, DataStoreParams>

/**
 * Adapter-owned allowlist. An operation that is not registered is refused
 * before any connection is acquired.
 */
export class NeonOperationRegistry {
  private readonly queries = new Map<string, StoredQueryOperation>()
  private readonly commands = new Map<string, StoredCommandOperation>()

  registerQuery<TRow, TParams extends DataStoreParams = DataStoreParams>(
    operation: string,
    definition: NeonQueryOperation<TRow, TParams>,
  ): this {
    this.queries.set(
      assertOperationName(operation),
      definition as unknown as StoredQueryOperation,
    )
    return this
  }

  registerCommand<TResult, TParams extends DataStoreParams = DataStoreParams>(
    operation: string,
    definition: NeonCommandOperation<TResult, TParams>,
  ): this {
    this.commands.set(
      assertOperationName(operation),
      definition as unknown as StoredCommandOperation,
    )
    return this
  }

  lookupQuery(operation: string): StoredQueryOperation {
    const definition = this.queries.get(operation)
    if (!definition) {
      throw new DataStoreAuthorizationError(
        `Query operation is not allowlisted: ${operation}`,
      )
    }
    return definition
  }

  lookupCommand(operation: string): StoredCommandOperation {
    const definition = this.commands.get(operation)
    if (!definition) {
      throw new DataStoreAuthorizationError(
        `Command operation is not allowlisted: ${operation}`,
      )
    }
    return definition
  }
}

export interface NeonDataStoreConfig {
  /**
   * Least-privilege runtime connection string. Server-only: it must never be
   * exposed through a `VITE_`-prefixed variable or reach the browser bundle.
   */
  readonly connectionString: string
  readonly operations: NeonOperationRegistry
  /** Per-transaction `SET LOCAL statement_timeout`, in milliseconds. */
  readonly statementTimeoutMs?: number
  /** Client-side pool ceiling. Serverless invocations want this small. */
  readonly maxConnections?: number
  readonly idleTimeoutMs?: number
  readonly connectionTimeoutMs?: number
  readonly applicationName?: string
}

interface ResolvedConfig {
  readonly statementTimeoutMs: number
  readonly operations: NeonOperationRegistry
}

interface TransactionScope {
  readonly depth: number
}

const transactionScope = new AsyncLocalStorage<TransactionScope>()

/**
 * Normalize `timestamptz`/`timestamp` to ISO-8601 UTC strings so every adapter
 * hands the application the same instant representation regardless of the
 * process time zone. Applied per-pool rather than through the global
 * `pg.types` registry so nothing else in the process is affected.
 *
 * `date` (OID 1082) is normalized too, and for a different reason. `pg` parses
 * a bare `date` into a `Date` at **local** midnight, so the calendar day
 * `2026-01-01` read on a host at UTC+1 becomes `2025-12-31T23:00:00.000Z` — a
 * different day, and the shift is not even a constant, since it follows the
 * host's DST. A `date` is a calendar day and not an instant, so it crosses this
 * boundary as the `YYYY-MM-DD` text PostgreSQL sent. Found by the first real
 * operation (S12) reading `daily_activity.day`.
 */
function buildTypeParsers(): PoolConfig['types'] {
  const parseTimestamptz = pgTypes.getTypeParser(OID_TIMESTAMPTZ, 'text')
  const parseTimestamp = pgTypes.getTypeParser(OID_TIMESTAMP, 'text')

  const toUtc =
    (inner: (value: string) => unknown) =>
    (value: string): string | null => {
      if (value === null) return null
      const parsed = inner(value)
      if (parsed instanceof Date) return asUtcTimestamp(parsed)
      // `infinity`/`-infinity` come back as strings; pass them through.
      return String(parsed)
    }

  // A calendar day is returned exactly as PostgreSQL spelled it.
  const parseDate = (value: string): string | null =>
    value === null ? null : value

  return {
    getTypeParser: ((oid: number, format?: unknown) => {
      if (oid === OID_TIMESTAMPTZ) return toUtc(parseTimestamptz)
      if (oid === OID_TIMESTAMP) return toUtc(parseTimestamp)
      if (oid === OID_DATE) return parseDate
      return (pgTypes.getTypeParser as (o: number, f?: unknown) => unknown)(
        oid,
        format,
      )
    }) as PoolConfig['types'] extends { getTypeParser: infer T } ? T : never,
  }
}

/**
 * Opaque, scope-bound cursor.
 *
 * The token is `base64url(sha256(scope) + '.' + offset)`. It carries no
 * readable operation name, parameter value or identifier, and it is refused
 * unless the reader's operation, params, range, tenant and actor hash to the
 * same digest. The offset is the only mutable field, and changing it can only
 * ever re-request a page the same actor could have requested directly, so the
 * token needs no server secret.
 */
function cursorDigest(
  operation: string,
  params: DataStoreParams | undefined,
  range: UtcRange | undefined,
  actor: ActorContext,
): string {
  const scope = JSON.stringify({
    operation,
    params: params ?? null,
    range: range ?? null,
    tenantId: actor.tenantId,
    actorId: actor.actorId,
  })
  return createHash('sha256').update(scope).digest('base64url')
}

function encodeCursor(digest: string, offset: number): string {
  return Buffer.from(`${digest}.${offset}`, 'utf8').toString('base64url')
}

function decodeCursor(token: string, digest: string): number {
  let decoded: string
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8')
  } catch {
    throw new PaginationError('Cursor is invalid or belongs to another scope')
  }
  const separator = decoded.lastIndexOf('.')
  if (separator <= 0) {
    throw new PaginationError('Cursor is invalid or belongs to another scope')
  }
  if (decoded.slice(0, separator) !== digest) {
    throw new PaginationError('Cursor is invalid or belongs to another scope')
  }
  const offset = Number(decoded.slice(separator + 1))
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new PaginationError('Cursor is invalid or belongs to another scope')
  }
  return offset
}

function isPgError(error: unknown): error is { code?: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  )
}

function withCause<TError extends Error>(error: TError, cause: unknown): TError {
  Object.defineProperty(error, 'cause', {
    value: cause,
    configurable: true,
    writable: true,
    enumerable: false,
  })
  return error
}

/**
 * Translate a driver-level failure into a contract error. Contract errors
 * raised by the caller or by the adapter itself pass through untouched so
 * callers can keep discriminating on them.
 */
function toContractError(error: unknown, what: string): Error {
  if (error instanceof DataStoreContractError) return error

  if (isPgError(error)) {
    if (error.code === SQLSTATE_QUERY_CANCELED) {
      return withCause(
        new DataStoreTransactionError(
          `${what} exceeded the transaction statement timeout`,
        ),
        error,
      )
    }
    if (error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
      // Includes row-level security WITH CHECK violations on write.
      return withCause(
        new DataStoreAuthorizationError(
          `${what} was denied by database authorization`,
        ),
        error,
      )
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  return withCause(
    new DataStoreTransactionError(`${what}: ${message}`),
    error,
  )
}

class NeonTransaction implements DataStoreTransaction {
  private active = true

  constructor(
    private readonly store: NeonDataStore,
    readonly actor: ActorContext,
    private readonly client: PoolClient,
  ) {}

  async query<TRow, TParams extends DataStoreParams = DataStoreParams>(
    request: QueryRequest<TParams>,
  ): Promise<Page<TRow>> {
    this.assertActive()
    return this.store.runQuery<TRow, TParams>(this.actor, request, this.client)
  }

  async execute<TResult, TParams extends DataStoreParams = DataStoreParams>(
    command: DataStoreCommand<TParams>,
  ): Promise<TResult> {
    this.assertActive()
    return this.store.runCommand<TResult, TParams>(
      this.actor,
      command,
      this.client,
    )
  }

  close(): void {
    this.active = false
  }

  private assertActive(): void {
    if (!this.active) {
      throw new DataStoreTransactionError('Transaction is no longer active')
    }
  }
}

export interface NeonPoolStats {
  readonly total: number
  readonly idle: number
  readonly waiting: number
}

export class NeonDataStore implements DataStore {
  readonly security: DataStoreSecurityContract = DATASTORE_SECURITY_CONTRACT

  private readonly pool: PgPool
  private readonly config: ResolvedConfig
  private verification: Promise<void> | null = null
  private closed = false

  constructor(config: NeonDataStoreConfig) {
    if (
      typeof config?.connectionString !== 'string' ||
      config.connectionString.trim() === ''
    ) {
      throw new DataStoreContractError(
        'DATASTORE_CONFIG_INVALID',
        'A Neon connection string is required',
      )
    }
    if (!(config.operations instanceof NeonOperationRegistry)) {
      throw new DataStoreContractError(
        'DATASTORE_CONFIG_INVALID',
        'A Neon operation registry is required',
      )
    }

    const statementTimeoutMs =
      config.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS
    if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1) {
      throw new DataStoreContractError(
        'DATASTORE_CONFIG_INVALID',
        'statementTimeoutMs must be a positive integer number of milliseconds',
      )
    }

    this.config = { statementTimeoutMs, operations: config.operations }
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxConnections ?? 4,
      idleTimeoutMillis: config.idleTimeoutMs ?? 10_000,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 10_000,
      application_name: config.applicationName ?? 'lh2-datastore',
      types: buildTypeParsers(),
      // A pool must never crash the process because an idle backend went away.
      allowExitOnIdle: true,
    })
    this.pool.on('error', () => {
      /* Idle-client failures are surfaced on the next acquisition instead. */
    })
  }

  get poolStats(): NeonPoolStats {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end()
  }

  /**
   * A read runs inside its own read-only transaction so that the actor context
   * and the statement timeout are established exactly the same way they are
   * for a write. There is no code path to the database that skips either.
   */
  async query<TRow, TParams extends DataStoreParams = DataStoreParams>(
    actor: ActorContext,
    request: QueryRequest<TParams>,
  ): Promise<Page<TRow>> {
    // Validate before acquiring a connection so a bad request costs nothing.
    const validatedActor = assertActorContext(actor)
    this.assertQueryRequest(request)
    this.config.operations.lookupQuery(assertOperationName(request.operation))

    return this.runTransaction(
      validatedActor,
      (transaction) => transaction.query<TRow, TParams>(request),
      { readOnly: true },
    )
  }

  async transaction<TResult>(
    actor: ActorContext,
    work: (transaction: DataStoreTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    const validatedActor = assertActorContext(actor)
    if (typeof work !== 'function') {
      throw new DataStoreTransactionError('Transaction work must be a function')
    }
    return this.runTransaction(validatedActor, work, { readOnly: false })
  }

  private async runTransaction<TResult>(
    actor: ActorContext,
    work: (transaction: DataStoreTransaction) => Promise<TResult>,
    options: { readOnly: boolean },
  ): Promise<TResult> {
    if (this.closed) {
      throw new DataStoreTransactionError('Data store is closed')
    }
    if (transactionScope.getStore() !== undefined) {
      throw new DataStoreTransactionError('Nested transactions are not supported')
    }

    await this.ensureRuntimePrincipal()

    let client: PoolClient
    try {
      client = await this.pool.connect()
    } catch (error) {
      throw toContractError(error, 'Acquiring a database connection')
    }

    const transaction = new NeonTransaction(this, actor, client)
    let opened = false
    let poisoned: unknown = null

    try {
      await client.query(
        options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN',
      )
      opened = true

      // One round trip establishes the whole transaction preamble. Latency
      // against a remote region is dominated by the *number* of round trips,
      // not by the driver, so these three are deliberately not three
      // statements. `set_config(..., is_local => true)` is exactly `SET LOCAL`,
      // but parameterized, so no caller value is ever interpolated into SQL.
      //
      // - `statement_timeout` closes R3: PostgreSQL arms the timeout when the
      //   outer statement begins, so a guard installed inside a call already
      //   in flight cannot abort it. It must be armed here, before any work
      //   statement is sent.
      // - `timezone` makes date semantics UTC on every connection, whatever
      //   the server or the pooled backend happens to default to.
      // - `app.actor_id` is the actor context the RLS policies read back. It
      //   is transaction-scoped by construction: discarded at COMMIT/ROLLBACK,
      //   so it cannot outlive the transaction that set it, on a pooled or a
      //   direct connection alike.
      await client.query(
        'SELECT set_config($1, $2, true) AS statement_timeout,' +
          ' set_config($3, $4, true) AS timezone,' +
          ' set_config($5, $6, true) AS actor_id',
        [
          'statement_timeout',
          String(this.config.statementTimeoutMs),
          'timezone',
          'UTC',
          'app.actor_id',
          actor.actorId,
        ],
      )

      const result = await transactionScope.run({ depth: 1 }, () =>
        work(transaction),
      )

      await client.query('COMMIT')
      return result
    } catch (error) {
      if (opened) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          // The connection state is unknown; destroy it rather than return it.
          poisoned = rollbackError
        }
      }
      throw toContractError(error, 'Transaction failed and was rolled back')
    } finally {
      transaction.close()
      // Always hand the connection back. `release(err)` destroys it so a
      // connection whose state we could not restore never re-enters the pool.
      client.release(poisoned ? (poisoned as Error) : undefined)
    }
  }

  /**
   * Fail closed if the runtime principal is stronger than the contract claims.
   * Checked once per store, before any operation runs.
   */
  private async ensureRuntimePrincipal(): Promise<void> {
    if (this.verification) return this.verification
    this.verification = (async () => {
      let client: PoolClient
      try {
        client = await this.pool.connect()
      } catch (error) {
        throw toContractError(error, 'Acquiring a database connection')
      }
      try {
        const result = await client.query<{
          superuser: boolean
          bypassrls: boolean
          row_security: string
        }>(
          `SELECT r.rolsuper AS superuser,
                  r.rolbypassrls AS bypassrls,
                  current_setting('row_security') AS row_security
             FROM pg_roles r
            WHERE r.rolname = CURRENT_USER`,
        )
        const row = result.rows[0]
        if (!row) {
          throw new DataStoreAuthorizationError(
            'Runtime principal could not be identified',
          )
        }
        if (row.superuser || row.bypassrls || row.row_security !== 'on') {
          throw new DataStoreAuthorizationError(
            'Runtime principal must not be a superuser and must not bypass row-level security',
          )
        }
      } catch (error) {
        this.verification = null
        throw toContractError(error, 'Verifying the runtime principal')
      } finally {
        client.release()
      }
    })()
    return this.verification
  }

  private assertQueryRequest(request: unknown): void {
    if (!request || typeof request !== 'object') {
      throw new DataStoreContractError(
        'QUERY_INVALID',
        'A query request is required',
      )
    }
  }

  async runQuery<TRow, TParams extends DataStoreParams = DataStoreParams>(
    actor: ActorContext,
    request: QueryRequest<TParams>,
    client: PoolClient,
  ): Promise<Page<TRow>> {
    const validatedActor = assertActorContext(actor)
    this.assertQueryRequest(request)

    const operation = assertOperationName(request.operation)
    const definition = this.config.operations.lookupQuery(operation)
    definition.authorize?.(validatedActor)

    const page = normalizePageRequest(request.page)
    const range = normalizeUtcRange(request.range)
    const digest = cursorDigest(operation, request.params, range, validatedActor)
    const offset = page.cursor ? decodeCursor(page.cursor, digest) : 0

    const statement = definition.build({
      actor: validatedActor,
      params: request.params,
      page,
      range,
    } as unknown as NeonQueryContext<DataStoreParams>)

    const values = [...(statement.values ?? [])]
    // Fetch one extra row to learn whether another page exists without a
    // second round trip or a COUNT over the whole relation.
    const limitPlaceholder = `$${values.length + 1}`
    const offsetPlaceholder = `$${values.length + 2}`
    values.push(page.limit + 1, offset)

    let result
    try {
      result = await client.query<NeonRow>(
        `SELECT * FROM (${statement.text}) AS datastore_page` +
          ` LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
        values,
      )
    } catch (error) {
      throw toContractError(error, `Query operation ${operation}`)
    }

    const hasMore = result.rows.length > page.limit
    const rows = hasMore ? result.rows.slice(0, page.limit) : result.rows
    const items = (
      definition.mapRow ? rows.map((row) => definition.mapRow!(row)) : rows
    ) as readonly TRow[]

    return {
      items,
      hasMore,
      nextCursor: hasMore ? encodeCursor(digest, offset + items.length) : null,
    }
  }

  async runCommand<TResult, TParams extends DataStoreParams = DataStoreParams>(
    actor: ActorContext,
    command: DataStoreCommand<TParams>,
    client: PoolClient,
  ): Promise<TResult> {
    const validatedActor = assertActorContext(actor)
    if (!command || typeof command !== 'object') {
      throw new DataStoreContractError(
        'COMMAND_INVALID',
        'A data store command is required',
      )
    }

    const operation = assertOperationName(command.operation)
    const definition = this.config.operations.lookupCommand(operation)
    definition.authorize?.(validatedActor)

    const statement = definition.build({
      actor: validatedActor,
      params: command.params,
    } as unknown as NeonCommandContext<DataStoreParams>)

    let result
    try {
      result = await client.query<NeonRow>(statement.text, [
        ...(statement.values ?? []),
      ])
    } catch (error) {
      throw toContractError(error, `Command operation ${operation}`)
    }

    return (
      definition.mapResult
        ? definition.mapResult(result.rows, result.rowCount ?? 0)
        : (result.rows as unknown)
    ) as TResult
  }
}
