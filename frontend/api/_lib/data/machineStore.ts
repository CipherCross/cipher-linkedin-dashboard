/**
 * The ingest path's own Neon `DataStore`, the third one, held at module scope
 * beside `store.ts` and `aiStore.ts`.
 *
 * Why a third store rather than a flag on one of the others: a connection is one
 * principal, and these three are authorized by three different sets of policies.
 * `store.ts` runs as `app_runtime` under the active-human policies. `aiStore.ts`
 * runs as `app_system` under the nil-uuid gate. This one runs as `app_machine`
 * under step 009's credential gate — where the actor is a *credential id*, the
 * policy resolves it to a live credential on every statement, and the rows it
 * may touch are scoped to that credential's notebook.
 *
 * ## The published actor is the credential, not the notebook
 *
 * `machineActor()` puts `agent_credential.id` in `app.actor_id`. It would have
 * been possible to publish the instance id instead and let the policies compare
 * strings, and that would have been wrong in a way worth stating: revocation
 * would then be a fact the *handler* checked once, at the start of a request,
 * rather than a fact the database re-derives on every statement. With the
 * credential published, a credential revoked mid-batch stops being able to write
 * before the batch commits.
 *
 * ## `SET LOCAL ROLE app_machine`, unconditionally
 *
 * Same mechanism and same reason as the AI store: a role may always `SET ROLE`
 * to itself, so the identical statement is correct for a direct `app_machine`
 * login and for a member login that can become it — which is what the live test
 * suite uses, because `app_machine` is `NOLOGIN` until the control plane runs
 * `000_machine_ingest_role_bootstrap.sql`. Transaction-scoped, never the session
 * variant, because the pooled endpoint reuses backends across clients.
 */

import type { DataStore, MachineActorContext } from './contracts.js'
import { NeonDataStore, type NeonDataStoreConfig } from './neon.js'
import {
  readNeonMachineConnectionString,
  type EnvSource,
} from './neonConfig.js'
import { buildMachineRegistry } from './operations/agentIngest.js'

/**
 * One notebook syncs at a time and a sync is one request. Two is the same
 * ceiling the other stores carry, for the same reason: many warm function
 * instances share one connection budget.
 */
const MAX_CONNECTIONS = 2

/**
 * Longer than the read stores' 8 s. An ingest transaction is a dozen upserts
 * over a batch rather than one query, and the cost of a timeout here is a whole
 * sync rolled back — so the ceiling is the endpoint's own `maxDuration` less a
 * margin, not the read path's.
 */
const MACHINE_STATEMENT_TIMEOUT_MS = 25_000

/** The role every ingest transaction enters. Named once so nothing can drift. */
export const MACHINE_LOCAL_ROLE = 'app_machine'

let store: NeonDataStore | null = null

/**
 * The machine actor context for one resolved credential.
 *
 * `tenantId` is the credential's own tenant, which `resolveMachineActor` has
 * already checked against the deployment's — so by the time this value exists,
 * the two agree.
 */
export function machineActor(
  credentialId: string,
  tenantId: string,
): MachineActorContext {
  return Object.freeze({
    kind: 'machine' as const,
    actorId: credentialId,
    tenantId,
    role: 'machine' as const,
  })
}

/**
 * The machine store's configuration, as a value. Exported — rather than read
 * off a constructed store — so a test can assert the two properties whose
 * silent loss would run the ingest as `app_runtime`: that the connection string
 * resolves from `NEON_MACHINE_DATABASE_URL` (never `NEON_DATABASE_URL`), and
 * that every transaction enters `app_machine`.
 */
export function buildMachineStoreConfig(
  env: EnvSource = process.env,
): NeonDataStoreConfig {
  return {
    connectionString: readNeonMachineConnectionString(env),
    operations: buildMachineRegistry(),
    localRole: MACHINE_LOCAL_ROLE,
    statementTimeoutMs: MACHINE_STATEMENT_TIMEOUT_MS,
    maxConnections: MAX_CONNECTIONS,
    applicationName: 'lh2-dashboard-ingest',
  }
}

/** The process-wide machine store. Lazily constructed, then reused. */
export function getMachineDataStore(): DataStore {
  if (!store) {
    store = new NeonDataStore(buildMachineStoreConfig())
  }
  return store
}

/** True once a store exists, so a test can assert the instance is reused. */
export function machineDataStoreExists(): boolean {
  return store !== null
}

/** Drop the machine store. For tests and for a graceful shutdown. */
export async function resetMachineDataStore(): Promise<void> {
  const existing = store
  store = null
  if (existing) await existing.close()
}
