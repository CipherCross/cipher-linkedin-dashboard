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
  DASHBOARD_OPERATIONS,
  annotationsTimelineOperation,
  campaignsPerformanceOperation,
  campaignsSequenceStepsOperation,
  instancesOverviewOperation,
  syncRecentRunsOperation,
} from './dashboard.js'
import {
  IDENTITY_ADMIN_COMMANDS,
  IDENTITY_OPERATIONS,
  inviteMemberOperation,
  resolveActorOperation,
  setMemberActiveOperation,
  setMemberRoleOperation,
  teamRosterOperation,
} from './identity.js'
import { LEADS_OPERATIONS, leadsDirectoryOperation } from './leads.js'
import {
  MESSAGES_OPERATIONS,
  inboundHistoryOperation,
  outboundRecentOperation,
} from './messages.js'

export { ACTIVITY_OPERATIONS, type DailyActivityRow } from './activity.js'
export { LEADS_OPERATIONS, type LeadRow, type LeadsDirectoryParams } from './leads.js'
export {
  MESSAGES_OPERATIONS,
  type MessageRow,
  type MessagesParams,
} from './messages.js'
export {
  DASHBOARD_OPERATIONS,
  type AnnotationRow,
  type CampaignMetricsRow,
  type CampaignStepRow,
  type InstanceRow,
  type SyncRunRow,
} from './dashboard.js'
export {
  IDENTITY_ADMIN_COMMANDS,
  IDENTITY_OPERATIONS,
  // Re-exported, and still not registered below. See the note on
  // `resolveSelfOperation`: it is S16's live evidence surface, fenced off from
  // the request path by being absent from the allowlist rather than by being
  // deleted.
  resolveSelfOperation,
  type ResolvedIdentity,
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

  // S13's first DataContext slice.
  registry.registerQuery(
    DASHBOARD_OPERATIONS.instancesOverview,
    instancesOverviewOperation,
  )
  registry.registerQuery(
    DASHBOARD_OPERATIONS.campaignsPerformance,
    campaignsPerformanceOperation,
  )
  registry.registerQuery(
    DASHBOARD_OPERATIONS.campaignsSequenceSteps,
    campaignsSequenceStepsOperation,
  )
  registry.registerQuery(
    DASHBOARD_OPERATIONS.syncRecentRuns,
    syncRecentRunsOperation,
  )
  registry.registerQuery(
    DASHBOARD_OPERATIONS.annotationsTimeline,
    annotationsTimelineOperation,
  )

  // S13's second slice — the two keyset-paginated base-table reads.
  registry.registerQuery(LEADS_OPERATIONS.directory, leadsDirectoryOperation)
  registry.registerQuery(
    MESSAGES_OPERATIONS.inboundHistory,
    inboundHistoryOperation,
  )
  registry.registerQuery(
    MESSAGES_OPERATIONS.outboundRecent,
    outboundRecentOperation,
  )

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
  DASHBOARD_OPERATIONS.instancesOverview,
  DASHBOARD_OPERATIONS.campaignsPerformance,
  DASHBOARD_OPERATIONS.campaignsSequenceSteps,
  DASHBOARD_OPERATIONS.syncRecentRuns,
  DASHBOARD_OPERATIONS.annotationsTimeline,
  LEADS_OPERATIONS.directory,
  MESSAGES_OPERATIONS.inboundHistory,
  MESSAGES_OPERATIONS.outboundRecent,
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
