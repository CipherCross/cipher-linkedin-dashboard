/**
 * Server-only configuration for the identity layer, and the session policy
 * decisions `G3` requires S17 to take deliberately.
 *
 * Three credentials, three separate things, deliberately not interchangeable:
 *
 * - `IDENTITY_STORE_DATABASE_URL` — the `identity_store` login. It reaches the
 *   `identity` schema and **nothing else**: the role holds no `USAGE` on
 *   `public` and `SELECT` on no relation there, asserted by
 *   `postgres/tests/portable_identity_store_isolation_assertions.sql`. This is
 *   never the `app_runtime` credential; the two pools are separate on purpose,
 *   because a compromise of the identity service must not be a read of the
 *   workspace it authenticates people into.
 * - `IDENTITY_SESSION_SECRET` — what the candidate signs session cookies with.
 *   Not a database credential, and must not be the same value as one.
 * - `IDENTITY_BASE_URL` — the deployment's own origin. It decides two
 *   security-relevant things (below), so it is required rather than derived
 *   from an incoming request, which an attacker controls.
 *
 * The pattern for reading them is `neonConfig.ts`'s, unchanged: refuse a
 * `VITE_` name, refuse to resolve in a browser, and fail with an explanatory
 * error rather than falling back to anything.
 */

import { DataStoreContractError } from '../data/contracts.js'

/** The `identity_store` login. Server-only. */
export const IDENTITY_STORE_DATABASE_URL_ENV = 'IDENTITY_STORE_DATABASE_URL'
/** The cookie-signing secret. Server-only, and not a database credential. */
export const IDENTITY_SESSION_SECRET_ENV = 'IDENTITY_SESSION_SECRET'
/** This deployment's own origin, e.g. `https://dashboard.example.com`. */
export const IDENTITY_BASE_URL_ENV = 'IDENTITY_BASE_URL'

/**
 * The path the candidate's own routes are mounted under, and the single
 * serverless function that serves them.
 *
 * `identity`, not `auth`: the Vercel function budget is full at 12 (B3), so
 * this endpoint exists because `reclassify.ts` was folded into `classify.ts` to
 * free the slot. It is one function serving an allowlisted operation
 * vocabulary, which is the same shape B3 forced on S13's reads.
 */
export const IDENTITY_BASE_PATH = '/api/identity'

/** What the candidate writes into `public.user_identities.provider`. */
export const IDENTITY_PROVIDER_NAME = 'better-auth'

export type EnvSource = Readonly<Record<string, string | undefined>>

export class IdentityConfigurationError extends DataStoreContractError {
  constructor(message: string) {
    super('IDENTITY_CONFIGURATION_MISSING', message)
    this.name = 'IdentityConfigurationError'
  }
}

function assertServerSide(name: string): void {
  if (typeof window !== 'undefined') {
    throw new IdentityConfigurationError(
      `${name} is server-only and must not be resolved in a browser context`,
    )
  }
  if (name.startsWith('VITE_')) {
    throw new IdentityConfigurationError(
      `${name} is browser-exposed; an identity credential must never use a VITE_ prefix`,
    )
  }
}

function readRequired(env: EnvSource, name: string, purpose: string): string {
  assertServerSide(name)
  const value = env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IdentityConfigurationError(
      `${name} is not set. ${purpose} Set it in the server environment ` +
        `(never as VITE_${name}) and re-run. Refusing to continue: an ` +
        `unconfigured identity layer would report success while ` +
        `authenticating nobody.`,
    )
  }
  return value.trim()
}

/**
 * Session lifetime. **C4's deliberate choice, not the candidate's default.**
 *
 * The default is 7 days. F9 measured that the session token does **not** rotate
 * while a session slides forward, so the window is exactly how long a captured
 * cookie stays useful once it stops being refreshed. Twelve hours means a
 * cookie stolen from a closed laptop is dead by morning, while an SDR working a
 * normal day signs in once.
 *
 * What this does *not* bound: a cookie an attacker actively uses slides forward
 * like any other, because `updateAge` refreshes expiry without issuing a new
 * token. That is F9's accepted limit, and the answer to it is revocation, which
 * F5 measured as immediate and available in two independent places — not a
 * shorter `expiresIn`.
 */
