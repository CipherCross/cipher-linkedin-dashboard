/**
 * The application operation registry — the allowlist of everything the
 * request path is permitted to ask the database for.
 *
 * This is the *application's* registry. The registries under
 * `frontend/tests/support/` are contract fixtures and deliberately stay there;
 * they exercise the adapter, not the product.
 *
 * Rules for anything added here:
 *
 * 1. One named operation per read. Handlers submit names, never SQL.
 * 2. S12 registers **no command**. The slice is read-only, so there is no
 *    write path to reach even by mistake; `registerCommand` is simply not
 *    called. S14 owns the first writes.
 * 3. An operation's optional `authorize` hook may only ever *narrow* what the
 *    database already permits. It is never the authorization decision.
 */

import { NeonOperationRegistry } from '../neon.js'

import { ACTIVITY_OPERATIONS, dailySeriesOperation } from './activity.js'
import { IDENTITY_OPERATIONS, resolveSelfOperation } from './identity.js'

export { ACTIVITY_OPERATIONS, type DailyActivityRow } from './activity.js'
export { IDENTITY_OPERATIONS, type ResolvedIdentity } from './identity.js'

/**
 * Build the application registry. Exported so a test can build an identical
 * one without reaching for the module-scope store.
 */
export function buildApplicationRegistry(): NeonOperationRegistry {
  const registry = new NeonOperationRegistry()

  registry.registerQuery(IDENTITY_OPERATIONS.resolveSelf, resolveSelfOperation)
  registry.registerQuery(ACTIVITY_OPERATIONS.dailySeries, dailySeriesOperation)

  return registry
}

/** Every read operation the application may perform, for assertions. */
export const APPLICATION_QUERY_OPERATIONS = [
  IDENTITY_OPERATIONS.resolveSelf,
  ACTIVITY_OPERATIONS.dailySeries,
] as const
