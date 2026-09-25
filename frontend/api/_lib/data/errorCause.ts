/**
 * What actually failed inside a rolled-back transaction.
 *
 * `NeonDataStore.transaction` (and the fake) rethrow anything the work callback
 * throws as `DataStoreTransactionError(TRANSACTION_INVALID)`, with the original
 * kept as a non-enumerable `cause`. That is right for the contract — callers see
 * one error type — but a handler that checks `instanceof ReplyReviewConflictError`
 * on the wrapper never matches, so a stale-revision conflict, a not-found or a
 * validation failure raised mid-transaction became a generic 500 "Could not save
 * reply review". Handlers classify the cause; logs carry its SQLSTATE.
 */
import { DataStoreTransactionError } from './contracts.js'

/** The error the transaction work threw, or `error` itself when it was not wrapped. */
export function transactionCause(error: unknown): unknown {
  if (error instanceof DataStoreTransactionError) {
    const cause = (error as { cause?: unknown }).cause
    if (cause !== undefined && cause !== null) return transactionCause(cause)
  }
  return error
}

/**
 * The PostgreSQL SQLSTATE behind `error`, following `cause` links. A SQLSTATE
 * is five characters from a fixed catalogue, so unlike the driver's message it
 * cannot carry a hostname or a row value and is safe to log and to branch on.
 */
export function sqlStateOf(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return null
}

/**
 * The message of a PostgreSQL error raised by one of the baseline's own
 * functions (`RAISE EXCEPTION USING message = ...`), which is authored text and
 * safe to return; null for anything else.
 */
export function raisedMessageOf(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const { code, message } = current as { code?: unknown; message?: unknown }
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && typeof message === 'string') return message
    current = (current as { cause?: unknown }).cause
  }
  return null
}
