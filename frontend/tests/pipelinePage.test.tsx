// @vitest-environment jsdom
/**
 * Pipeline is Phase 8 of the component redesign: the board's card open target,
 * its three "Manage lead" selects and the scroll region converted onto
 * canonical primitives. These pin the behaviour that must not change: a card
 * opens its conversation, the selects write through setStage/assign without
 * opening it, choosing "lost" defers to the shared LostReasonModal instead of
 * writing directly, and a blocked owner select surfaces its reason as visible
 * text (not just a title attribute).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DashboardData, Instance, Lead, TeamMember } from '../src/lib/types'

const openConversation = vi.fn()
const setStage = vi.fn(async () => {})
const assign = vi.fn(async () => {})

const pipelineActionsState = vi.hoisted(() => ({
  memberWritesBlockedReason: null as string | null,
}))

vi.mock('../src/lib/dashboardReads', () => ({
  fetchNeonCoachingDigests: vi.fn(async () => []),
  fetchNeonLeadsSearchPage: vi.fn(),
  resolveReadPath: async () => 'supabase',
  resolvePhotoPath: async () => 'supabase',
}))
vi.mock('../src/lib/supabase', () => ({ supabase: null }))
vi.mock('../src/lib/api', () => ({ authFetch: vi.fn(), authPost: vi.fn() }))
vi.mock('../src/lib/AuthContext', () => ({ useAuth: () => ({ isAdmin: false, member: null }) }))
vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))
vi.mock('../src/lib/ConversationContext', () => ({
  useConversation: () => ({ openConversation }),
}))
vi.mock('../src/lib/usePipelineActions', () => ({
  usePipelineActions: () => ({
    setStage,
    assign,
    actor: 'Olena',
    members: [
      { id: 7, name: 'Olena', active: true },
      { id: 8, name: 'Bohdan', active: true },
    ] as TeamMember[],
    memberName: (id: number | null) => (id === 7 ? 'Olena' : id === 8 ? 'Bohdan' : ''),
    memberWritesBlockedReason: pipelineActionsState.memberWritesBlockedReason,
  }),
}))

const instance = (id: string): Instance =>
  ({ id, label: `Label ${id}`, account_name: null }) as unknown as Instance

const lead = (over: Partial<Lead>): Lead => ({
  id: 'l1', instance_id: 'notebook-1', campaign_id: 'notebook-1:1',
  profile_url: 'https://www.linkedin.com/in/ada', full_name: 'Ada Lovelace', headline: 'CTO',
  company: 'Engines', added_at: null, invited_at: '2026-09-01T00:00:00Z', connected_at: null,
  first_message_at: null, replied_at: '2026-09-05T00:00:00Z', last_action_at: '2026-09-05T00:00:00Z',
  pipeline_stage: 'negative', pipeline_substatus: null, lost_reason: null,
  pipeline_stage_changed_at: '2026-09-05T00:00:00Z', assigned_to: 7,
  ...over,
}) as Lead

const data = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({ data: data.value, refetch: vi.fn() }),
}))

const { Pipeline } = await import('../src/pages/Pipeline')

function dataWith(leads: Lead[]): DashboardData {
  return {
    instances: [instance('notebook-1')],
    campaigns: [{ campaign_id: 'notebook-1:1', instance_id: 'notebook-1', campaign_name: 'Fintech' }],
    activity: [], leads, syncRuns: [], messages: [], conversationReplyIntents: [], annotations: [],
    steps: [], teamMembers: [], rosterPath: 'supabase', pipelineEvents: [], followUpStates: [],
    latestConversationMessages: [], followUpsAvailable: true, savedSearches: [], icps: [],
    icpPersonas: [], icpIndustries: [], hypotheses: [], hypothesisCampaigns: [],
    campaignSequenceContext: null,
  } as unknown as DashboardData
}

async function paint() {
  render(
    <MemoryRouter initialEntries={['/pipeline']}>
      <Pipeline />
    </MemoryRouter>,
  )
  await act(async () => {})
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  pipelineActionsState.memberWritesBlockedReason = null
  data.value = dataWith([lead({})])
})

describe('the board scroll region', () => {
  it('names the horizontally scrolling board as a reachable region', async () => {
    await paint()
    const region = screen.getByRole('region', { name: /Pipeline board/ })
    expect(region.tabIndex).toBe(0)
  })
})

describe('a card', () => {
  it('opens its conversation from the card’s open button', async () => {
    await paint()
    fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace/ }))
    expect(openConversation).toHaveBeenCalledTimes(1)
    expect((openConversation.mock.calls[0] as unknown[])[0]).toMatchObject({ id: 'l1' })
  })

  it('names the three Manage-lead selects and writes through setStage/assign without opening the conversation', async () => {
    await paint()
    const substatus = screen.getByRole('combobox', { name: 'Pipeline substatus' })
    const stage = screen.getByRole('combobox', { name: 'Pipeline stage' })
    const owner = screen.getByRole('combobox', { name: 'Lead owner' })

    fireEvent.change(substatus, { target: { value: 'soft_no' } })
    expect(setStage).toHaveBeenCalledWith(expect.objectContaining({ id: 'l1' }), 'negative', { substatus: 'soft_no' })

    fireEvent.change(stage, { target: { value: 'interested' } })
    expect(setStage).toHaveBeenCalledWith(expect.objectContaining({ id: 'l1' }), 'interested')

    fireEvent.change(owner, { target: { value: '8' } })
    expect(assign).toHaveBeenCalledWith(expect.objectContaining({ id: 'l1' }), 8)

    expect(openConversation).not.toHaveBeenCalled()
  })

  it('opens the "Mark as lost" dialog instead of writing when "lost" is chosen', async () => {
    await paint()
    const stage = screen.getByRole('combobox', { name: 'Pipeline stage' })
    fireEvent.change(stage, { target: { value: 'lost' } })

    expect(screen.getByRole('dialog', { name: /Mark as lost/ })).toBeTruthy()
    expect(setStage).not.toHaveBeenCalled()
  })

  it('disables the owner select and shows the block reason as visible text when writes are blocked', async () => {
    pipelineActionsState.memberWritesBlockedReason = 'Assignment is unavailable right now.'
    await paint()
    const owner = screen.getByRole('combobox', { name: 'Lead owner' }) as HTMLSelectElement
    expect(owner.disabled).toBe(true)
    expect(screen.getByText('Assignment is unavailable right now.')).toBeTruthy()
  })
})
