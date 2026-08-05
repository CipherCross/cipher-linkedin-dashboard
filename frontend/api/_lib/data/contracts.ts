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

/**
 * An operation named a relation the database does not have.
 *
 * **This is the first widening of the S03 contract, and it exists for exactly
 * one caller need.** `DataContext` today swallows the errors of ten reads so a
 * database missing a not-yet-applied table yields `[]` rather than a failed
 * dashboard load — the Search Library, the ICP/Hypothesis layer, the follow-up
 * projections, the pipeline audit log. Preserving that through an API means the
 * handler has to distinguish "this relation is absent" from every other failure,
 * and it cannot do so without a structural signal:
 *
 * - **It must not read the error's message.** The driver composes a failure as
 *   `` `${what}: ${originalMessage}` ``, and for a connection-level failure the
 *   original text embeds the database hostname — which is why
 *   `safeErrorLabel` in the endpoint logs `name`/`code` and nothing else.
 *   String-matching `does not exist`, the way the Supabase path's
 *   `isMissingRelation` must, would put the handler back in the business of
 *   parsing driver text.
 * - **It must not be the driver's own decision.** Tolerating a missing relation
 *   is a *product* judgement about one read; an adapter that quietly returned
 *   zero rows for an absent table would make every read tolerant, including the
 *   funnel reads where an empty result is a wrong answer rather than a blank
 *   panel.
 *
 * So the adapter classifies and the caller decides. Any `DataStore`
 * implementation can raise this; the Neon adapter raises it for SQLSTATE 42P01
 * (`undefined_table`) and **only** for that. A missing *column* is deliberately
 * not this error — see `operations/leads.ts` on why the column ladders do not
 * survive the move.
 */
export class DataStoreSchemaError extends DataStoreContractError {
  constructor(message: string) {
    super('SCHEMA_OBJECT_MISSING', message)
    this.name = 'DataStoreSchemaError'
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

/**
 * A canonical actor, as the database resolved it from a provider subject.
 *
 * The `role` comes from `public.team_members` and never from the identity
 * provider's own state. That is the whole point: an account whose provider-side
 * role claims `admin` while `team_members.role` says `member` resolves as
 * **member**, so privilege originates in the database and the provider is a
 * replaceable component rather than an authority.
 */
export interface ResolvedActor {
  readonly actorId: string
  readonly role: 'member' | 'admin'
}

/**
 * The single allowlisted actorless operation name.
 *
 * Defined here rather than in the operations registry because both the adapter
 * and the registry need it, and the adapter must not import the application's
 * operation modules — they import it.
 */
export const RESOLVE_ACTOR_OPERATION = 'identity.resolveActor'

export interface ResolveActorRequest {
  /** `public.user_identities.provider`, e.g. `better-auth`. */
  readonly provider: string
  /** The identity-provider subject, never a canonical user id. */
  readonly subject: string
}

export interface DataStore {
  readonly security: DataStoreSecurityContract

  query<TRow, TParams extends DataStoreParams = DataStoreParams>(
    actor: ActorContext,
    request: QueryRequest<TParams>,
  ): Promise<Page<TRow>>

  /**
   * Turn a verified provider subject into a canonical actor, or `null`.
   *
   * The one read that runs with **no actor published**, because it is what
   * establishes the actor — everything after it in a request is actor-scoped.
   *
   * `null` covers an unknown subject, an inactive user and an inactive
   * membership without distinguishing between them, so a caller learns nothing
   * about who exists. Matching is by equality, so it is not an enumeration
   * primitive.
   */
  resolveActor(request: ResolveActorRequest): Promise<ResolvedActor | null>

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
