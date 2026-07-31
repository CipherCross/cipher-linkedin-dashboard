/**
 * Provider-neutral data access contracts.
 *
 * Application handlers submit named, allowlisted operations. An adapter owns
 * the provider query behind each operation; SQL text, driver objects, provider
 * resource IDs and credentials never cross this boundary.
 */

export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 1_000

const UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

export type DataStoreParam =
  | string
  | number
  | boolean
  | null
  | UtcTimestamp
  | readonly DataStoreParam[]

export type DataStoreParams = Readonly<Record<string, DataStoreParam>>

declare const UTC_TIMESTAMP: unique symbol

/** An instant normalized to an ISO-8601 UTC string with a `Z` suffix. */
export type UtcTimestamp = string & { readonly [UTC_TIMESTAMP]: true }

export class DataStoreContractError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DataStoreContractError'
    this.code = code
  }
}

export class ActorContextError extends DataStoreContractError {
  constructor(message: string) {
    super('ACTOR_CONTEXT_INVALID', message)
    this.name = 'ActorContextError'
  }
}

export class DataStoreAuthorizationError extends DataStoreContractError {
  constructor(message: string) {
    super('DATASTORE_AUTHORIZATION_DENIED', message)
    this.name = 'DataStoreAuthorizationError'
  }
}

export class UtcTimestampError extends DataStoreContractError {
  constructor(message: string) {
    super('UTC_TIMESTAMP_INVALID', message)
    this.name = 'UtcTimestampError'
  }
}

export class PaginationError extends DataStoreContractError {
  constructor(message: string) {
    super('PAGINATION_INVALID', message)
    this.name = 'PaginationError'
  }
}

export class DataStoreTransactionError extends DataStoreContractError {
  constructor(message: string) {
    super('TRANSACTION_INVALID', message)
    this.name = 'DataStoreTransactionError'
  }
}

export interface UserActorContext {
  readonly kind: 'user'
  /** Canonical application user ID; never an identity-provider subject. */
  readonly actorId: string
  /** Canonical application tenant/workspace ID. */
  readonly tenantId: string
  readonly role: 'member' | 'admin'
}

export interface MachineActorContext {
  readonly kind: 'machine'
  /** Canonical application machine identity ID. */
  readonly actorId: string
  readonly tenantId: string
  readonly role: 'machine'
}

export interface SystemActorContext {
  readonly kind: 'system'
  /** Canonical application job identity ID. */
  readonly actorId: string
  readonly tenantId: string
  readonly role: 'system'
}

/** Anonymous callers are deliberately not representable as a valid actor. */
export type ActorContext =
  | UserActorContext
  | MachineActorContext
  | SystemActorContext

export function assertActorContext(actor: ActorContext): ActorContext {
  if (!actor || typeof actor !== 'object') {
    throw new ActorContextError('An authenticated actor context is required')
  }

  if (
    typeof actor.actorId !== 'string' ||
    actor.actorId.trim() === '' ||
    typeof actor.tenantId !== 'string' ||
    actor.tenantId.trim() === ''
  ) {
    throw new ActorContextError('Actor and tenant IDs must be non-empty')
  }

  if (
    actor.kind === 'user' &&
    (actor.role === 'member' || actor.role === 'admin')
  ) {
    return actor
  }
  if (actor.kind === 'machine' && actor.role === 'machine') return actor
  if (actor.kind === 'system' && actor.role === 'system') return actor

  throw new ActorContextError('Actor kind and role do not match')
}

/**
 * Parse and normalize an instant. Offset-bearing inputs are accepted at the
 * server boundary, then converted once to UTC so all adapters share the same
 * date semantics.
 */
export function asUtcTimestamp(value: Date | string): UtcTimestamp {
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) {
      throw new UtcTimestampError('Invalid Date cannot be used as a timestamp')
    }
    return value.toISOString() as UtcTimestamp
  }

  if (typeof value !== 'string' || !UTC_INSTANT_PATTERN.test(value)) {
    throw new UtcTimestampError(
      'Timestamp must be an ISO-8601 instant with Z or an explicit UTC offset',
    )
  }

  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    throw new UtcTimestampError(`Invalid timestamp: ${value}`)
  }
  return date.toISOString() as UtcTimestamp
}

