// @vitest-environment jsdom
/**
 * `FollowUpPanel` after its Phase 6 conversion to the canonical `src/ui`
 * contracts.
 *
 * Pins the state machine the conversion must not have touched: the overview
 * offers Schedule when there is no active follow-up and Complete/Reschedule/
 * Reassign/Skip/Cancel when there is one; Skip cannot be submitted until a
 * reason is typed; Schedule calls `actions.schedule` with the owner and date
 * the form holds; a rejected mutation surfaces in `role="alert"` without
 * dropping the operator's draft; a pending submit disables the button so a
 * second click cannot fire a second request; and Back returns to the
 * overview without leaving the panel (`onBack`, which "← Conversation" alone
 * calls, must not fire).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardData, FollowUpState, Lead } from '../src/lib/types'

const fetchNeonFollowUpHistory = vi.fn()
const resolveReadPath = vi.fn()

vi.mock('../src/lib/dashboardReads', () => ({
  fetchNeonFollowUpHistory: (...a: unknown[]) => fetchNeonFollowUpHistory(...a),
  resolveReadPath: () => resolveReadPath(),
}))
vi.mock('../src/lib/supabase', () => ({ supabase: null }))

const data = vi.hoisted(() => ({ value: null as DashboardData | null }))
vi.mock('../src/lib/DataContext', () => ({ useData: () => ({ data: data.value }) }))

const EVE = { id: 5, name: 'Eve', active: true }
const actions = vi.hoisted(() => ({
  actor: 'Eve',
  members: [{ id: 5, name: 'Eve' }],
  assignableMembers: [{ id: 5, name: 'Eve', active: true }],
  memberWritesBlockedReason: null as string | null,
  schedule: vi.fn(),
  reschedule: vi.fn(),
  reassign: vi.fn(),
  complete: vi.fn(),
  skip: vi.fn(),
  cancel: vi.fn(),
}))
vi.mock('../src/lib/useFollowUpActions', () => ({ useFollowUpActions: () => actions }))

const { FollowUpPanel } = await import('../src/components/FollowUpPanel')

const LEAD = {
  id: 'lead-1',
  instance_id: 'notebook-1',
  profile_url: 'https://example.test/in/lead',
  full_name: 'A Lead',
  assigned_to: null,
} as unknown as Lead

const EMPTY_DATA: DashboardData = {
  instances: [], campaigns: [], activity: [], leads: [], syncRuns: [], messages: [],
  conversationReplyIntents: [], annotations: [], steps: [], teamMembers: [], rosterPath: 'supabase',
  pipelineEvents: [], followUpStates: [], latestConversationMessages: [], followUpsAvailable: true,
  savedSearches: [], icps: [], icpPersonas: [], icpIndustries: [], hypotheses: [],
  hypothesisCampaigns: [], campaignSequenceContext: null,
}

const followUpState = (over: Partial<FollowUpState>): FollowUpState => ({
  instance_id: LEAD.instance_id, profile_url: LEAD.profile_url, next_follow_up_date: '2026-09-01',
  owner_id: EVE.id, revision: 0, last_event_id: null, last_mutation_id: null,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', updated_by: 'Eve',
  archived_at: null,
  ...over,
} as FollowUpState)

let onBack: ReturnType<typeof vi.fn<() => void>>

const paint = (initialAction?: 'complete' | 'skip') => {
  onBack = vi.fn<() => void>()
  return render(
    <FollowUpPanel
      lead={LEAD}
      initialAction={initialAction}
      onBack={onBack}
      onImport={() => {}}
      onCompleted={() => {}}
    />,
  )
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  resolveReadPath.mockResolvedValue('neon')
  fetchNeonFollowUpHistory.mockResolvedValue({ events: [], nextCursor: null, hasMore: false })
  actions.memberWritesBlockedReason = null
  data.value = { ...EMPTY_DATA, followUpStates: [] }
})

describe('overview actions', () => {
  it('offers only "Schedule follow-up" when there is no active follow-up', async () => {
    paint()
    await act(async () => {})
    expect(screen.getByRole('button', { name: /Schedule follow-up/ })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('offers Complete/Reschedule/Reassign/Skip/Cancel when a follow-up is active', async () => {
    data.value = { ...EMPTY_DATA, followUpStates: [followUpState({})] }
    paint()
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Complete' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reassign' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /Schedule follow-up/ })).toBeNull()
  })
})

describe('Skip', () => {
  it('keeps the submit disabled until a reason is typed', async () => {
    data.value = { ...EMPTY_DATA, followUpStates: [followUpState({})] }
    paint()
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    const submit = screen.getByRole('button', { name: 'Skip with reason' })
    expect(submit).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Went cold' } })
    expect(submit).toHaveProperty('disabled', false)
  })
})

describe('Schedule', () => {
  it('calls actions.schedule with the form’s owner and date', async () => {
    paint()
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: /Schedule follow-up/ }))
    const dateInput = screen.getByLabelText(/^Date/) as HTMLInputElement
    const ownerSelect = screen.getByLabelText(/^Owner/) as HTMLSelectElement
    // The panel pre-fills both from the actor's own membership, so the
    // fixture only has to confirm the submit passes them straight through.
    expect(ownerSelect.value).toBe('5')
    expect(dateInput.value).not.toBe('')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Schedule' }))
    })

    expect(actions.schedule).toHaveBeenCalledTimes(1)
    expect(actions.schedule).toHaveBeenCalledWith(LEAD, 5, dateInput.value)
  })
})

describe('a rejected mutation', () => {
  it('shows the failure as an alert and keeps the typed reason', async () => {
    data.value = { ...EMPTY_DATA, followUpStates: [followUpState({})] }
    actions.skip.mockRejectedValueOnce(new Error('Network is down'))
    paint()
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Ghosted us' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip with reason' }))
    })

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/Network is down/)
    expect((screen.getByLabelText(/^Reason/) as HTMLTextAreaElement).value).toBe('Ghosted us')
  })
})

describe('a pending submit', () => {
  it('disables the button so a second click cannot fire a second request', async () => {
    let resolveSchedule: (() => void) | undefined
    actions.schedule.mockReturnValueOnce(new Promise<void>((resolve) => { resolveSchedule = resolve }))
    paint()
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: /Schedule follow-up/ }))
    const submit = screen.getByRole('button', { name: 'Schedule' })

    fireEvent.click(submit)
    // Still pending: the button is disabled, so a second click is a no-op.
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.click(submit)
    expect(actions.schedule).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveSchedule?.()
    })
  })
})

describe('Back', () => {
  it('returns to the overview without leaving the panel', async () => {
    paint()
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: /Schedule follow-up/ }))
    expect(screen.getByLabelText(/^Date/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.getByRole('button', { name: /Schedule follow-up/ })).toBeDefined()
    expect(screen.queryByLabelText('Date')).toBeNull()
    expect(onBack).not.toHaveBeenCalled()
  })
})
