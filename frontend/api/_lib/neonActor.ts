/**
 * ============================================================================
 * TEMPORARY — the S12 actor bridge. Identity is S16–S18's subject, not S12's.
 * ============================================================================
 *
 * The problem it solves. A signed-in browser presents a Supabase Auth JWT. Its
 * `sub` is an *identity-provider subject*. Neon's RLS policies need a canonical
 * `public.users.id` UUID published as `app.actor_id`. Something has to map one
 * to the other, and `public.user_identities(user_id, provider,
 * provider_subject)` exists in the baseline precisely to hold that mapping.
 *
 * Why the mapping cannot simply be looked up. `user_identities` is readable by
 * `app_runtime` only through `user_identities_active_actor_select`, which
 * requires `user_id = app.actor_id`. Reading the row therefore requires already
 * knowing the answer. The data plane holds no role that can read it unscoped:
 * `app_runtime` is `NOBYPASSRLS` by construction, and adding a `SECURITY
 * DEFINER` resolver would be a schema change — which is a finding for the
 * owner, not something S12 may apply, since the migration ledger is the only
 * sanctioned apply path (R5).
 *
 * So the bridge is deliberately shaped as **propose, then confirm**:
 *
 *   1. `requireUser` verifies the JWT signature and yields a trustworthy `sub`.
 *      (Note it uses only the Supabase URL + anon key. The Neon path never
 *      touches `service_role` and never reads Supabase's `team_members`.)
 *   2. A server-only, explicitly temporary map **proposes** a canonical actor
 *      id for that `sub`. The map confers no privilege by itself.
 *   3. The **database confirms it**. `identity.resolveSelf` runs with the
 *      proposed id published as `app.actor_id`; RLS returns a row only if that
 *      id is the canonical user for the presented `sub` *and* the user is
 *      active *and* they are an active team member. The role comes back from
 *      `team_members`, so privilege originates in the database.
 *
 * A wrong, stale or hostile proposal cannot escalate: the policy compares
 * `user_id` against the published actor and the presented subject in the same
 * predicate, so the only proposal that yields a row is the correct one.
 *
 * What exactly is temporary: **step 2**, the environment-held map. Nothing
 * else — steps 1 and 3 are the intended shape.
 *
 * What S17 replaces it with: S17 makes the canonical `users`/`user_identities`
 * tables the identity authority instead of Supabase Auth. Once the subject is
 * issued against Neon (or a ledger-applied `SECURITY DEFINER` resolver can read
 * `user_identities` unscoped), the proposal step disappears entirely and this
 * whole module is deleted — the handler will resolve the actor from the token
 * alone. Until then this file is the only place a Supabase subject and a Neon
 * actor id are allowed to meet.
 */

import { AuthorizationError, requireUser } from './auth.js'
import type { ActorContext, UserActorContext } from './data/contracts.js'
import { getDataStore } from './data/store.js'
import {
  IDENTITY_OPERATIONS,
  type ResolvedIdentity,
} from './data/operations/index.js'

/**
 * The identity provider recorded in `user_identities.provider` for subjects
 * minted by Supabase Auth.
 */
export const BRIDGE_PROVIDER = 'supabase'

/**
 * TEMPORARY, like the map itself. Overrides which `user_identities.provider`
 * the bridge matches on, so the contract fixtures seeded by the baseline
 * (`provider = 'fixture'`) can drive the deny matrix without minting Auth users
 * on a live provider. Unset in any real deployment, where the default applies.
 */
export const ACTOR_BRIDGE_PROVIDER_ENV = 'NEON_ACTOR_BRIDGE_PROVIDER'

function bridgeProvider(): string {
  const override = process.env[ACTOR_BRIDGE_PROVIDER_ENV]
  return typeof override === 'string' && override.trim() !== ''
    ? override.trim()
    : BRIDGE_PROVIDER
}

/**
 * TEMPORARY. JSON object mapping a Supabase Auth `sub` to a canonical
 * `public.users.id`, e.g. `{"<auth-sub-uuid>":"<canonical-user-uuid>"}`.
 *
 * Server-only and deliberately not `VITE_`-prefixed. It holds no secret — a
 * pair of user identifiers is not a credential, and on its own it grants
 * nothing, because the database still has to confirm the pairing.
 */
export const ACTOR_BRIDGE_ENV = 'NEON_ACTOR_BRIDGE'

/**
 * One Neon project holds one tenant, so the tenant boundary is the database
 * itself: the baseline has no `tenant_id` column on any table and no policy
 * scopes by one. The contract still requires a non-empty tenant id — it
 * participates in cursor scoping — so this is a stable, provider-neutral
 * constant. It is deliberately **not** derived from any provider resource
 * identifier, which must never appear in the repository.
 *
 * S16 introduces real tenancy and replaces this constant.
 */
export const TENANT_ID = 'primary'

function readBridgeMap(): Readonly<Record<string, string>> {
  const raw = process.env[ACTOR_BRIDGE_ENV]
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AuthorizationError(
      500,
      `The Neon actor bridge is not configured (${ACTOR_BRIDGE_ENV})`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AuthorizationError(
      500,
      `${ACTOR_BRIDGE_ENV} is not valid JSON`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuthorizationError(
      500,
      `${ACTOR_BRIDGE_ENV} must be a JSON object of provider subject to canonical user id`,
    )
  }

  const map: Record<string, string> = {}
  for (const [subject, actorId] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof actorId === 'string' && actorId.trim() !== '') {
      map[subject] = actorId.trim()
    }
  }
  return map
}

/**
 * Resolve the signed-in browser user to a confirmed canonical Neon actor.
 *
 * Fails closed with `AuthorizationError` on every path: no bearer token, an
 * invalid or expired token, a subject the bridge cannot propose an actor for,
 * and — decided by RLS rather than here — a proposal the database refuses to
 * confirm, which is what an inactive or unmapped user produces.
 */
export async function requireNeonActor(req: Request): Promise<UserActorContext> {
  const user = await requireUser(req)
  const proposedActorId = readBridgeMap()[user.userId]

  if (!proposedActorId) {
    throw new AuthorizationError(
      403,
      'Your account is not mapped to a canonical application user',
    )
  }

  // The actor used for the confirming read itself. Its role is pinned to the
  // least privilege the contract allows: the confirmation query has no
  // `authorize` hook and RLS never reads the role, so this placeholder cannot
  // widen anything. The real role is whatever the database returns below.
  const proposed: ActorContext = {
    kind: 'user',
    actorId: proposedActorId,
    tenantId: TENANT_ID,
    role: 'member',
  }

  const confirmation = await getDataStore().query<ResolvedIdentity>(proposed, {
    operation: IDENTITY_OPERATIONS.resolveSelf,
    params: {
      provider: bridgeProvider(),
      providerSubject: user.userId,
    },
    page: { limit: 2 },
  })

  // Zero rows is the RLS denial: unknown, malformed, inactive, or a proposal
  // that does not match the presented subject. More than one row would mean the
  // baseline's unique constraints were violated; refuse rather than guess.
  if (confirmation.items.length !== 1) {
    throw new AuthorizationError(
      403,
      'Your account is not an active team member',
    )
  }

  const [identity] = confirmation.items
  if (identity.actorId !== proposedActorId) {
    throw new AuthorizationError(403, 'Actor identity could not be confirmed')
  }

  return {
    kind: 'user',
    actorId: identity.actorId,
    tenantId: TENANT_ID,
    role: identity.role,
  }
}
