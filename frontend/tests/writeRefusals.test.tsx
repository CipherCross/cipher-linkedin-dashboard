// @vitest-environment jsdom
/**
 * The two write refusals, at their call sites.
 *
 * `tests/rosterWrites.test.ts` proves the *predicate* — `memberWritesAllowed`
 * and `assignableMembers` — and says so in its own header: "the call sites are
 * covered by `tsc -b`, by the browser run, and by nothing else." `N-ROSTER.md`
 * then measured exactly that, and its mutations **9 and 10** deleted the refusal
 * from `usePipelineActions.assign` and `useFollowUpActions.mutate` and reddened
 * **nothing**. `N-BROWSER-RUN.md` re-measured the same hole from the other side
 * with mutations 11 and 12.
 *
 * This file closes it. The two hooks are real, the predicate they consult is
 * real, and only their four context dependencies are replaced — because what is
 * under test is *whether the hook asks* and *whether it refuses*, not what a
 * toast looks like or how a fetch is spelled.
 *
 * ## What each assertion would catch
 *
 * The refusal is not a convenience. `/api/pipeline`'s member-keyed actions have
 * no Neon branch and resolve every id against Supabase, so a Neon
 * `team_members.id` sent there names a different person on a request that
 * **succeeds**. The load-bearing assertions are therefore the negative ones: no
 * request was made. A refusal that toasts and then posts anyway would satisfy a
 * weaker test and commit the misattribution.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MEMBER_WRITES_BLOCKED } from '../src/lib/rosterWrites'
import type { FollowUpState, Lead, RosterPath, TeamMember } from '../src/lib/types'

// --- the four seams ---------------------------------------------------------

const authPost = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()
const patchLead = vi.fn()
const patchFollowUpState = vi.fn()
const refetch = vi.fn()

/** Mutated per test, read through the mocked `useData`. */
let rosterPath: RosterPath = 'supabase'

vi.mock('../src/lib/api', () => ({
  authPost: (...args: unknown[]) => authPost(...args),
  authFetch: vi.fn(),
}))

vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

vi.mock('../src/lib/AuthContext', () => ({
  useAuth: () => ({
    member: { id: 1, name: 'Tester', role: 'admin' },
    isAdmin: true,
  }),
}))

const teamMembers: TeamMember[] = [
  {
    id: 1,
    name: 'Member One',
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    auth_user_id: null,
    email: null,
    role: 'member',
  },
]

vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({
    data: { teamMembers, rosterPath, followUpStates: [] },
    patchLead,
    patchFollowUpState,
    refetch,
  }),
}))

const { usePipelineActions } = await import('../src/lib/usePipelineActions')
const { useFollowUpActions } = await import('../src/lib/useFollowUpActions')

const LEAD = {
  id: '11111111-1111-4111-8111-111111111111',
  instance_id: 'notebook-1',
  profile_url: 'https://example.test/in/someone',
  assigned_to: null,
  pipeline_stage: null,
  pipeline_substatus: null,
  lost_reason: null,
  pipeline_stage_changed_at: null,
} as unknown as Lead

beforeEach(() => {
  rosterPath = 'supabase'
  authPost.mockReset()
  authPost.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
  toastError.mockReset()
  patchLead.mockReset()
  patchFollowUpState.mockReset()
  refetch.mockReset()
})

