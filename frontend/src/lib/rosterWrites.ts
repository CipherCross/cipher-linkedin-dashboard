/**
 * Which provider's id space the roster in front of the user belongs to, and
 * therefore which writes may name a member.
 *
 * ## The hazard, stated once
 *
 * Four columns carry a `team_members.id`: `leads.assigned_to`,
 * `conversation_follow_up_state.owner_id`, and `follow_up_events`'
 * `previous_owner_id` / `new_owner_id`. The integers denote different people on
 * the two providers — source 1 is the real admin, target 1 is the immutable S06
 * fixture "Active One" (`N-B2.md` has the map).
 *
 * The roster slice made *reading* those columns correct: with
 * `NEON_READS_DEFAULT=neon` the leads and the roster arrive from one database,
 * so the join names the right person. It did not, and could not, make *writing*
 * them correct, because the member-keyed writes do not have a Neon branch at
 * all:
 *
 * | action in `/api/pipeline` | Neon branch |
 * |---|---|
 * | `assign` (`member_id` → `leads.assigned_to`) | none |
 * | `invite_member`, `update_member`, `add_member`, `set_member_active` | none |
 * | the six follow-up actions (`owner_id`) | none |
 *
 * Every one of them resolves the id against Supabase's `team_members` and
 * writes a Supabase row, *whatever* `NEON_WRITES_DEFAULT` says. So when the
 * roster on screen is Neon's, sending one of its ids to that endpoint asks
 * Supabase to interpret an integer that means someone else. It would not throw:
 * ids 1–5 exist on both sides. It would commit, and attribute a lead to the
 * wrong person.
 *
 * **So the rule is: a Neon-sourced roster may be displayed and may not be
 * written back.** The browser cannot ask which write path a deployment uses —
 * `deploymentWritePath` is deliberately server-only and never sent (see
 * `api/_lib/data/writePath.ts`) — but it does not need to: these particular
 * actions are Supabase-bound unconditionally, so the roster's own provenance is
 * a sufficient condition on its own.
 *
 * ## What this is *not*
 *
 * It is not a fix for the read/write split in general. With the read flag on and
 * the write flag off, a stage change, a note and an imported conversation all
 * land in the database the dashboard is not reading, and none of them is
 * member-keyed so none of them is refused here. That is a real and separate
 * hazard, recorded as a known limit rather than half-patched here.
 *
 * ## Why a module for one predicate
 *
 * The same reason `dashboardReads.ts` and `conversationPaging.ts` are modules:
 * `tsconfig.api.json` type-checks `tests/` and declares no `jsx`, so a rule that
 * lives inside a `.tsx` component is a rule this repo cannot test. The predicate
 * and the sentence shown to the user live here; the hooks and the pages hold a
 * call site each.
 */

import type { RosterPath, TeamMember } from './types'

export type { RosterPath }

/**
 * May a member id from this roster be sent to `/api/pipeline`?
 *
 * `true` for the Supabase roster — the path every deployment runs today, whose
 * ids are exactly what that endpoint expects. `false` for a Neon roster, for the
 * whole reason above.
 *
 * Fail-closed in shape as well as in fact: anything that is not the string
 * `supabase` blocks, so a future third value cannot be silently permitted by a
 * predicate that was written before it existed.
 */
export function memberWritesAllowed(rosterPath: RosterPath): boolean {
  return rosterPath === 'supabase'
}

/**
 * What the user is told instead. It names the cause, not the symptom: "nobody
 * to choose" would read as an empty team, which is the class of message this
 * whole slice exists to stop producing.
 */
export const MEMBER_WRITES_BLOCKED =
  'Assignment is unavailable while the dashboard reads from the application API: ' +
  'team ids there are not the ones the pipeline writer resolves, so a change would ' +
  'be recorded against the wrong person.'

/**
 * The roster as an *assignment* vocabulary: the members whose ids may be written
 * back, which is all of them or none.
 *
 * Separate from the display roster on purpose. `memberName(lead.assigned_to)`
 * must keep resolving on both paths — that is the roster slice's entire point —
 * while the dropdowns that would send an id back must offer nobody. One list
 * cannot be both, and collapsing them would either re-empty the owner chips or
 * re-open the misattribution.
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
 * The same predicate, named for the second surface that needs it: `invite_member`
 * and `update_member` are keyed on `team_members.id` exactly as `assign` is, and
 * an "Edit" that renamed a different person is the worst outcome on that page.
 */
export const teamAdminWritesAllowed = memberWritesAllowed
