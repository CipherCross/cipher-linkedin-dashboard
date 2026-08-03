import {
  assertActorContext,
  assertOperationName,
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

export interface FakeState {
  read<TValue>(key: string): TValue | undefined
  write<TValue>(key: string, value: TValue): void
  delete(key: string): void
}

export interface FakeQueryContext<TParams> {
  readonly actor: ActorContext
  readonly params: TParams | undefined
  readonly page: NormalizedPageRequest
  readonly range: UtcRange | undefined
  readonly state: FakeState
}

export interface FakeCommandContext<TParams> {
  readonly actor: ActorContext
  readonly params: TParams | undefined
  readonly state: FakeState
}

export type FakeQueryHandler<
  TRow,
  TParams extends DataStoreParams = DataStoreParams,
> = (
  context: FakeQueryContext<TParams>,
) => readonly TRow[] | Promise<readonly TRow[]>

export type FakeCommandHandler<
  TResult,
  TParams extends DataStoreParams = DataStoreParams,
> = (
  context: FakeCommandContext<TParams>,
) => TResult | Promise<TResult>

type StoredQueryHandler = (
  context: FakeQueryContext<DataStoreParams>,
) => readonly unknown[] | Promise<readonly unknown[]>

type StoredCommandHandler = (
  context: FakeCommandContext<DataStoreParams>,
) => unknown | Promise<unknown>

interface StoredQuery {
  readonly execute: StoredQueryHandler
  readonly authorize?: (actor: ActorContext) => void
}

interface StoredCommand {
  readonly execute: StoredCommandHandler
  readonly authorize?: (actor: ActorContext) => void
}

interface CursorState {
  readonly queryScope: string
  readonly tenantId: string
  readonly actorId: string
  readonly offset: number
}

class MapFakeState implements FakeState {
  constructor(private readonly values: Map<string, unknown>) {}

  read<TValue>(key: string): TValue | undefined {
    return this.values.get(key) as TValue | undefined
  }

  write<TValue>(key: string, value: TValue): void {
    this.values.set(key, value)
  }

  delete(key: string): void {
    this.values.delete(key)
  }

  clone(): MapFakeState {
    return new MapFakeState(
      new Map(
        [...this.values.entries()].map(([key, value]) => [
          key,
          cloneValue(value),
        ]),
      ),
    )
  }
}

function toTransactionError(error: unknown): Error {
  if (error instanceof DataStoreContractError) return error
  const message = error instanceof Error ? error.message : String(error)
  const wrapped = new DataStoreTransactionError(
    `Transaction failed and was rolled back: ${message}`,
  )
  Object.defineProperty(wrapped, 'cause', {
    value: error,
    configurable: true,
    writable: true,
    enumerable: false,
  })
  return wrapped
}

function cloneValue<TValue>(value: TValue): TValue {
  if (value instanceof Date) return new Date(value.valueOf()) as TValue
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as TValue
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
    ) as TValue
  }
  return value
}

/**
 * In-memory implementation used by contract tests and future adapter tests.
 * It intentionally models authorization, opaque cursor scope and atomic
 * transaction snapshots without pretending to be a database or SQL engine.
 */
export class FakeDataStore implements DataStore {
  readonly security: DataStoreSecurityContract = DATASTORE_SECURITY_CONTRACT

  private state: MapFakeState
  private readonly queries = new Map<string, StoredQuery>()
  private readonly commands = new Map<string, StoredCommand>()
  private readonly cursors = new Map<string, CursorState>()
  private nextCursorId = 1
  private transactionActive = false

  constructor(initialState: Readonly<Record<string, unknown>> = {}) {
    this.state = new MapFakeState(new Map(Object.entries(initialState)))
  }

  seed<TValue>(key: string, value: TValue): void {
    this.state.write(key, value)
  }

  read<TValue>(key: string): TValue | undefined {
    return this.state.read<TValue>(key)
  }

  registerQuery<TRow, TParams extends DataStoreParams = DataStoreParams>(
    operation: string,
    execute: FakeQueryHandler<TRow, TParams>,
    authorize?: (actor: ActorContext) => void,
  ): void {
    this.queries.set(assertOperationName(operation), {
      execute: execute as unknown as StoredQueryHandler,
      authorize,
    })
  }

  registerCommand<TResult, TParams extends DataStoreParams = DataStoreParams>(
    operation: string,
    execute: FakeCommandHandler<TResult, TParams>,
    authorize?: (actor: ActorContext) => void,
  ): void {
    this.commands.set(assertOperationName(operation), {
      execute: execute as unknown as StoredCommandHandler,
      authorize,
    })
  }

  async query<TRow, TParams extends DataStoreParams = DataStoreParams>(
    actor: ActorContext,
    request: QueryRequest<TParams>,
  ): Promise<Page<TRow>> {
    return this.runQuery<TRow, TParams>(actor, request, this.state)
  }

