/**
 * Server-only resolution of the Neon runtime connection string.
 *
 * The credential is read from the process environment and never from a
 * `VITE_`-prefixed variable, so it cannot reach the browser bundle. Callers
 * that need a store but have no credential get a hard, explanatory failure —
 * there is no fallback to a fake and no silent skip.
 */

import { DataStoreContractError } from './contracts.js'

/** Pooled endpoint. This is what serverless request handling should use. */
export const NEON_DATABASE_URL_ENV = 'NEON_DATABASE_URL'
/**
 * Direct (non-pooled) endpoint. Optional. Needed only where genuine session
 * state is required — session advisory locks, `LISTEN`/`NOTIFY`, long
 * migrations — none of which the request path uses.
 */
export const NEON_DIRECT_DATABASE_URL_ENV = 'NEON_DATABASE_URL_UNPOOLED'

export type EnvSource = Readonly<Record<string, string | undefined>>

export class NeonConfigurationError extends DataStoreContractError {
  constructor(message: string) {
    super('NEON_CONFIGURATION_MISSING', message)
    this.name = 'NeonConfigurationError'
  }
}

function assertServerSide(): void {
  if (typeof window !== 'undefined') {
    throw new NeonConfigurationError(
      'The Neon connection string is server-only and must not be resolved in a browser context',
    )
  }
}

function readRequired(env: EnvSource, name: string, purpose: string): string {
  assertServerSide()

  if (name.startsWith('VITE_')) {
    throw new NeonConfigurationError(
      `${name} is browser-exposed; the Neon connection string must never use a VITE_ prefix`,
    )
  }

  const value = env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NeonConfigurationError(
      `${name} is not set. ${purpose} needs a server-only PostgreSQL connection string ` +
        `for the least-privilege runtime role. Set it in the server environment ` +
        `(never as VITE_${name}) and re-run. Refusing to continue: an unconfigured ` +
        `data store would report success without touching a database.`,
    )
  }
  return value.trim()
}

export function readNeonConnectionString(
  env: EnvSource = process.env,
): string {
  return readRequired(env, NEON_DATABASE_URL_ENV, 'The Neon data store')
}

export function readNeonDirectConnectionString(
  env: EnvSource = process.env,
): string {
  const explicit = env[NEON_DIRECT_DATABASE_URL_ENV]
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    assertServerSide()
    return explicit.trim()
  }
  // Neon exposes the pooled endpoint as the `-pooler` variant of the same
  // host, so the direct endpoint is derivable without a second secret.
  return toDirectConnectionString(readNeonConnectionString(env))
}

/** Strip Neon's pooled-endpoint marker from a connection string's host. */
export function toDirectConnectionString(connectionString: string): string {
  return connectionString.replace(/-pooler(?=\.[^/@]*)/, '')
}

export function isPooledConnectionString(connectionString: string): boolean {
  return /-pooler\./.test(connectionString)
}
