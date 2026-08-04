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
 * 2. An operation's optional `authorize` hook may only ever *narrow* what the
 *    database already permits. It is never the authorization decision.
 * 3. **Exactly one actorless operation exists**, and it is the actor resolver.
 *    Anything else that needs data needs an actor first. `APPLICATION_ACTORLESS_OPERATIONS`
 *    is asserted to be that single entry, so a second one cannot be added
 *    quietly.
 *
 * S12 registered no command, because its slice was read-only. S17 registers the
 * first three: the identity write path. They are not general table writes — each
 * is one `SECURITY DEFINER` function that authorizes itself against the
 * canonical tables. S14 still owns the first *business* writes.
 */

import { NeonOperationRegistry } from '../neon.js'

import { ACTIVITY_OPERATIONS, dailySeriesOperation } from './activity.js'
import {
  IDENTITY_ADMIN_COMMANDS,
  IDENTITY_OPERATIONS,
  inviteMemberOperation,
  resolveActorOperation,
  setMemberActiveOperation,
  setMemberRoleOperation,
  teamRosterOperation,
} from './identity.js'

export { ACTIVITY_OPERATIONS, type DailyActivityRow } from './activity.js'
export {
  IDENTITY_ADMIN_COMMANDS,
  IDENTITY_OPERATIONS,
  type IdentityAdminResult,
  type InviteMemberParams,
  type SetMemberActiveParams,
  type SetMemberRoleParams,
  type TeamRosterRow,
} from './identity.js'

/**
 * Build the application registry. Exported so a test can build an identical
 * one without reaching for the module-scope store.
 */
export function buildApplicationRegistry(): NeonOperationRegistry {
  const registry = new NeonOperationRegistry()

  registry.registerActorlessQuery(
    IDENTITY_OPERATIONS.resolveActor,
    resolveActorOperation,
  )

  registry.registerQuery(IDENTITY_OPERATIONS.teamRoster, teamRosterOperation)
  registry.registerQuery(ACTIVITY_OPERATIONS.dailySeries, dailySeriesOperation)

  registry.registerCommand(IDENTITY_ADMIN_COMMANDS.invite, inviteMemberOperation)
  registry.registerCommand(
    IDENTITY_ADMIN_COMMANDS.setActive,
    setMemberActiveOperation,
  )
  registry.registerCommand(IDENTITY_ADMIN_COMMANDS.setRole, setMemberRoleOperation)

  return registry
}

/** Every actor-scoped read the application may perform, for assertions. */
export const APPLICATION_QUERY_OPERATIONS = [
  IDENTITY_OPERATIONS.teamRoster,
  ACTIVITY_OPERATIONS.dailySeries,
] as const

/** Every write. All three are the identity write path; none is a table write. */
export const APPLICATION_COMMAND_OPERATIONS = [
  IDENTITY_ADMIN_COMMANDS.invite,
  IDENTITY_ADMIN_COMMANDS.setActive,
  IDENTITY_ADMIN_COMMANDS.setRole,
] as const

/**
 * The complete actorless surface. One entry, and a test asserts the count — a
 * read that runs with no actor published is the sharpest tool in the driver and
 * it exists for exactly one reason.
 */
export const APPLICATION_ACTORLESS_OPERATIONS = [
  IDENTITY_OPERATIONS.resolveActor,
] as const
