/**
 * The rule that keeps a member id from crossing providers on the way *out*.
 *
 * The roster slice made reading `leads.assigned_to` correct on the Neon path by
 * serving the roster from the same database. Writing it is a separate question
 * with a different answer: `/api/pipeline`'s member-keyed actions — `assign`,
 * `invite_member`, `update_member`, `add_member`, `set_member_active` and the
 * six follow-up actions — have **no Neon branch at all** and resolve every id
 * against Supabase, whatever `NEON_WRITES_DEFAULT` says. So a Neon
 * `team_members.id` sent there is an integer that names a different person, on a
 * request that succeeds.
 *
 * These are pure functions for the reason `dashboardReads.ts` is a module: the
 * hooks and pages that consult them are `.tsx` or React hooks and this repo's
 * node-environment test run cannot drive either. What is provable here is the
 * decision; the call sites are covered by `tsc -b`, by the browser run, and by
 * nothing else.
 */

import { describe, expect, it } from 'vitest'

import {
  MEMBER_WRITES_BLOCKED,
  assignableMembers,
  memberWritesAllowed,
  teamAdminWritesAllowed,
} from '../src/lib/rosterWrites'
import type { RosterPath, TeamMember } from '../src/lib/types'

const member = (id: number, active = true): TeamMember => ({
  id,
  name: `Member ${id}`,
  active,
  created_at: '2026-01-01T00:00:00.000Z',
  auth_user_id: null,
  email: null,
  role: 'member',
})

const ROSTER = [member(1), member(2), member(3, false)]

describe('which roster may be written back', () => {
  it('permits the Supabase roster and refuses the Neon one', () => {
    // The direction is the whole assertion. `supabase` is what every deployment
    // runs today and what `/api/pipeline` expects; `neon` is the id space it
    // does not read.
    expect(memberWritesAllowed('supabase')).toBe(true)
    expect(memberWritesAllowed('neon')).toBe(false)
  })

  it('refuses anything that is not exactly `supabase`', () => {
    // Fail-closed in shape as well as in fact: a third path added later must
    // block until somebody decides it should not, rather than being permitted by
    // a predicate written before it existed.
    for (const path of ['', 'Supabase', ' supabase ', 'neon', 'unknown', 'true']) {
      expect(memberWritesAllowed(path as RosterPath)).toBe(path === 'supabase')
    }
  })

  it('gates the Team page on the same predicate as assignment', () => {
    // `invite_member` and `update_member` are keyed on `team_members.id` exactly
    // as `assign` is, so a second predicate could only ever drift from this one.
    expect(teamAdminWritesAllowed).toBe(memberWritesAllowed)
  })
})

describe('the assignment vocabulary', () => {
  it('offers the whole roster on the Supabase path', () => {
    expect(assignableMembers(ROSTER, 'supabase')).toEqual(ROSTER)
  })

  it('offers nobody on the Neon path, while the roster itself stays whole', () => {
    // Two lists, not one. `memberName(lead.assigned_to)` must keep resolving —
    // that is what the roster slice bought — while nothing may be *chosen*.
    expect(assignableMembers(ROSTER, 'neon')).toEqual([])
    expect(ROSTER).toHaveLength(3)
  })

  it('copies rather than aliasing, so a caller cannot filter the roster in place', () => {
    const assignable = assignableMembers(ROSTER, 'supabase')
    expect(assignable).not.toBe(ROSTER)
    assignable.pop()
    expect(ROSTER).toHaveLength(3)
  })

  it('states the cause rather than the symptom', () => {
    // "No teammates to choose" would read as an empty team, which is precisely
    // the confidently-wrong message this slice exists to stop producing.
    expect(MEMBER_WRITES_BLOCKED).toMatch(/wrong person/)
    expect(MEMBER_WRITES_BLOCKED).not.toMatch(/^No /)
  })
})
