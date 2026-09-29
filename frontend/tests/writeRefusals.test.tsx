// @vitest-environment jsdom
/**
 * Roster-keyed writes at the real hook call sites: the hooks carry a roster
 * member id to the transactional server path. The injected context and
 * transport make the assertion about the public hook behavior rather than a
 * component's toast styling.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FollowUpState, Lead, TeamMember } from '../src/lib/types'

// --- the four seams ---------------------------------------------------------

const authPost = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()
const patchLead = vi.fn()
const patchFollowUpState = vi.fn()
const refetch = vi.fn()

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
    email: null,
    role: 'member',
  },
]

vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({
    data: { teamMembers, followUpStates: [] },
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

describe('usePipelineActions.assign — S26 transactional parity', () => {
  it('posts a roster id to the actor-scoped server path', async () => {
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

  it('allows unassigning', async () => {
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

  it('offers the whole roster and resolves names from it', () => {
    const { result } = renderHook(() => usePipelineActions())

    expect(result.current.members).toEqual(teamMembers)
    expect(result.current.memberName(1)).toBe('Member One')
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
describe('useFollowUpActions — S26 transactional parity', () => {
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

  it('posts `schedule` with the roster owner', async () => {
    const { result } = renderHook(() => useFollowUpActions())

    await act(async () => {
      await result.current.schedule(LEAD, 7, '2026-08-10')
    })
    expect(authPost).toHaveBeenCalledTimes(1)
    expect((authPost.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({
      action: 'schedule_follow_up',
      owner_id: 7,
    })
  })

  it('posts `reschedule` with its existing owner', async () => {
    const { result } = renderHook(() => useFollowUpActions())

    await act(async () => {
      await result.current.reschedule(LEAD, STATE, '2026-08-12')
    })
    expect((authPost.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({
      action: 'reschedule_follow_up',
      owner_id: STATE.owner_id,
    })
  })

  it('posts `reassign` with the selected owner', async () => {
    const { result } = renderHook(() => useFollowUpActions())

    await act(async () => {
      await result.current.reassign(LEAD, STATE, 7)
    })
    expect((authPost.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({
      action: 'reassign_follow_up',
      owner_id: 7,
    })
  })

  it('posts an ownerless `complete`', async () => {
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

  it('posts a chained `complete` under its next owner', async () => {
    const { result } = renderHook(() => useFollowUpActions())

    await act(async () => {
      await result.current.complete(LEAD, STATE, { ownerId: 7, date: '2026-08-20' })
    })
    expect((authPost.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({
      action: 'complete_follow_up',
      owner_id: 7,
    })
  })
})