export const SESSION_EXPIRES_IN_SECONDS = 12 * 60 * 60

/**
 * How often a live session's expiry is pushed forward. One hour keeps the write
 * rate low while making the sliding window granular enough that an active user
 * is never logged out mid-task.
 */
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60

/**
 * How long after sign-in a session still counts as "fresh" for operations the
 * candidate gates on freshness. Kept equal to `updateAge` rather than left to
 * the default so it is a decision rather than an inheritance.
 */
export const SESSION_FRESH_AGE_SECONDS = 60 * 60

/**
 * Minimum interval between two pruning sweeps from one function instance (C4).
 * The sweep is a cheap indexed delete of already-expired rows, so this exists
 * to stop it running on every request, not because it is expensive.
 */
export const SESSION_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface IdentityRuntimeConfig {
  readonly connectionString: string
  readonly sessionSecret: string
  readonly baseUrl: string
  readonly basePath: string
  /**
   * Whether the session cookie carries `Secure`.
   *
   * Derived from `baseUrl`'s scheme, deliberately **not** from `NODE_ENV`. F2
   * measured the trap in both directions: the candidate keys this off
   * `NODE_ENV === 'production'` by default, and a `Secure` cookie sent over
   * plain HTTP is dropped by the browser, so the next request is anonymous. The
   * scheme of the origin we actually serve is the only thing that answers this
   * correctly.
   */
  readonly useSecureCookies: boolean
}

function readBaseUrl(env: EnvSource): string {
  const raw = readRequired(
    env,
    IDENTITY_BASE_URL_ENV,
    `The identity layer needs this deployment's own origin: it is what the ` +
      `candidate validates the Origin header against, and what decides ` +
      `whether the session cookie is marked Secure.`,
  )

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new IdentityConfigurationError(
      `${IDENTITY_BASE_URL_ENV} must be an absolute URL such as https://example.com`,
    )
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new IdentityConfigurationError(
      `${IDENTITY_BASE_URL_ENV} must be an http or https URL`,
    )
  }
  // A trailing slash changes string comparisons against the Origin header,
  // which never carries one. Normalize once, here.
  return parsed.origin
}

/**
 * The session secret has to be long enough to be worth signing with. Sixteen
 * bytes of hex is the floor; the documented instruction is 32 bytes.
 */
const MIN_SESSION_SECRET_LENGTH = 32

export function readIdentityConfig(
  env: EnvSource = process.env,
): IdentityRuntimeConfig {
  const connectionString = readRequired(
    env,
    IDENTITY_STORE_DATABASE_URL_ENV,
    `The identity store needs the server-only identity_store login, which ` +
      `reaches the identity schema and nothing else.`,
  )
  const sessionSecret = readRequired(
    env,
    IDENTITY_SESSION_SECRET_ENV,
    `The identity layer needs a cookie-signing secret, which is not a ` +
      `database credential and must not be one.`,
  )
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new IdentityConfigurationError(
      `${IDENTITY_SESSION_SECRET_ENV} must be at least ` +
        `${MIN_SESSION_SECRET_LENGTH} characters; generate one with ` +
        `\`openssl rand -hex 32\``,
    )
  }
  if (sessionSecret === connectionString) {
    throw new IdentityConfigurationError(
      `${IDENTITY_SESSION_SECRET_ENV} must not be the database credential`,
    )
  }

  const baseUrl = readBaseUrl(env)

  return {
    connectionString,
    sessionSecret,
    baseUrl,
    basePath: IDENTITY_BASE_PATH,
    useSecureCookies: new URL(baseUrl).protocol === 'https:',
  }
}
