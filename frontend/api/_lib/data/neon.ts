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
  DataStoreConstraintError,
  DataStoreContractError,
  DataStoreSchemaError,
  DataStoreTransactionError,
  normalizePageRequest,
  normalizeUtcRange,
  PaginationError,
  RESOLVE_ACTOR_OPERATION,
  type ActorContext,
  type DataStore,
  type DataStoreCommand,
  type DataStoreParams,
  type DataStoreSecurityContract,
  type DataStoreTransaction,
  type NormalizedPageRequest,
  type Page,
  type QueryRequest,
  type ResolveActorRequest,
  type ResolvedActor,
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
/**
 * `undefined_table`. Translated so a caller can tolerate a relation this
 * deployment's schema does not have yet, without reading driver text — see
 * `DataStoreSchemaError`.
 *
 * Deliberately **not** paired with `42703` (`undefined_column`). A missing
 * column is a mismatched deployment rather than a pending migration on this
 * path, and the retry ladders that used to degrade around one are gone by
 * decision (`operations/leads.ts`). Widening this constant to cover 42703 would
 * reinstate silent degradation through the back door.
 */
const SQLSTATE_UNDEFINED_TABLE = '42P01'
/**
 * `unique_violation` and `foreign_key_violation`. Translated because both are
 * *answers* to a caller rather than failures of it — see
 * `DataStoreConstraintError`. Note what is not here: `23514`
 * (`check_violation`), which stays an opaque transaction error on purpose,
 * because a validator and a `CHECK` that disagree is a defect and not a 400.
 */
const SQLSTATE_UNIQUE_VIOLATION = '23505'
const SQLSTATE_FOREIGN_KEY_VIOLATION = '23503'

export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000

/** Row shape handed to an operation's `mapRow`; column names are as selected. */
export type NeonRow = Record<string, unknown>

export interface NeonStatement {
  /** Parameterized SQL. Never interpolate caller input into this text. */
  readonly text: string
  readonly values?: readonly unknown[]
}

/**
 * A scalar of an operation's sort key, as it arrives back from a cursor.
 *
 * Deliberately narrow. Key values make a round trip through a JSON cursor, so
 * anything whose JSON form is not its SQL form — a `Date`, a `bigint`, an array
 * — cannot be a key component without a lossy conversion nobody would see. Every
 * key column an operation declares must therefore select as text, a JSON-safe
 * number, or NULL. Timestamps already cross this boundary as ISO-8601 UTC
 * strings (see `buildTypeParsers`), so `(sent_at, id)` is expressible as-is.
 */
export type NeonKeysetValue = string | number | null

export interface NeonQueryContext<TParams> {
  readonly actor: ActorContext
  readonly params: TParams | undefined
  readonly page: NormalizedPageRequest
  readonly range: UtcRange | undefined
  /**
   * The sort key of the last row of the previous page, or `undefined` on the
   * first page. Present only for an operation that declares `keyset`.
   *
   * The operation — not the driver — turns this into a predicate, because the
   * operation owns its SQL and its sort order. See `NeonKeysetPagination`.
   */
  readonly after: readonly NeonKeysetValue[] | undefined
}

export interface NeonCommandContext<TParams> {
  readonly actor: ActorContext
  readonly params: TParams | undefined
}

