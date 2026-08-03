/**
 * The slice's handler must never log anything that can name the database.
 *
 * The hazard is not hypothetical and it is not in this file's control: the
 * driver wraps a failure as `` `${what}: ${originalMessage}` ``, and for a
 * connection-level failure the original message is raw driver text. Measured
 * against a deliberately unresolvable host, the wrapped message was:
 *
 *   Acquiring a database connection: getaddrinfo ENOTFOUND <host>
 *
 * So `error.message` is unsafe to log even though it is a contract error, and
 * the error object is worse. `safeErrorLabel` is the only thing that may reach
 * a log line.
 *
 * No database and no network: the hazard is reproduced by building the same
 * error shape the driver builds.
 */

import { describe, expect, it } from 'vitest'

import { safeErrorLabel } from '../api/activity-daily.js'
import {
  DataStoreAuthorizationError,
  DataStoreTransactionError,
  PaginationError,
} from '../api/_lib/data/contracts.js'

/** Assembled at runtime so no committed line looks like a real host. */
const HOST = ['db', 'canary', 'example'].join('-') + '.invalid'

describe('handler logging cannot name the database', () => {
  it('drops a hostname the driver embedded in the message', () => {
    const wrapped = new DataStoreTransactionError(
      `Acquiring a database connection: getaddrinfo ENOTFOUND ${HOST}`,
    )

    // The hazard, stated as an assertion so nobody has to trust the comment.
    expect(wrapped.message).toContain(HOST)

    const label = safeErrorLabel(wrapped)
    expect(label).not.toContain(HOST)
    expect(label).not.toContain('invalid')
    expect(label).toBe('DataStoreTransactionError/TRANSACTION_INVALID')
  })

  it('keeps enough to classify each contract failure', () => {
    expect(safeErrorLabel(new DataStoreAuthorizationError('denied'))).toBe(
      'DataStoreAuthorizationError/DATASTORE_AUTHORIZATION_DENIED',
    )
    expect(safeErrorLabel(new PaginationError('bad cursor'))).toBe(
      'PaginationError/PAGINATION_INVALID',
    )
  })

  it('never returns the message for a non-contract error either', () => {
    const raw = new Error(`connect ECONNREFUSED ${HOST}:5432`)
    const label = safeErrorLabel(raw)
    expect(label).not.toContain(HOST)
    expect(label).toBe('Error')
  })

  it('handles a thrown non-error without stringifying it', () => {
    expect(safeErrorLabel({ host: HOST })).toBe('UnknownError')
    expect(safeErrorLabel(HOST)).toBe('UnknownError')
    expect(safeErrorLabel(undefined)).toBe('UnknownError')
  })
})
