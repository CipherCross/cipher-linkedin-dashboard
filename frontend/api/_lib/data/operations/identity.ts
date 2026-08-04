/**
 * The identity operations: resolving an actor, reading the roster, and the three
 * admin writes.
 *
 * All five are `SECURITY DEFINER` functions from ledger step 004, and that is
 * the whole design. `app_runtime` holds INSERT/UPDATE/DELETE on **none** of
 * `public.users`, `public.user_identities` or `public.team_members` — table
 * grants, not RLS, so no actor context can unlock them (F6). The functions are
 * the only write path, they are granted to `app_runtime` alone, and each one
 * that writes gates itself on `public.is_app_admin()`.
 *
 * **Why authorization is inside the function rather than on the grant.** An
 * admin and an ordinary member arrive on the *same* `app_runtime` connection
 * with the *same* `EXECUTE` grant; only `app.actor_id` differs. So the grant
 * cannot be the control, and the function's own `is_app_admin()` check is. This
 * matters for how the denial is tested: it has to be proved behaviourally, from
 * a real member actor, not by reading a grant statement.
 *
 * What replaced what: S12's `identity.resolveSelf` — the database half of the
 * environment-held actor bridge — is gone. It required the caller to already
 * know the answer and have it confirmed. `identity_resolve_actor` answers the
 * question directly, so there is no proposal to keep correct and no class of bug
 * where a cached proposal drifts.
 */

import { RESOLVE_ACTOR_OPERATION, type ResolvedActor } from '../contracts.js'
import type {
  NeonActorlessQueryOperation,
  NeonCommandOperation,
  NeonQueryOperation,
  NeonRow,
} from '../neon.js'

export const IDENTITY_OPERATIONS = {
  /** The one actorless read. Establishes the actor; see the driver's note. */
  resolveActor: RESOLVE_ACTOR_OPERATION,
  /** The whole roster, to any active member (B4). */
  teamRoster: 'identity.teamRoster',
} as const

export const IDENTITY_ADMIN_COMMANDS = {
  /**
   * The atomic invite: canonical rows **and** the store-side account in one
   * transaction, backed by ledger step 005.
   *
   * This is the only invite the endpoint offers. Step 004's
   * `identity_admin_invite_member` writes the canonical half alone, which leaves
   * a member who exists on the roster and cannot sign in — the half-person F8
   * argues against. Until step 005 is applied this operation raises SQLSTATE
   * 42883 and the endpoint turns that into an explicit 503, which is a better
   * outcome than half-creating people.
   */
  invite: 'identity.admin.invite',
  setActive: 'identity.admin.setActive',
  setRole: 'identity.admin.setRole',
} as const

/** Rows of `public.team_roster()`. */
export interface TeamRosterRow {
  readonly id: number
  readonly userId: string
  readonly name: string
  readonly email: string | null
  readonly role: 'member' | 'admin'
  readonly active: boolean
  readonly createdAt: string
}

/** Whatever the admin functions return, which is `jsonb` by design. */
export type IdentityAdminResult = Readonly<Record<string, unknown>>

// ---------------------------------------------------------------------------
// The actor resolver — actorless by construction.
// ---------------------------------------------------------------------------

/**
 * Equality on both columns, no pattern, no list. `('fixture','%')`, `('%','%')`
 * and `('fixture','')` all return zero rows, so this is not an enumeration
 * primitive — and an unknown subject, an inactive user and an inactive
 * membership are indistinguishable, all three being zero rows.
 */
const RESOLVE_ACTOR_SQL = `SELECT r.actor_id::text AS actor_id, r.role AS role
     FROM public.identity_resolve_actor($1, $2) AS r`

export const resolveActorOperation: NeonActorlessQueryOperation<
  ResolvedActor,
  { readonly provider: string; readonly subject: string }
> = {
  build: (params) => ({
    text: RESOLVE_ACTOR_SQL,
    values: [params?.provider ?? '', params?.subject ?? ''],
  }),
  mapRow: (row: NeonRow): ResolvedActor => ({
    actorId: String(row.actor_id),
    // The baseline constrains team_members.role to 'member' | 'admin'.
    role: row.role === 'admin' ? 'admin' : 'member',
  }),
}

// ---------------------------------------------------------------------------
// The roster read (B4).
// ---------------------------------------------------------------------------

/**
 * Gated on membership, not admin: an ordinary member needs the roster to see
 * who owns a conversation. The function returns zero rows for a missing,
 * malformed, unknown or inactive actor, because `is_active_team_member()` is
 * false — so there is nothing to check here that the database does not check.
 *
 * `ORDER BY` is in this file rather than in the function so paging is stable:
 * the driver wraps every query in `LIMIT/OFFSET`, and an unordered relation
 * paged that way can repeat or skip rows.
 */