  async transaction<TResult>(
    actor: ActorContext,
    work: (transaction: DataStoreTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    const validatedActor = assertActorContext(actor)
    if (this.transactionActive) {
      throw new DataStoreTransactionError('Nested transactions are not supported')
    }

    this.transactionActive = true
    const transactionState = this.state.clone()
    const transaction = new FakeTransaction(this, validatedActor, transactionState)

    try {
      const result = await work(transaction)
      this.state = transactionState
      return result
    } catch (error) {
      // Parity with a real adapter: the snapshot is discarded, and anything
      // that is not already a contract error is surfaced as a rolled-back
      // transaction with the original failure attached as `cause`.
      throw toTransactionError(error)
    } finally {
      transaction.close()
      this.transactionActive = false
    }
  }

  async runQuery<TRow, TParams extends DataStoreParams = DataStoreParams>(
    actor: ActorContext,
    request: QueryRequest<TParams>,
    state: FakeState,
  ): Promise<Page<TRow>> {
    const validatedActor = assertActorContext(actor)
    if (!request || typeof request !== 'object') {
      throw new DataStoreContractError(
        'QUERY_INVALID',
        'A query request is required',
      )
    }
    const operation = assertOperationName(request.operation)
    const definition = this.queries.get(operation)
    if (!definition) {
      throw new DataStoreAuthorizationError(
        `Query operation is not allowlisted: ${operation}`,
      )
    }
    definition.authorize?.(validatedActor)

    const page = normalizePageRequest(request.page)
    const range = normalizeUtcRange(request.range)
    const queryScope = createQueryScope(operation, request.params, range)
    const offset = page.cursor
      ? this.readCursor(page.cursor, queryScope, validatedActor)
      : 0
    const rows = await definition.execute({
      actor: validatedActor,
      params: request.params,
      page,
      range,
      state,
    } as unknown as FakeQueryContext<DataStoreParams>)

    const items = rows.slice(offset, offset + page.limit) as readonly TRow[]
    const hasMore = offset + items.length < rows.length
    const nextCursor = hasMore
      ? this.createCursor({
          queryScope,
          tenantId: validatedActor.tenantId,
          actorId: validatedActor.actorId,
          offset: offset + items.length,
        })
      : null

    return { items, hasMore, nextCursor }
  }

  async runCommand<TResult, TParams extends DataStoreParams = DataStoreParams>(
    actor: ActorContext,
    command: DataStoreCommand<TParams>,
    state: FakeState,
  ): Promise<TResult> {
    const validatedActor = assertActorContext(actor)
    if (!command || typeof command !== 'object') {
      throw new DataStoreContractError(
        'COMMAND_INVALID',
        'A data store command is required',
      )
    }
    const operation = assertOperationName(command.operation)
    const definition = this.commands.get(operation)
    if (!definition) {
      throw new DataStoreAuthorizationError(
        `Command operation is not allowlisted: ${operation}`,
      )
    }
    definition.authorize?.(validatedActor)
    return (await definition.execute({
      actor: validatedActor,
      params: command.params,
      state,
    } as unknown as FakeCommandContext<DataStoreParams>)) as TResult
  }

  private createCursor(cursor: CursorState): string {
    const token = `fake-cursor-${this.nextCursorId++}`
    this.cursors.set(token, cursor)
    return token
  }

  private readCursor(
    token: string,
    queryScope: string,
    actor: ActorContext,
  ): number {
    const cursor = this.cursors.get(token)
    if (
      !cursor ||
      cursor.queryScope !== queryScope ||
      cursor.tenantId !== actor.tenantId ||
      cursor.actorId !== actor.actorId
    ) {
      throw new PaginationError('Cursor is invalid or belongs to another scope')
    }
    return cursor.offset
  }
}

function createQueryScope(
  operation: string,
  params: DataStoreParams | undefined,
  range: UtcRange | undefined,
): string {
  return JSON.stringify({
    operation,
    params: params ?? null,
    range: range ?? null,
  })
}

class FakeTransaction implements DataStoreTransaction {
  private active = true

  constructor(
    private readonly store: FakeDataStore,
    readonly actor: ActorContext,
    private readonly state: FakeState,
  ) {}

  async query<TRow, TParams extends DataStoreParams = DataStoreParams>(
    request: QueryRequest<TParams>,
  ): Promise<Page<TRow>> {
    this.assertActive()
    return this.store.runQuery<TRow, TParams>(this.actor, request, this.state)
  }

  async execute<TResult, TParams extends DataStoreParams = DataStoreParams>(
    command: DataStoreCommand<TParams>,
  ): Promise<TResult> {
    this.assertActive()
    return this.store.runCommand<TResult, TParams>(
      this.actor,
      command,
      this.state,
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
