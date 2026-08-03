/**
 * The read that turns a proposed actor into a *confirmed* one (S12).
 *
 * This is the database half of the temporary actor bridge in
 * `frontend/api/_lib/neonActor.ts`. It exists because the bridge must not be
 * the authority on who the caller is — the baseline's RLS policies must be.
 *
 * Both tables read here are self-scoped by policy
 * (`postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql`):
 *
 * - `user_identities_active_actor_select` requires `user_id = app.actor_id`,
 *   an **active** `users` row and an active `team_members` row.
 * - `team_members_active_actor_select` requires `user_id = app.actor_id` and
 *   `active`.
 *
 * So a row comes back only when the proposed actor really is the canonical
 * user for the presented identity-provider subject *and* that user is active
 * and an active team member. A proposal for a different user, an unknown user,
 * an inactive user or a malformed id returns zero rows, and the caller denies.
 * The role is read from the database rather than from the caller's claims, so
 * privilege never originates in the browser or in the bridge's configuration.
 */

import type { NeonQueryOperation, NeonRow } from '../neon.js'

export const IDENTITY_OPERATIONS = {
  /** Confirm the proposed actor against the presented provider subject. */
  resolveSelf: 'identity.resolveSelf',
} as const

export interface ResolveSelfParams {
  readonly provider: string
  readonly providerSubject: string
  readonly [key: string]: string
}

export interface ResolvedIdentity {
  readonly actorId: string
  readonly role: 'member' | 'admin'
}

const RESOLVE_SELF_SQL = `SELECT ui.user_id::text AS actor_id,
          tm.role AS role
     FROM public.user_identities ui
     JOIN public.team_members tm ON tm.user_id = ui.user_id
    WHERE ui.provider = $1
      AND ui.provider_subject = $2
    ORDER BY ui.user_id`

export const resolveSelfOperation: NeonQueryOperation<
  ResolvedIdentity,
  ResolveSelfParams
> = {
  build: ({ params }) => ({
    text: RESOLVE_SELF_SQL,
    values: [params?.provider ?? '', params?.providerSubject ?? ''],
  }),
  mapRow: (row: NeonRow): ResolvedIdentity => ({
    actorId: String(row.actor_id),
    // The baseline constrains `team_members.role` to 'member' | 'admin'.
    role: row.role === 'admin' ? 'admin' : 'member',
  }),
}
