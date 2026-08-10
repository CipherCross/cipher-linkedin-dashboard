/**
 * Which provider's roster-id space the page displays.
 *
 * Assignment and the six follow-up actions now have actor-scoped Neon
 * transactions, so a Neon roster may supply their member IDs when the server
 * selects the Neon write path. The browser still treats an unknown future
 * roster source as unsafe. Team administration is different: its four former
 * `/api/pipeline` mutations are retired and the UI must send users to
 * `/api/identity` instead of presenting controls that no longer have a route.
 */

import type { RosterPath, TeamMember } from './types'

export type { RosterPath }

/**
 * May a member id from this roster be sent to `/api/pipeline`?
 *
 * `true` for the known Supabase and Neon rosters. Their server branches resolve
 * the member from the same data plane before updating; an unknown future source
 * remains blocked.
 *
 * Fail-closed in shape as well as in fact: anything that is not the string
 * `supabase` blocks, so a future third value cannot be silently permitted by a
 * predicate that was written before it existed.
 */
export function memberWritesAllowed(rosterPath: RosterPath): boolean {
  return rosterPath === 'supabase' || rosterPath === 'neon'
}

/**
 * What the user is told instead. It names the cause, not the symptom: "nobody
 * to choose" would read as an empty team, which is the class of message this
 * whole slice exists to stop producing.
 */
export const MEMBER_WRITES_BLOCKED =
  'Assignment is unavailable because this dashboard does not recognize the roster ' +
  'source for the selected deployment.'

/**
 * The roster as an *assignment* vocabulary: the members whose ids may be written
 * back, which is all of them or none.
 *
 * Separate from the display roster so an unknown source can keep rendering names
 * while sending no member IDs back to the server.
 */
export function assignableMembers(
  members: readonly TeamMember[],
  rosterPath: RosterPath,
): TeamMember[] {
  return memberWritesAllowed(rosterPath) ? [...members] : []
}

/**
 * Whether the Team page may offer its admin controls.
 *
 * These four legacy pipeline actions are retired in favor of `/api/identity`, so
 * the Team page never offers them from this client helper.
 */
export function teamAdminWritesAllowed(_rosterPath: RosterPath): boolean {
  return false
}
