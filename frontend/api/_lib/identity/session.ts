/**
 * Resolving a request to a canonical actor — the file that replaces S12's
 * actor bridge (`B1`).
 *
 * **What the bridge was and why it is gone.** `public.user_identities` is
 * readable by `app_runtime` only through `user_identities_active_actor_select`,
 * which requires `user_id = app.actor_id`: reading the mapping required already
 * knowing the answer. S12 worked around that with an environment-held map that
 * *proposed* an actor id which RLS then confirmed. It worked, and it meant
 * adding a team member needed a redeploy. Ledger step 004 added
 * `public.identity_resolve_actor`, so the mapping can now simply be asked. No
 * proposal, no environment variable, no class of bug where a cached proposal
 * drifts.
 *
 * **One authenticator.** The provider subject arrives in the identity session
 * cookie the self-hosted provider issued, and nothing else. The transitional
 * Supabase Auth bearer that once sat beside it is gone with the rest of
 * Supabase: an `Authorization` header on a browser request is simply ignored.
 *
 * The session cannot widen anything. `role` comes from
 * `public.team_members` through the resolver, never from a cookie, a claim or a
 * provider-side role column — which is F5, and it is why an account whose
 * provider role says `admin` while the database says `member` resolves as
 * **member**.
 *
 * **Resolved once per request.** G2's `B5` and G3's `C6` both require it: the
 * candidate's session lookup and the actor resolution are each a database round
 * trip, and S12 measured the actor confirmation alone at 196 ms of a 525 ms
 * request. Callers take the `RequestActor` this returns and pass it down.
 */

import { AuthorizationError } from '../auth.js'
import type { DataStore, UserActorContext } from '../data/contracts.js'
import { IDENTITY_PROVIDER_NAME } from './config.js'
import type { IdentityProvider } from './provider.js'

/**
 * One Neon project holds one tenant, so the tenant boundary is the database
 * itself: the baseline has no `tenant_id` column and no policy scopes by one.
 * The contract still requires a non-empty tenant id — it participates in cursor
 * scoping — so this is a stable, provider-neutral constant, deliberately not
 * derived from any provider resource identifier.
 */
export const TENANT_ID = 'primary'

export interface RequestActor {
  readonly actor: UserActorContext
  /** The provider subject the session presented. Never a canonical user id. */
  readonly subject: string
  /** Which `user_identities.provider` resolved it. */
  readonly provider: string
}

export interface ResolveRequestActorDeps {
  readonly identity: IdentityProvider
  readonly store: DataStore
  /**
   * Provider label for the candidate's own subjects. Injectable because the
   * baseline's contract fixtures are seeded under `provider = 'fixture'`, and a
   * test that had to write a `better-auth` row to exercise the mapping would be
   * writing production data to prove a read.
   */
  readonly providerName?: string
}

/**
 * Resolve the caller, or throw `AuthorizationError`.
 *
 * The 401/403 split is a contract `S18` renders, not a detail:
 *
 * - **401** — no credential, or one that is absent, malformed, expired or
 *   revoked. "You are not signed in."
 * - **403** — a *valid* session whose subject is not an active member. "You are
 *   signed in, but your access has been removed." This is a real, reachable
 *   state: F5 measured that deactivating someone leaves their session valid, so
 *   they stay authenticated while ceasing to be a member. Collapsing it into 401
 *   would bounce them to a sign-in page that would succeed and change nothing.
 */
export async function resolveRequestActor(
  request: Request,
  deps: ResolveRequestActorDeps,
): Promise<RequestActor> {
  const provider = deps.providerName ?? IDENTITY_PROVIDER_NAME
  const session = await deps.identity.getSession(request.headers)
  if (!session) throw new AuthorizationError(401, 'Authentication required')
  const subject = session.user.subject

  const resolved = await deps.store.resolveActor({ provider, subject })

  // Zero rows is every denial at once — unknown subject, inactive user,
  // inactive membership — and deliberately indistinguishable, so a caller
  // learns nothing about who exists.
  if (!resolved) {
    throw new AuthorizationError(403, 'Your account is not an active team member')
  }

  return {
    actor: {
      kind: 'user',
      actorId: resolved.actorId,
      tenantId: TENANT_ID,
      role: resolved.role,
    },
    subject,
    provider,
  }
}

/**
 * Require an admin, for endpoints that shape their own 403 rather than letting a
 * SQLSTATE surface.
 *
 * This is **not** the authorization decision. Every admin function re-checks
 * `public.is_app_admin()` against `app.actor_id` inside the database and refuses
 * a non-admin with SQLSTATE 42501 regardless of what happens here. The test
 * suite proves that independently, by calling the operations with a member actor
 * and watching the database refuse — because a check that only exists in
 * TypeScript is a check that disappears the first time someone adds a second
 * call site.
 */
export function requireAdminActor(resolved: RequestActor): RequestActor {
  if (resolved.actor.role !== 'admin') {
    throw new AuthorizationError(403, 'Admin access required')
  }
  return resolved
}