/**
 * Keyset (seek) pagination for one operation.
 *
 * **Why the driver does not generate the predicate.** The obvious design is for
 * the driver to wrap the operation's SQL and append its own
 * `WHERE (a, b) < ($1, $2) ORDER BY a DESC, b DESC` — the driver already wraps
 * every query for `LIMIT/OFFSET`, so it would be symmetrical. It was rejected on
 * two grounds. First, a filter applied *outside* a subquery relies on the planner
 * pushing the qual down through it to reach the index; when it does not, every
 * page sorts the whole relation and keyset buys nothing while looking like it
 * works. Second, the driver would have to know each operation's sort direction,
 * its NULL ordering and its column types in order to emit a correct comparison —
 * which is the operation's own knowledge, and duplicating it in the driver is how
 * the two drift apart.
 *
 * So the split is: the **operation** owns the predicate and the `ORDER BY`, and
 * the **driver** owns the cursor — its opacity, its scope binding, and reading
 * the next key off the last row. The driver applies `LIMIT` and, for a keyset
 * operation, **no `OFFSET`**, which is the entire point.
 *
 * **What the cursor carries, and why that is safe.** For an offset operation the
 * payload is an integer; for a keyset operation it is a JSON array of the last
 * row's key values. Those values were in the response body the caller just
 * received, so the cursor discloses nothing new. Tampering is bounded exactly as
 * it is for offset: the digest pins operation, params, range, tenant and actor,
 * so a forged key can only re-request rows this actor could have requested
 * directly, and RLS still decides the row set.
 */
export interface NeonKeysetPagination {
  /**
   * The operation's sort-key columns, in `ORDER BY` order, named as they appear
   * in the operation's own projection.
   *
   * Must be a **total order** — end it in a unique column. This is the same
   * requirement offset paging has; keyset merely makes violating it louder,
   * because a repeated key makes the walk loop rather than silently skip.
   */
  readonly columns: readonly string[]
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
  /**
   * Declare keyset pagination. Absent means offset, which stays the default:
   * S12 measured offset at 522 ms against 525 ms for the first page on an
   * aggregate slice, so keyset is a considered choice per operation rather than
   * a blanket upgrade.
   */
  readonly keyset?: NeonKeysetPagination
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

/**
 * A read that runs with **no actor published**, because it is what establishes
 * the actor.
 *
 * This is a deliberately awkward, deliberately tiny category. `S17` needs
 * exactly one member of it — `public.identity_resolve_actor`, which the identity
 * ledger describes as "the ONE function in this artifact that is deliberately
 * reachable with no actor context". Everything a request does *after* that point
 * is actor-scoped in the ordinary way.
 *
 * Two properties keep it from becoming a general escape hatch:
 *
 * 1. It has its own allowlist, separate from `queries`. An actor-scoped
 *    operation cannot be reached through this path and vice versa, so nothing
 *    already registered can accidentally lose its actor.
 * 2. It has no `authorize` hook and no `actor` in its build context. There is
 *    no actor to authorize against — pretending otherwise by inventing a
 *    synthetic actor id would put a value that identifies nobody into
 *    `app.actor_id`, which is exactly the confusion this avoids.
 */
export interface NeonActorlessQueryOperation<
  TRow,
  TParams extends DataStoreParams = DataStoreParams,
> {
  readonly build: (params: TParams | undefined) => NeonStatement
  readonly mapRow?: (row: NeonRow) => TRow
}

type StoredQueryOperation = NeonQueryOperation<unknown, DataStoreParams>
type StoredCommandOperation = NeonCommandOperation<unknown, DataStoreParams>
type StoredActorlessOperation = NeonActorlessQueryOperation<
  unknown,
  DataStoreParams
>

/**
 * Adapter-owned allowlist. An operation that is not registered is refused
 * before any connection is acquired.
 */
export class NeonOperationRegistry {
  private readonly queries = new Map<string, StoredQueryOperation>()
  private readonly commands = new Map<string, StoredCommandOperation>()
  private readonly actorless = new Map<string, StoredActorlessOperation>()

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

  /** Register the pre-actor resolver. See `NeonActorlessQueryOperation`. */
  registerActorlessQuery<TRow, TParams extends DataStoreParams = DataStoreParams>(
    operation: string,
    definition: NeonActorlessQueryOperation<TRow, TParams>,
  ): this {
    this.actorless.set(
      assertOperationName(operation),
      definition as unknown as StoredActorlessOperation,
    )
    return this
  }

  lookupActorlessQuery(operation: string): StoredActorlessOperation {
    const definition = this.actorless.get(operation)
    if (!definition) {
      throw new DataStoreAuthorizationError(
        `Actorless query operation is not allowlisted: ${operation}`,
      )
    }
    return definition
  }

