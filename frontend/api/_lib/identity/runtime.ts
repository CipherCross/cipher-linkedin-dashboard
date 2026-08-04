/**
 * The process-wide identity provider, and the session pruning job (C4).
 *
 * Module scope for the same reason `data/store.ts` is: a serverless function
 * that builds a connection pool per invocation throws it away every time. S11
 * measured a warm pooled read at p50 158.9 ms against 578.8 ms with the store
 * constructed per call. Lazily constructed, so importing a handler never
 * requires a credential and a type-check or a test can import this module
 * without touching a database.
 */

import { readIdentityConfig, SESSION_PRUNE_INTERVAL_MS } from './config.js'
import { BetterAuthIdentityProvider } from './betterAuthProvider.js'
import type { IdentityProvider } from './provider.js'

let provider: IdentityProvider | null = null

export function getIdentityProvider(): IdentityProvider {
  if (!provider) {
    provider = new BetterAuthIdentityProvider({ config: readIdentityConfig() })
  }
  return provider
}

/** True once a provider exists, so a test can assert the instance is reused. */
export function identityProviderExists(): boolean {
  return provider !== null
}

/**
 * Drop the shared provider. For tests and graceful shutdown — never the request
 * path, which must not close a provider other requests are using.
 */
export async function resetIdentityProvider(): Promise<void> {
  const existing = provider
  provider = null
  lastPruneAt = null
  if (existing) await existing.close()
}

/**
 * When this instance last swept, or `null` for "never".
 *
 * `null` rather than `0`, and the distinction is not cosmetic: with `0` the first
 * sweep is due only once `now` exceeds the interval, so a fresh instance would
 * silently skip its first sweep. Real wall-clock time hides that — `Date.now()`
 * is always far past any interval — which is exactly why it needed a test with an
 * injected clock to surface, and exactly why it is worth spelling out here.
 */
let lastPruneAt: number | null = null
let pruneInFlight: Promise<void> | null = null

/**
 * The pruning job C4 requires (F9).
 *
 * **Why it is not a Vercel cron.** C1 forbids any S17 endpoint changing state on
 * a `GET`, because the origin check exempts `GET` by design — and Vercel's cron
 * scheduler only issues `GET`. Rather than carve out an exception to the one rule
 * whose whole purpose is that there are no exceptions, pruning is triggered from
 * inside the request path: at most once per `SESSION_PRUNE_INTERVAL_MS` per
 * function instance. The endpoint also exposes it as an explicit `POST`
 * operation, so it can be driven deliberately by an operator or a machine
 * caller.
 *
 * **Why this is safe to do in a request.** It deletes only rows that have
 * already expired, so it can never end a live session; the delete is indexed;
 * and it is awaited but fully guarded, so a failure is logged and the request
 * continues. It never affects the response.
 *
 * The trade, stated plainly: a fleet of cold starts prunes more often than a
 * single warm instance would, and an instance that never serves a request never
 * prunes. Both are acceptable for a table that grows by one row per abandoned
 * login for a four-person team, and neither is a correctness problem — an
 * expired row is never honoured.
 */
export async function pruneSessionsIfDue(
  identity: IdentityProvider,
  now: number = Date.now(),
): Promise<void> {
  if (lastPruneAt !== null && now - lastPruneAt < SESSION_PRUNE_INTERVAL_MS) return
  // Collapse concurrent callers onto one sweep rather than issuing several.
  if (pruneInFlight) return pruneInFlight

  lastPruneAt = now
  pruneInFlight = (async () => {
    try {
      await identity.pruneExpiredSessions()
    } catch (error) {
      // Never fail a request because housekeeping failed, and never log the
      // error's message: S12 measured that a driver-level failure embeds the
      // database hostname, which must not reach a log line.
      console.warn(
        'identity: session pruning failed:',
        error instanceof Error ? error.name : 'UnknownError',
      )
    } finally {
      pruneInFlight = null
    }
  })()
  return pruneInFlight
}

/** Reset the pruning clock. Tests only. */
export function resetPruneClock(): void {
  lastPruneAt = null
  pruneInFlight = null
}