export interface UtcRange {
  /** Inclusive lower bound. */
  readonly fromInclusive?: UtcTimestamp
  /** Exclusive upper bound. */
  readonly toExclusive?: UtcTimestamp
}

export function utcRange(
  fromInclusive?: Date | string,
  toExclusive?: Date | string,
): UtcRange {
  const normalized = normalizeUtcRange({
    fromInclusive:
      fromInclusive === undefined ? undefined : asUtcTimestamp(fromInclusive),
    toExclusive:
      toExclusive === undefined ? undefined : asUtcTimestamp(toExclusive),
  })
  if (!normalized) throw new UtcTimestampError('UTC range is required')
  return normalized
}

export function normalizeUtcRange(range?: UtcRange): UtcRange | undefined {
  if (range === undefined) return undefined

  const normalized: UtcRange = {
    fromInclusive:
      range.fromInclusive === undefined
        ? undefined
        : asUtcTimestamp(range.fromInclusive),
    toExclusive:
      range.toExclusive === undefined
        ? undefined
        : asUtcTimestamp(range.toExclusive),
  }
  if (
    normalized.fromInclusive !== undefined &&
    normalized.toExclusive !== undefined &&
    Date.parse(normalized.fromInclusive) >= Date.parse(normalized.toExclusive)
  ) {
    throw new UtcTimestampError(
      'UTC range requires fromInclusive to be before toExclusive',
    )
  }
  return normalized
}

export interface PageRequest {
  /** Requested number of rows. Adapters must enforce the shared upper bound. */
  readonly limit?: number
  /** Opaque continuation token returned by the previous page. */
  readonly cursor?: string | null
}

export interface NormalizedPageRequest {
  readonly limit: number
  readonly cursor: string | null
}

export interface Page<TRow> {
  readonly items: readonly TRow[]
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

export function normalizePageRequest(
  page?: PageRequest,
): NormalizedPageRequest {
  const limit = page?.limit ?? DEFAULT_PAGE_SIZE
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new PaginationError(
      `Page limit must be an integer between 1 and ${MAX_PAGE_SIZE}`,
    )
  }

  const cursor = page?.cursor ?? null
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0)) {
    throw new PaginationError('Page cursor must be a non-empty opaque string')
  }

  return { limit, cursor }
}

export interface QueryRequest<
  TParams extends DataStoreParams = DataStoreParams,
> {
  /** Semantic operation name resolved by an adapter-owned allowlist. */
  readonly operation: string
  readonly params?: TParams
  readonly page?: PageRequest
  readonly range?: UtcRange
}

export interface DataStoreCommand<
  TParams extends DataStoreParams = DataStoreParams,
> {
  /** Semantic mutation name resolved by an adapter-owned allowlist. */
  readonly operation: string
  readonly params?: TParams
}

export interface DataStoreSecurityContract {
  /** Execution is server-owned; browser/database direct access is out of scope. */
  readonly execution: 'server-runtime'
  /** The runtime principal is not a database owner. */
  readonly owner: false
  /** The runtime principal cannot bypass row-level authorization. */
  readonly bypassRowSecurity: false
}

export const DATASTORE_SECURITY_CONTRACT = Object.freeze({
  execution: 'server-runtime',
  owner: false,
  bypassRowSecurity: false,
} satisfies DataStoreSecurityContract)

export interface DataStoreTransaction {
  readonly actor: ActorContext

  query<TRow, TParams extends DataStoreParams = DataStoreParams>(
    request: QueryRequest<TParams>,
  ): Promise<Page<TRow>>

  execute<TResult, TParams extends DataStoreParams = DataStoreParams>(
    command: DataStoreCommand<TParams>,
  ): Promise<TResult>
}

export interface DataStore {
  readonly security: DataStoreSecurityContract

  query<TRow, TParams extends DataStoreParams = DataStoreParams>(
    actor: ActorContext,
    request: QueryRequest<TParams>,
  ): Promise<Page<TRow>>

  transaction<TResult>(
    actor: ActorContext,
    work: (transaction: DataStoreTransaction) => Promise<TResult>,
  ): Promise<TResult>
}

export function assertOperationName(operation: string): string {
  if (typeof operation !== 'string' || operation.trim() === '') {
    throw new DataStoreContractError(
      'OPERATION_INVALID',
      'DataStore operation name must be non-empty',
    )
  }
  return operation
}
