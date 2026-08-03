/**
 * The mapping: an identity-provider subject → a canonical `public.users.id`.
 *
 * This is the thing S12's temporary bridge faked with an environment-held map
 * (`frontend/api/_lib/neonActor.ts`, G2 blocker B1). Here it is real: the
 * subject comes from a signed session the candidate issued, and the canonical
 * id is decided by `public.user_identities` under the baseline's own RLS.
 *
 * Two resolvers are implemented, because the choice between them is a finding
 * for the owner rather than something S16 may settle by applying a migration:
 *
 * - `createProposeThenConfirmResolver` works against the tenant baseline
 *   **exactly as it exists today**. `user_identities` is readable by
 *   `app_runtime` only through `user_identities_active_actor_select`, which
 *   requires `user_id = app.actor_id` — reading the mapping requires already
 *   knowing the answer. So the session carries a *proposal* (the account's
 *   `canonicalUserId`) and the database confirms it. The proposal confers no
 *   privilege: the policy compares `user_identities.user_id` against the
 *   published actor and the presented subject in the same predicate, so the
 *   only proposal that returns a row is the correct one.
 *
 * - `createDefinerResolver` needs one `SECURITY DEFINER` function that does not
 *   exist in the baseline (`sql/candidate_identity_resolver.sql`). It resolves
 *   the subject directly, in one round trip and with no proposal to keep in
 *   sync. **S16 does not apply it anywhere but the ephemeral clean room.**
 *   Adding it is a ledger session, exactly like the B4 roster function.
 *
 * Both fail closed. An unknown subject, an inactive user, a non-member, a
 * malformed proposal and a proposal for someone else all return no row, and
 * every caller of this module treats "no row" as a denial.
 */

import type { Pool as PgPool } from 'pg'

export interface CanonicalActor {
  readonly actorId: string
  readonly role: 'member' | 'admin'
}

/** Every denial in this module is a 403: the caller is authenticated, but not authorised. */
export class ActorResolutionError extends Error {
  readonly status = 403 as const

  constructor(message: string) {
    super(message)
    this.name = 'ActorResolutionError'
  }
}

export interface ActorResolver {
  (input: {
    readonly provider: string
    readonly subject: string
    /** The account's stored canonical id. Ignored by the definer resolver. */
    readonly proposedActorId: string | null
  }): Promise<CanonicalActor>
}

const CONFIRM_SQL = `SELECT ui.user_id::text AS actor_id,
          tm.role AS role
     FROM public.user_identities ui
     JOIN public.team_members tm ON tm.user_id = ui.user_id
    WHERE ui.provider = $1
      AND ui.provider_subject = $2
    ORDER BY ui.user_id`

const DEFINER_SQL = `SELECT actor_id::text AS actor_id, role
     FROM public.identity_resolve_actor($1, $2)`

function toActor(rows: ReadonlyArray<Record<string, unknown>>): CanonicalActor {
  // Zero rows is the denial. More than one would mean the baseline's unique
  // constraints were violated; refuse rather than pick one.
  if (rows.length !== 1) {
    throw new ActorResolutionError('No active canonical actor for this identity')
  }
  const [row] = rows
  return {
    actorId: String(row.actor_id),
    role: row.role === 'admin' ? 'admin' : 'member',
  }
}

/**
 * Resolve by publishing the account's proposal as `app.actor_id` and letting
 * RLS confirm it. Requires no schema change.
 */
export function createProposeThenConfirmResolver(runtimePool: PgPool): ActorResolver {
  return async ({ provider, subject, proposedActorId }) => {
    if (!proposedActorId) {
      // The account exists but carries no canonical id: an invite that wrote
      // only the auth store. Fail closed before touching the database.
      throw new ActorResolutionError('This account is not mapped to a canonical application user')
    }

    const client = await runtimePool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await client.query("SELECT set_config('app.actor_id', $1, true)", [proposedActorId])
      const result = await client.query(CONFIRM_SQL, [provider, subject])
      await client.query('COMMIT')
      const actor = toActor(result.rows as ReadonlyArray<Record<string, unknown>>)
      // Belt and braces: RLS already guarantees this, and the assertion means a
      // policy regression surfaces as a denial rather than as a wrong actor.
      if (actor.actorId !== proposedActorId) {
        throw new ActorResolutionError('Actor identity could not be confirmed')
      }
      return actor
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

/**
 * Resolve in one round trip through a `SECURITY DEFINER` function.
 *
 * The function is the candidate in `sql/candidate_identity_resolver.sql` and
 * exists only in the spike's clean room.
 */
export function createDefinerResolver(runtimePool: PgPool): ActorResolver {
  return async ({ provider, subject }) => {
    const result = await runtimePool.query(DEFINER_SQL, [provider, subject])
    return toActor(result.rows as ReadonlyArray<Record<string, unknown>>)
  }
}
