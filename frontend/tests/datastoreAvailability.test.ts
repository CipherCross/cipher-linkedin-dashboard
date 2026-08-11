/**
 * Telling "the database was not reached" apart from "your membership was refused".
 *
 * S27 opened on an intermittent 500 that a live session could not reproduce, and
 * the reason it could not be diagnosed is that every candidate cause reached the
 * log as one label. These tests are the classification that replaced it, and
 * they are written so that the two causes the handoff actually suspects —
 * connection pressure, and a credential that outlived a repair — come out as
 * different answers rather than the same one.
 *
 * The connect-phase case is exercised against a real socket that refuses, not a
 * stub: it is the one of the three that can be produced offline, and producing it
 * proves the classifier is wired into the driver rather than merely correct in
 * isolation.
 */
import { describe, expect, it } from 'vitest'

import {
  DataStoreAuthorizationError,
  DataStoreContractError,
  DataStoreSchemaError,
  DataStoreUnavailableError,
} from '../api/_lib/data/contracts.js'
import { NeonDataStore, unavailableCodeFor } from '../api/_lib/data/neon.js'
import { buildApplicationRegistry } from '../api/_lib/data/operations/index.js'
import { unavailableResponse } from '../api/_lib/data/availability.js'
import { AuthorizationError } from '../api/_lib/auth.js'

/** A driver error shaped the way `pg` shapes one. */
function pgError(code: string, message = 'driver text'): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

describe('classifying a failure as unavailability', () => {
  it('names a refused login, in either phase, as the credential', () => {
    // 28P01 is the shape N-UITOP's password-less roles produced, and it is the
    // one cause that no retry clears — so it must not share a code with the two
    // that a retry does clear.
    expect(unavailableCodeFor(pgError('28P01'), 'connect')).toBe(
      'DATASTORE_CREDENTIAL_REJECTED',
    )
    expect(unavailableCodeFor(pgError('28000'), 'statement')).toBe(
      'DATASTORE_CREDENTIAL_REJECTED',
    )
  })

  it('splits a connection exception by the phase that met it', () => {
    // The same SQLSTATE means two different things: never had a connection, or
    // lost one that worked. That distinction is the whole diagnostic value.
    expect(unavailableCodeFor(pgError('08006'), 'connect')).toBe(
      'DATASTORE_CONNECT_FAILED',
    )
    expect(unavailableCodeFor(pgError('08006'), 'statement')).toBe(
      'DATASTORE_CONNECTION_LOST',
    )
  })

  it('recognises the ways a serverless instance loses a warm socket', () => {
    for (const error of [
      pgError('57P01'),
      pgError('57P03'),
      pgError('ECONNRESET'),
      pgError('EPIPE'),
      new Error('Connection terminated unexpectedly'),
    ]) {
      expect(unavailableCodeFor(error, 'statement')).toBe(
        'DATASTORE_CONNECTION_LOST',
      )
    }
  })

  it("reads the database's own connection ceiling as pressure", () => {
    expect(unavailableCodeFor(pgError('53300'), 'statement')).toBe(
      'DATASTORE_CONNECT_FAILED',
    )
  })

  it('treats every unexplained acquisition failure as pressure', () => {
    // A pool that reached its ceiling and waited out `connectionTimeoutMillis`
    // throws a plain Error with no code at all. That is exactly the connection-
    // pressure hypothesis, so it must not fall through to "unclassified".
    expect(
      unavailableCodeFor(new Error('timeout exceeded when trying to connect'), 'connect'),
    ).toBe('DATASTORE_CONNECT_FAILED')
  })

  it('declines every failure that is about the statement', () => {
    // The narrowing that keeps this from swallowing the existing contract: a
    // refused privilege, a cancelled statement and a missing relation are
    // answers, and each already has a class of its own.
    expect(unavailableCodeFor(pgError('42501'), 'statement')).toBeNull()
    expect(unavailableCodeFor(pgError('57014'), 'statement')).toBeNull()
    expect(unavailableCodeFor(pgError('42P01'), 'statement')).toBeNull()
    expect(unavailableCodeFor(new Error('anything'), 'statement')).toBeNull()
  })
})

describe('the driver raises it end to end', () => {
  it('answers a refused socket with a named acquisition failure', async () => {
    // Port 1 on loopback refuses immediately. No database, no fixture, and the
    // path under test is the real `pool.connect()` catch.
    const store = new NeonDataStore({
      connectionString: 'postgresql://nobody:nothing@127.0.0.1:1/nowhere',
      operations: buildApplicationRegistry(),
      connectionTimeoutMs: 2_000,
      applicationName: 'availability-test',
    })
    try {
      const failure = await store
        .resolveActor({ provider: 'identity', subject: 'anyone' })
        .then(
          () => null,
          (error: unknown) => error,
        )
      expect(failure).toBeInstanceOf(DataStoreUnavailableError)
      expect((failure as DataStoreUnavailableError).code).toBe(
        'DATASTORE_CONNECT_FAILED',
      )
      // The rule the whole module is written under: no driver text escapes, so
      // the host cannot leak through an alert.
      expect((failure as Error).message).not.toContain('127.0.0.1')
    } finally {
      await store.close()
    }
  })
})

describe('the response an endpoint gives for it', () => {
  it('offers a retry for the two transient causes, and names the code', async () => {
    for (const code of [
      'DATASTORE_CONNECT_FAILED',
      'DATASTORE_CONNECTION_LOST',
    ] as const) {
      const response = unavailableResponse(
        new DataStoreUnavailableError(code, 'Acquiring a database connection'),
      )
      expect(response?.status).toBe(503)
      const body = (await response!.json()) as { error: string }
      expect(body.error).toContain(code)
      expect(body.error).toContain('retry in a moment')
      // The defect this replaced: a membership claim for a check never made.
      expect(body.error).not.toContain('team access')
    }
  })

  it('refuses to suggest a retry for a rejected credential', async () => {
    const response = unavailableResponse(
      new DataStoreUnavailableError(
        'DATASTORE_CREDENTIAL_REJECTED',
        'Acquiring a database connection',
      ),
    )
    expect(response?.status).toBe(500)
    const body = (await response!.json()) as { error: string }
    expect(body.error).toContain('DATASTORE_CREDENTIAL_REJECTED')
    expect(body.error).toContain('retrying will not help')
  })

  it('declines everything else, so no call site loses its own handling', () => {
    expect(unavailableResponse(new AuthorizationError(403, 'nope'))).toBeNull()
    expect(unavailableResponse(new DataStoreAuthorizationError('nope'))).toBeNull()
    expect(unavailableResponse(new DataStoreSchemaError('absent'))).toBeNull()
    expect(unavailableResponse(new DataStoreContractError('OTHER', 'x'))).toBeNull()
    expect(unavailableResponse(new Error('x'))).toBeNull()
    expect(unavailableResponse(null)).toBeNull()
  })
})
