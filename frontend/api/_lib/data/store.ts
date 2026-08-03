/**
 * The application's shared Neon `DataStore`, held at **module scope**.
 *
 * Why module scope: S11 measured a warm pooled actor-scoped read at p50
 * 158.9 ms and the same read with the store constructed per call at p50
 * 578.8 ms, from a dev host. A serverless function that builds a store per
 * invocation throws the connection pool away every time. Module scope means a
 * warm Vercel invocation reuses the pool; a cold start pays the connect once.
 *
 * Consequences that follow from that choice, and are therefore enforced here:
 *
 * - The pool ceiling is small. Many concurrent function instances each hold
 *   their own pool, and Neon's connection budget is shared across all of them,
 *   so a large `max` per instance is how a serverless deployment exhausts a
 *   database. Two is enough for a request that issues one query.
 * - The store is created lazily, on first use, not at import. Importing a
 *   handler must not require a credential — the API surface has to stay
 *   importable by a type-check or a test that never touches a database.
 * - The credential is resolved by `neonConfig.ts`, which refuses `VITE_` names
 *   and refuses to resolve in a browser context.
 */

import type { DataStore } from './contracts.js'
import { NeonDataStore } from './neon.js'
import { readNeonConnectionString } from './neonConfig.js'
import { buildApplicationRegistry } from './operations/index.js'

/**
 * Below the pooled endpoint's own ceiling and small enough that many warm
 * function instances do not add up to Neon's connection limit.
 */
const MAX_CONNECTIONS = 2

/**
 * Shorter than Vercel's `maxDuration` for these handlers (10 s) so a query that
 * hangs is aborted by the database with SQLSTATE 57014 — which the driver turns
 * into a `DataStoreTransactionError` — rather than by the platform killing the
 * function with no diagnosis.
 */
const STATEMENT_TIMEOUT_MS = 8_000

let store: NeonDataStore | null = null

/**
 * The process-wide store. Lazily constructed, then reused for the lifetime of
 * the function instance.
 */
export function getDataStore(): DataStore {
  if (!store) {
    store = new NeonDataStore({
      connectionString: readNeonConnectionString(),
      operations: buildApplicationRegistry(),
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      maxConnections: MAX_CONNECTIONS,
      applicationName: 'lh2-dashboard',
    })
  }
  return store
}

/** True once a store exists, so a test can assert the instance is reused. */
export function dataStoreExists(): boolean {
  return store !== null
}

/**
 * Drop the shared store. For tests and for a graceful shutdown — not part of
 * the request path, which must never close a store other requests are using.
 */
export async function resetDataStore(): Promise<void> {
  const existing = store
  store = null
  if (existing) await existing.close()
}
