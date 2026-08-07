/**
 * The one place a machine credential becomes an actor.
 *
 * S21 wrote this inline in `ingest.ts`, when there was one machine-authenticated
 * operation. S23 adds three more (`agent.config`, `agent.photoUpload`,
 * `agent.release`) plus a second accepted principal on `/api/notify-replies`, and
 * five copies of an authentication sequence is five places for one of them to
 * drift into checking less than the others.
 *
 * The sequence, and why it is in this order:
 *
 * 1. **Parse the token before anything else.** A request with no credential costs
 *    one regex rather than a body read or a database round trip.
 * 2. **503 for an unconfigured deployment, not 401.** The caller may hold a
 *    perfectly good credential; telling it "unauthorized" sends an operator to
 *    look at the credential instead of at the two environment variables that are
 *    actually missing.
 * 3. **Resolve against the database.** `agent_credential_resolve` checks the id,
 *    the secret hash *and* the tenant, and returns nothing for a revoked or
 *    expired credential. Revocation and expiry are therefore not something this
 *    file checks — they are re-derived by the database on this statement and, for
 *    anything the actor goes on to do, on every statement after it (step 009's
 *    `machine_actor_instance()`).
 *
 * That last point is the whole revoke/expiry story for every S23 surface, and it
 * costs one round trip per request. The alternative — caching resolved
 * credentials in a warm container — was not taken: a revoked credential would
 * then keep working for the life of a container nobody can see, which converts
 * "revoke" from an action into a request.
 */

import { hashAgentSecret, tokenFromAuthorization } from './credentials.js'
import type { DataStore, MachineActorContext } from '../data/contracts.js'
import { machineActor } from '../data/machineStore.js'

export interface MachineAuthDeps {
  /** The machine store, or `null` when this deployment has not configured one. */
  readonly store: DataStore | null
  /** The tenant this deployment serves. A credential of another one is denied. */
  readonly tenantId: string | null
}

export interface MachinePrincipal {
  readonly actor: MachineActorContext
  readonly credentialId: string
  readonly instanceId: string
  readonly tenantId: string
  /** The resolved store, non-null — so a caller need not re-narrow `deps.store`. */
  readonly store: DataStore
}

export type MachineAuthResult =
  | { readonly principal: MachinePrincipal; readonly response?: undefined }
  | { readonly principal?: undefined; readonly response: Response }

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

/**
 * `WWW-Authenticate` on every 401, because the caller is a program: a notebook
 * that gets an opaque 401 retries forever, and one that is told the scheme has
 * something to log.
 */
export const machineUnauthorized = (realm: string): Response =>
  new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer realm="${realm}"`,
    },
  })

/** True when this header presents something shaped like a machine token. */
export function presentsMachineToken(header: string | null): boolean {
  return tokenFromAuthorization(header) !== null
}

export async function authenticateMachine(
  request: Request,
  deps: MachineAuthDeps,
  realm: string,
): Promise<MachineAuthResult> {
  const token = tokenFromAuthorization(request.headers.get('authorization'))
  if (!token) return { response: machineUnauthorized(realm) }

  if (!deps.store || !deps.tenantId) {
    return {
      response: json(
        { error: 'the machine path is not configured on this deployment' },
        503,
      ),
    }
  }

  const resolved = await deps.store.resolveMachineActor({
    credentialId: token.credentialId,
    secretHash: hashAgentSecret(token.secret),
    tenantId: deps.tenantId,
  })
  if (!resolved) return { response: machineUnauthorized(realm) }

  return {
    principal: {
      actor: machineActor(resolved.credentialId, resolved.tenantId),
      credentialId: resolved.credentialId,
      instanceId: resolved.instanceId,
      tenantId: resolved.tenantId,
      store: deps.store,
    },
  }
}