const TEAM_ROSTER_SQL = `SELECT r.id,
          r.user_id::text AS user_id,
          r.name,
          r.email,
          r.role,
          r.active,
          r.created_at
     FROM public.team_roster() AS r
    ORDER BY r.name, r.id`

export const teamRosterOperation: NeonQueryOperation<TeamRosterRow> = {
  build: () => ({ text: TEAM_ROSTER_SQL }),
  mapRow: (row: NeonRow): TeamRosterRow => ({
    id: Number(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    email: row.email === null ? null : String(row.email),
    role: row.role === 'admin' ? 'admin' : 'member',
    active: row.active === true,
    createdAt: String(row.created_at),
  }),
}

// ---------------------------------------------------------------------------
// The three admin writes.
// ---------------------------------------------------------------------------

/** Every admin function returns `jsonb` so its shape can grow without a
 *  signature change. One row, one column. */
function jsonbResult(rows: readonly NeonRow[]): IdentityAdminResult {
  return (rows[0]?.result ?? {}) as IdentityAdminResult
}

/**
 * None of the three carries an `authorize` hook, and that is deliberate rather
 * than an omission.
 *
 * A hook here may only ever *narrow* what the database permits, and adding one
 * would create a second, weaker authorization path that could drift from the
 * function's own `is_app_admin()` — the endpoint would then look authorized even
 * if the hook were the only thing refusing. The database is the single gate. The
 * endpoint does refuse a non-admin early, to return a clean 403 instead of a raw
 * SQLSTATE, but that is response shaping and the suite proves the database
 * refuses independently of it.
 */
export interface InviteMemberParams {
  readonly email: string
  readonly name: string
  readonly role: 'member' | 'admin'
  readonly provider: string
  /** The store-side `identity."user".id`, which *is* the provider subject. */
  readonly providerSubject: string
  /** The candidate's own hash. This process never sees a stored passphrase. */
  readonly passwordHash: string
  readonly [key: string]: string
}

/**
 * Ledger step 005. Writes `public.users`, `public.team_members`,
 * `public.user_identities`, `identity."user"` and `identity."account"` in one
 * transaction, so a failure anywhere leaves neither store with a half-person.
 *
 * The password hash crosses this boundary as an already-hashed value produced by
 * the candidate. It is a credential, so it is a bound parameter and never
 * interpolated, and nothing on this path logs the parameter list.
 */
export const inviteMemberOperation: NeonCommandOperation<
  IdentityAdminResult,
  InviteMemberParams
> = {
  build: ({ params }) => ({
    text:
      `SELECT public.identity_admin_invite_member_atomic($1, $2, $3, $4, $5, $6)` +
      ` AS result`,
    values: [
      params?.email ?? '',
      params?.name ?? '',
      params?.role ?? 'member',
      params?.provider ?? '',
      params?.providerSubject ?? '',
      params?.passwordHash ?? '',
    ],
  }),
  mapResult: jsonbResult,
}

export interface SetMemberActiveParams {
  readonly userId: string
  readonly active: boolean
  readonly [key: string]: string | boolean
}

export const setMemberActiveOperation: NeonCommandOperation<
  IdentityAdminResult,
  SetMemberActiveParams
> = {
  build: ({ params }) => ({
    text: `SELECT public.identity_admin_set_member_active($1::uuid, $2) AS result`,
    values: [params?.userId ?? '', params?.active ?? false],
  }),
  mapResult: jsonbResult,
}

export interface SetMemberRoleParams {
  readonly userId: string
  readonly role: 'member' | 'admin'
  readonly [key: string]: string
}

/**
 * `identity_admin_set_member_role`, not the baseline's older
 * `admin_update_team_member`.
 *
 * That older function is also `SECURITY DEFINER` and also granted to
 * `app_runtime`, but it performs **no authorization of its own** — under the
 * previous provider, being reachable only by the service role *was* the
 * authorization. It is immutable and still present, so preferring this one is a
 * decision worth recording rather than an accident: this one is keyed the way
 * the rest of the identity surface is keyed, and it refuses a non-admin caller
 * itself.
 */
export const setMemberRoleOperation: NeonCommandOperation<
  IdentityAdminResult,
  SetMemberRoleParams
> = {
  build: ({ params }) => ({
    text: `SELECT public.identity_admin_set_member_role($1::uuid, $2) AS result`,
    values: [params?.userId ?? '', params?.role ?? 'member'],
  }),
  mapResult: jsonbResult,
}