  /** Every actorless operation registered, so a test can assert how many. */
  actorlessOperationNames(): readonly string[] {
    return [...this.actorless.keys()]
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
  /**
   * A role every transaction enters immediately after `BEGIN`, before the
   * statement timeout, the timezone and the actor are published.
   *
   * The AI store uses it to enter `app_system` **unconditionally**: a role may
   * always `SET ROLE` to itself, so the same statement is correct when the pool
   * connects as `app_system` directly *and* when it connects as a member of it
   * with `SET TRUE` — which makes the production path and a test that connects
   * as a member login byte-identical instead of differing by a branch nothing
   * tests. The entry is transaction-scoped (`set_config(..., is_local => true)`
   * is exactly `SET LOCAL` here, parameterized like the rest of the preamble),
   * never the session-scoped variant, because the pooled endpoint reuses
   * backends across clients.
   *
   * Validated to a bare identifier so a malformed value fails at construction
   * rather than inside the first transaction; it is bound as a parameter
   * either way.
   */
  readonly localRole?: string
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
  readonly localRole: string | null
}

const ROLE_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/

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

function encodeCursor(digest: string, payload: string): string {
  return Buffer.from(`${digest}.${payload}`, 'utf8').toString('base64url')
}

/**
 * Strip the digest and return the payload, or refuse.
 *
 * Split on the **first** separator rather than the last. A sha256 digest in
 * base64url is 43 characters and contains no `.`, so for the offset payload the
 * two are identical — but a keyset payload is JSON, and an ISO-8601 instant with
 * milliseconds carries a `.` of its own. `lastIndexOf` would have found that one.
 */
function decodeCursorPayload(token: string, digest: string): string {
  let decoded: string
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8')
  } catch {
    throw new PaginationError('Cursor is invalid or belongs to another scope')
  }
  const separator = decoded.indexOf('.')
  if (separator <= 0) {
    throw new PaginationError('Cursor is invalid or belongs to another scope')
  }
  if (decoded.slice(0, separator) !== digest) {
    throw new PaginationError('Cursor is invalid or belongs to another scope')
  }
  return decoded.slice(separator + 1)
}

function decodeOffsetCursor(token: string, digest: string): number {
  const offset = Number(decodeCursorPayload(token, digest))
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new PaginationError('Cursor is invalid or belongs to another scope')
  }
  return offset
}

/**
 * Decode a keyset payload into exactly the key the operation declared.
 *
 * The arity check is the load-bearing one. A key of the wrong width would be
 * spliced into the operation's parameter list and shift every later placeholder,
 * producing a query that is syntactically valid and semantically unrelated. It is
 * refused as a pagination error rather than reaching the database.
 */
function decodeKeysetCursor(
  token: string,
  digest: string,
  keyset: NeonKeysetPagination,
): readonly NeonKeysetValue[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeCursorPayload(token, digest))
  } catch (error) {
    if (error instanceof PaginationError) throw error
    throw new PaginationError('Cursor is invalid or belongs to another scope')
  }
  if (!Array.isArray(parsed) || parsed.length !== keyset.columns.length) {
    throw new PaginationError('Cursor is invalid or belongs to another scope')
  }
  for (const value of parsed) {
    const type = typeof value
    if (value !== null && type !== 'string' && type !== 'number') {
      throw new PaginationError('Cursor is invalid or belongs to another scope')
    }
  }
  return parsed as readonly NeonKeysetValue[]
}

/**
 * Read the next page's key off the last row of this page.
 *
 * A declared key column missing from the projection is a programming error in the
 * operation, not a caller error — and it is one that would otherwise surface as a
 * walk that silently stops or repeats, so it fails loudly here.
 */
