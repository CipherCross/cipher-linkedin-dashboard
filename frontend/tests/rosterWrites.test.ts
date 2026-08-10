/**
 * The local fail-closed decision for roster-keyed writes.
 *
 * The server resolves a Supabase or Neon member from its matching actor-scoped
 * store before assignment or a follow-up action. This small pure suite covers
 * the recognized source boundary; `writeRefusals.test.tsx` covers the hooks that
 * carry the ID to the network boundary. The old team-administration pipeline
 * mutations remain permanently closed because `/api/identity` owns that work.
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
  it('permits the Supabase and Neon rosters through their matching write paths', () => {
    expect(memberWritesAllowed('supabase')).toBe(true)
    expect(memberWritesAllowed('neon')).toBe(true)
  })

  it('refuses any unreviewed roster path', () => {
    for (const path of ['', 'Supabase', ' supabase ', 'Neon', 'unknown', 'true']) {
      expect(memberWritesAllowed(path as RosterPath)).toBe(false)
    }
  })

  it('keeps the retired legacy team-administration controls closed', () => {
    expect(teamAdminWritesAllowed('supabase')).toBe(false)
    expect(teamAdminWritesAllowed('neon')).toBe(false)
  })
})

describe('the assignment vocabulary', () => {
  it('offers the whole roster on the Supabase path', () => {
    expect(assignableMembers(ROSTER, 'supabase')).toEqual(ROSTER)
  })

  it('offers the Neon roster to its actor-scoped Neon write path', () => {
    expect(assignableMembers(ROSTER, 'neon')).toEqual(ROSTER)
  })

  it('copies rather than aliasing, so a caller cannot filter the roster in place', () => {
    const assignable = assignableMembers(ROSTER, 'supabase')
    expect(assignable).not.toBe(ROSTER)
    assignable.pop()
    expect(ROSTER).toHaveLength(3)
  })

  it('states the actual refusal instead of looking like an empty team', () => {
    expect(MEMBER_WRITES_BLOCKED).toMatch(/does not recognize/)
    expect(MEMBER_WRITES_BLOCKED).not.toMatch(/^No /)
  })
})