afterEach(() => {
  // Explicit: without `globals: true` RTL's automatic cleanup never installs.
  cleanup()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------

describe('usePipelineActions.assign — N-ROSTER mutation 9', () => {
  it('refuses a member id while the roster is the application API’s, and sends nothing', async () => {
    rosterPath = 'neon'
    const { result } = renderHook(() => usePipelineActions())

    await act(async () => {
      await result.current.assign(LEAD, 7)
    })

    expect(toastError).toHaveBeenCalledWith(MEMBER_WRITES_BLOCKED)
    // The assertion that matters: the request that would have committed a Neon
    // id against a Supabase row was never made.
    expect(authPost).not.toHaveBeenCalled()
    // And the board was not moved optimistically either — a patched lead with no
    // write behind it is a lie the next refresh silently corrects.
    expect(patchLead).not.toHaveBeenCalled()
  })

  it('still allows unassigning on that roster, because null names nobody', async () => {
    rosterPath = 'neon'
    const { result } = renderHook(() => usePipelineActions())

    await act(async () => {
      await result.current.assign(LEAD, null)
    })

    expect(toastError).not.toHaveBeenCalled()
    expect(authPost).toHaveBeenCalledWith('/api/pipeline', {
      action: 'assign',
      lead_id: LEAD.id,
      member_id: null,
    })
  })

  it('posts the id on the Supabase roster — the permissive value every deployment runs today', async () => {
    rosterPath = 'supabase'
    const { result } = renderHook(() => usePipelineActions())

    await act(async () => {
      await result.current.assign(LEAD, 7)
    })

    expect(toastError).not.toHaveBeenCalled()
    expect(authPost).toHaveBeenCalledWith('/api/pipeline', {
      action: 'assign',
      lead_id: LEAD.id,
      member_id: 7,
    })
  })

  it('empties the assignment dropdowns and states why, without hiding the display roster', () => {
    rosterPath = 'neon'
    const { result } = renderHook(() => usePipelineActions())

    // Two lists on purpose: `memberName` must still resolve an id to a name, or
    // every owner chip on the Neon path loses its label.
    expect(result.current.assignableMembers).toEqual([])
    expect(result.current.members).toHaveLength(1)
    expect(result.current.memberName(1)).toBe('Member One')
    expect(result.current.memberWritesBlockedReason).toBe(MEMBER_WRITES_BLOCKED)
  })
})

/**
 * Driven through the hook's **public** surface — `schedule`, `reschedule`,
 * `reassign`, `complete`, `cancel` — rather than the private `mutate` it wraps.
 * That is not politeness: `mutate` receives `ownerId` as an argument, and the
 * question these tests answer is which of the six wrappers *supplies* one. A
 * test that called `mutate` directly would pass unchanged if `reschedule` stopped
 * echoing `state.owner_id`, which is precisely the case a per-control check
 * misses.
 */
describe('useFollowUpActions — N-ROSTER mutation 10', () => {
  const STATE: FollowUpState = {
    instance_id: LEAD.instance_id,
    profile_url: LEAD.profile_url,
    next_follow_up_date: '2026-08-08',
    owner_id: 3,
    revision: 4,
    last_event_id: null,
    last_mutation_id: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    updated_by: 'Tester',
    archived_at: null,
  }

  it('refuses `schedule`, and throws so the caller cannot report success', async () => {
    rosterPath = 'neon'
    const { result } = renderHook(() => useFollowUpActions())

    await expect(
      result.current.schedule(LEAD, 7, '2026-08-10'),
    ).rejects.toThrow(MEMBER_WRITES_BLOCKED)

    expect(toastError).toHaveBeenCalledWith(MEMBER_WRITES_BLOCKED)
    expect(authPost).not.toHaveBeenCalled()
    // No optimistic state either: a patch before the guard paints a follow-up
    // that never existed.
    expect(patchFollowUpState).not.toHaveBeenCalled()
  })

  it('refuses `reschedule`, which carries an owner the user never chose', async () => {
    // The sharp case. The form pre-fills from `state.owner_id`, so the id crosses
    // on an action whose visible subject is a *date*. N-ROSTER's browser run
    // caught this by clicking Save owner on a pre-filled panel.
    rosterPath = 'neon'
    const { result } = renderHook(() => useFollowUpActions())

    await expect(
      result.current.reschedule(LEAD, STATE, '2026-08-12'),
    ).rejects.toThrow(MEMBER_WRITES_BLOCKED)
    expect(authPost).not.toHaveBeenCalled()
  })

  it('refuses `reassign`, whose whole subject is the owner', async () => {
    rosterPath = 'neon'
    const { result } = renderHook(() => useFollowUpActions())

    await expect(
      result.current.reassign(LEAD, STATE, 7),
    ).rejects.toThrow(MEMBER_WRITES_BLOCKED)
    expect(authPost).not.toHaveBeenCalled()
  })

  it('lets an ownerless `complete` through on that same roster', async () => {
    rosterPath = 'neon'
    authPost.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ state: null }),
    })
    const { result } = renderHook(() => useFollowUpActions())

    await act(async () => {
      await result.current.complete(LEAD, STATE)
    })

    await waitFor(() => expect(authPost).toHaveBeenCalledTimes(1))
    const [, body] = authPost.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.action).toBe('complete_follow_up')
    expect(body.owner_id).toBeNull()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('refuses a `complete` that schedules the next one under an owner', async () => {
    // `complete` is ownerless only when it does not chain. With a follow-up
    // attached it carries an id like any other, and the guard must see it.
    rosterPath = 'neon'
    const { result } = renderHook(() => useFollowUpActions())

    await expect(
      result.current.complete(LEAD, STATE, { ownerId: 7, date: '2026-08-20' }),
    ).rejects.toThrow(MEMBER_WRITES_BLOCKED)
    expect(authPost).not.toHaveBeenCalled()
  })

  it('carries the owner on the Supabase roster', async () => {
    rosterPath = 'supabase'
    authPost.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ state: null }),
    })
    const { result } = renderHook(() => useFollowUpActions())

    await act(async () => {
      await result.current.schedule(LEAD, 7, '2026-08-10')
    })

    const [, body] = authPost.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.owner_id).toBe(7)
    expect(toastError).not.toHaveBeenCalled()
  })
})