function keysetOf(
  row: NeonRow,
  keyset: NeonKeysetPagination,
  operation: string,
): readonly NeonKeysetValue[] {
  return keyset.columns.map((column) => {
    if (!(column in row)) {
      throw new DataStoreContractError(
        'OPERATION_INVALID',
        `Operation ${operation} declares keyset column ${column}, which it does not select`,
      )
    }
    const value = row[column]
    if (value === null || value === undefined) return null
    if (typeof value === 'string' || typeof value === 'number') return value
    // A `Date`, a `bigint` or an object would not survive the JSON round trip
    // as the same SQL value. See `NeonKeysetValue`.
    throw new DataStoreContractError(
      'OPERATION_INVALID',
      `Operation ${operation} keyset column ${column} is not a cursor-safe scalar`,
    )
  })
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
    if (error.code === SQLSTATE_UNIQUE_VIOLATION) {
      // The original text names the constraint and quotes the conflicting key,
      // so it is composed rather than quoted for the same reason as 42P01.
      return withCause(
        new DataStoreConstraintError(
          'unique',
          `${what} conflicted with a row that already exists`,
        ),
        error,
      )
    }
    if (error.code === SQLSTATE_FOREIGN_KEY_VIOLATION) {
      return withCause(
        new DataStoreConstraintError(
          'foreign_key',
          `${what} referenced a row that does not exist`,
        ),
        error,
      )
    }
    if (error.code === SQLSTATE_UNDEFINED_TABLE) {
      // The original text names the missing relation, which would be harmless
      // to keep — but the rule that no driver message reaches a log or a
      // response is worth more than the diagnostic, and the SQLSTATE is
      // preserved as the `cause`. So the message is composed rather than quoted.
      return withCause(
        new DataStoreSchemaError(
          `${what} referenced a relation that does not exist`,
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

    let localRole: string | null = null
    if (config.localRole !== undefined) {
      if (
        typeof config.localRole !== 'string' ||
        !ROLE_IDENTIFIER_PATTERN.test(config.localRole)
      ) {
        throw new DataStoreContractError(
          'DATASTORE_CONFIG_INVALID',
          'localRole must be a bare lowercase role identifier',
        )
      }
      localRole = config.localRole
    }

    this.config = { statementTimeoutMs, operations: config.operations, localRole }
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

  /**
   * The pre-actor read. See `DataStore.resolveActor`.
   *
   * It runs in its own `BEGIN READ ONLY` with the same statement timeout and the
   * same UTC timezone as every other read — the only difference is that
   * `app.actor_id` is published as the empty string rather than an actor id.
   * That is deliberate and it is safer than it looks: every RLS policy in the
   * baseline compares `app.actor_id` against a `user_id`, so an empty setting
   * matches nothing and every actor-scoped table returns zero rows on this
   * connection. The one thing that does work is the `SECURITY DEFINER` resolver,
   * which reads as its owner and consults no actor at all.
   *
   * Publishing `''` rather than leaving the setting unset is itself a choice: an
   * unset `app.actor_id` and one left over from a previous transaction on a
   * pooled connection are indistinguishable to a policy, so it is set every
   * time, transaction-locally, exactly as `runTransaction` does.
   */
  async resolveActor(
    request: ResolveActorRequest,
  ): Promise<ResolvedActor | null> {
    if (
      !request ||
      typeof request.provider !== 'string' ||
      request.provider.trim() === '' ||
      typeof request.subject !== 'string' ||
      request.subject.trim() === ''
    ) {
      // Not a denial to report upward: a blank subject cannot identify anyone,
      // and refusing here keeps a malformed session from reaching the database.
      return null
    }

    if (this.closed) {
      throw new DataStoreTransactionError('Data store is closed')
    }
    const definition = this.config.operations.lookupActorlessQuery(
      RESOLVE_ACTOR_OPERATION,
    )

    await this.ensureRuntimePrincipal()

    let client: PoolClient
    try {
      client = await this.pool.connect()
    } catch (error) {
      throw toContractError(error, 'Acquiring a database connection')
    }

    let opened = false
    let poisoned: unknown = null
    try {
      await client.query('BEGIN READ ONLY')
      opened = true
      await client.query(this.preambleSql(), this.preambleValues(''))

      const statement = definition.build({
        provider: request.provider.trim(),
        subject: request.subject.trim(),
      } as unknown as DataStoreParams)

      const result = await client.query<NeonRow>(statement.text, [
        ...(statement.values ?? []),
      ])
      await client.query('COMMIT')

      // More than one row would mean the baseline's uniqueness on
      // (provider, provider_subject) was violated. Refuse rather than pick one.
      if (result.rows.length !== 1) return null
      const mapped = definition.mapRow
        ? definition.mapRow(result.rows[0])
        : result.rows[0]
      return mapped as ResolvedActor
    } catch (error) {
      if (opened) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          poisoned = rollbackError
        }
      }
      throw toContractError(error, 'Resolving the actor')
    } finally {
      client.release(poisoned ? (poisoned as Error) : undefined)
    }
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
      // not by the driver, so these are deliberately not separate statements.
      // `set_config(..., is_local => true)` is exactly `SET LOCAL`,
      // but parameterized, so no caller value is ever interpolated into SQL.
      //
      // - `role` enters the store's configured local role when it has one —
      //   the AI store's unconditional `SET LOCAL ROLE app_system`. Absent
      //   from the runtime store's preamble, which stays exactly the three
      //   settings it has always issued.
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
      await client.query(this.preambleSql(), this.preambleValues(actor.actorId))

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
   * The transaction preamble as SQL. Shared by `runTransaction` and by the
   * pre-actor resolver so a store that enters a local role does so on every
   * code path to the database, without exception.
   */
  private preambleSql(): string {
    const rolePart = this.config.localRole
      ? ', set_config($7, $8, true) AS local_role'
      : ''
    return (
      'SELECT set_config($1, $2, true) AS statement_timeout,' +
      ' set_config($3, $4, true) AS timezone,' +
      ' set_config($5, $6, true) AS actor_id' +
      rolePart
    )
  }

  private preambleValues(actorId: string): unknown[] {
    const values: unknown[] = [
      'statement_timeout',
      String(this.config.statementTimeoutMs),
      'timezone',
      'UTC',
      'app.actor_id',
      actorId,
    ]
    if (this.config.localRole) values.push('role', this.config.localRole)
    return values
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
    const keyset = definition.keyset

    // Decode before building, so the operation receives the key it needs to
    // write its own predicate, and so a bad cursor costs no query.
    const after =
      keyset && page.cursor
        ? decodeKeysetCursor(page.cursor, digest, keyset)
        : undefined
    const offset =
      !keyset && page.cursor ? decodeOffsetCursor(page.cursor, digest) : 0

    const statement = definition.build({
      actor: validatedActor,
      params: request.params,
      page,
      range,
      after,
    } as unknown as NeonQueryContext<DataStoreParams>)

    const values = [...(statement.values ?? [])]
    // Fetch one extra row to learn whether another page exists without a
    // second round trip or a COUNT over the whole relation.
    const limitPlaceholder = `$${values.length + 1}`
    values.push(page.limit + 1)

    // A keyset operation gets no `OFFSET` at all — that is the whole point. The
    // wrapper stays, so the shared row cap and the extra-row probe are applied
    // identically on both paths and there is one place they can be reasoned about.
    let pageClause = ` LIMIT ${limitPlaceholder}`
    if (!keyset) {
      const offsetPlaceholder = `$${values.length + 1}`
      values.push(offset)
      pageClause += ` OFFSET ${offsetPlaceholder}`
    }

    let result
    try {
      result = await client.query<NeonRow>(
        `SELECT * FROM (${statement.text}) AS datastore_page${pageClause}`,
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

    let nextCursor: string | null = null
    if (hasMore) {
      nextCursor = keyset
        ? encodeCursor(
            digest,
            // Off the raw row, before `mapRow`: a mapper may rename or reshape
            // the projection, and the key belongs to the SQL, not to the DTO.
            JSON.stringify(keysetOf(rows[rows.length - 1], keyset, operation)),
          )
        : encodeCursor(digest, String(offset + items.length))
    }

    return { items, hasMore, nextCursor }
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
