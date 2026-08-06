/**
 * The AI layer's own Neon `DataStore`, held at module scope beside `store.ts`.
 *
 * Why a **second** store rather than the shared one: the two stores connect as
 * different principals and are authorized differently by the database.
 * `store.ts` resolves `NEON_DATABASE_URL` and runs as `app_runtime`, whose
 * surface is actor-scoped table reads and writes under an active-HUMAN policy.
 * This one resolves `NEON_AI_DATABASE_URL` and enters `app_system`, the
 * server-owned job principal, whose policies gate on the system actor instead.
 * One store could not be both: a connection is one principal, and conflating
 * the two credentials is exactly what `neonConfig.ts` refuses to do.
 *
 * ## What this store can reach, corrected for step 007
 *
 * This header used to say `app_system` held no table grant at all and that the
 * guard was therefore the whole capability of every read served here. Ledger
 * step 007 is applied and that is no longer true. The role now holds
 * `SELECT, INSERT, UPDATE` — never `DELETE` — on five relations
 * (`briefing_jobs`, `briefings`, `messages`, `leads`, `saved_searches`), each
 * behind a policy that opens only for the published nil-uuid actor. So this
 * store serves two things: guard calls, which remain the only route to every
 * *other* relation and are still SELECT-only under a 1000-row cap; and the
 * narrow, named DML the server-owned jobs need, registered one statement at a
 * time in `operations/aiSystem.ts` and composed into the same registry. What
 * did not change: the guard gained no write path, and nothing generic writes.
 *
 * Module scope and lazy construction for the same reason S11 measured for
 * `store.ts`: a warm Vercel invocation reuses the pool, a cold start pays the
 * connect once, and importing this module requires no credential.
 *
 * ## The unconditional `SET LOCAL ROLE app_system`
 *
 * Every transaction of this store enters `app_system` via the driver's
 * `localRole` preamble — unconditionally, not conditionally on who the pool
 * connected as. A role may always `SET ROLE` to itself, so the identical
 * statement is correct for a direct `app_system` login (production) and for a
 * member login with `SET TRUE` (a test fixture whose password can be
 * reassigned without touching this code). It is `SET LOCAL`, transaction-
 * scoped, never the session variant, because the pooled endpoint reuses
 * backends across clients.
 *
 * ## The system actor
 *
 * The contract requires every query to publish an actor, and this store
 * publishes `SYSTEM_ACTOR` — a `SystemActorContext` whose id is the nil uuid.
 * The id is deliberately one that belongs to no user: it matches the strict
 * uuid regex the policies apply, and then fails the active-`users` EXISTS
 * behind it, so every human-actor policy denies it. Step 007 turned it from a
 * value that unlocked nothing into the gate of exactly five relations, which
 * makes publishing it correctly load-bearing rather than ceremonial: a system
 * transaction that failed to publish it would find `current_setting` NULL, and
 * NULL never equals the system actor id, so the policies fail closed rather
 * than open. It is still not a key to any human's data — no user can ever hold
 * it, because step 005 is the only creator of users and generates ids with
 * `gen_random_uuid()`.
 */

import type { DataStore, SystemActorContext } from './contracts.js'
import { NeonDataStore, type NeonDataStoreConfig } from './neon.js'
import { readNeonAiConnectionString, type EnvSource } from './neonConfig.js'
import { buildAiRegistry } from './operations/ai.js'

/**
 * The same small pool ceiling and its reason as `store.ts`: many concurrent
 * function instances each hold their own pool against one shared connection
 * budget. The AI path issues one guard call at a time.
 */
const MAX_CONNECTIONS = 2

/**
 * Longer than the guard's own 10 s cap, deliberately. PostgreSQL arms the
 * transaction's `statement_timeout` when the outer statement begins, so if
 * this value sat at or below 10 s the driver's timeout could win the race and
 * report a generic 57014 where the guard would have raised its own refusal.
 * The margin lets the guard's own cap be the one that decides. This is also
 * the S07 contract's second half: the guard's internal 10 s cannot abort a
 * call already in flight, so the caller must arm a transaction-local timeout —
 * the driver preamble does, on every transaction, here.
 */
const AI_STATEMENT_TIMEOUT_MS = 12_000

/**
 * The AI execution principal. `app_system` in the database; the nil uuid as
 * its published actor — well-formed, and belonging to nobody.
 */
export const SYSTEM_ACTOR: SystemActorContext = Object.freeze({
  kind: 'system',
  actorId: '00000000-0000-0000-0000-000000000000',
  // One Neon project holds one tenant; the same constant `identity/session.ts`
  // uses for resolved user actors, repeated here rather than imported so the
  // data layer does not depend on the identity layer.
  tenantId: 'primary',
  role: 'system',
})

/** The role every AI transaction enters. Named once so nothing can drift. */
export const AI_LOCAL_ROLE = 'app_system'

let store: NeonDataStore | null = null

/**
 * The AI store's configuration, as a value. Exported — rather than read off a
 * constructed store — so a test can assert the two properties whose silent
 * loss would run the AI path as `app_runtime`: that the connection string
 * resolves from `NEON_AI_DATABASE_URL` (never `NEON_DATABASE_URL`), and that
 * every transaction enters `app_system`.
 */
export function buildAiStoreConfig(env: EnvSource = process.env): NeonDataStoreConfig {
  return {
    connectionString: readNeonAiConnectionString(env),
    operations: buildAiRegistry(),
    localRole: AI_LOCAL_ROLE,
    statementTimeoutMs: AI_STATEMENT_TIMEOUT_MS,
    maxConnections: MAX_CONNECTIONS,
    applicationName: 'lh2-dashboard-ai',
  }
}

/**
 * The process-wide AI store. Lazily constructed, then reused for the lifetime
 * of the function instance.
 */
export function getAiDataStore(): DataStore {
  if (!store) {
    store = new NeonDataStore(buildAiStoreConfig())
  }
  return store
}

/** True once a store exists, so a test can assert the instance is reused. */
export function aiDataStoreExists(): boolean {
  return store !== null
}

/**
 * Drop the AI store. For tests and for a graceful shutdown — not part of the
 * request path, which must never close a store other requests are using.
 */
export async function resetAiDataStore(): Promise<void> {
  const existing = store
  store = null
  if (existing) await existing.close()
}
