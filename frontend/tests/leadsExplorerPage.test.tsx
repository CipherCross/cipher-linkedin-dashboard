// @vitest-environment jsdom
/**
 * Leads is the wide-list reference (Phase 6). These pin the list contracts the
 * redesign must keep: the filter sheet edits a draft and commits every key at
 * once, sorting is a keyboard button whose header states the order, a row opens
 * its conversation from the keyboard without the row being a `role="button"`
 * around other controls, and empty is told apart from no-match.
 *
 * The page runs on the legacy read path here (`resolveReadPath` → 'supabase'),
 * so every lead comes from `useData` and no server page is fetched.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DashboardData, Instance, Lead } from '../src/lib/types'

const openConversation = vi.fn()
const setStage = vi.fn(async () => {})

vi.mock('../src/lib/dashboardReads', () => ({
  fetchNeonCoachingDigests: vi.fn(async () => []),
  fetchNeonLeadsSearchPage: vi.fn(),
  resolveReadPath: async () => 'supabase',
  resolvePhotoPath: async () => 'supabase',
}))
vi.mock('../src/lib/supabase', () => ({ supabase: null }))
vi.mock('../src/lib/api', () => ({ authFetch: vi.fn(), authPost: vi.fn() }))
vi.mock('../src/lib/AuthContext', () => ({ useAuth: () => ({ isAdmin: false }) }))
vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))
vi.mock('../src/lib/ConversationContext', () => ({
  useConversation: () => ({ openConversation }),
}))
vi.mock('../src/lib/usePipelineActions', () => ({
  usePipelineActions: () => ({
    setStage,
    members: [{ id: 7, name: 'Olena' }],
    memberName: (id: number | null) => (id === 7 ? 'Olena' : ''),
  }),
}))

const instance = (id: string): Instance =>
  ({ id, label: `Label ${id}`, account_name: null }) as unknown as Instance

const lead = (over: Partial<Lead>): Lead => ({
  id: 'l1', instance_id: 'notebook-1', campaign_id: 'notebook-1:1',
  profile_url: 'https://www.linkedin.com/in/ada', full_name: 'Ada Lovelace', headline: 'CTO',
  company: 'Engines', added_at: null, invited_at: '2026-09-01T00:00:00Z', connected_at: null,
  first_message_at: null, replied_at: null, last_action_at: '2026-09-02T00:00:00Z',
  pipeline_stage: null, pipeline_substatus: null, lost_reason: null,
  pipeline_stage_changed_at: null, assigned_to: null,
  ...over,
}) as Lead

const data = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({ data: data.value, refetch: vi.fn() }),
}))

const { LeadsExplorer } = await import('../src/pages/LeadsExplorer')

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

function Search() {
  return <output aria-label="search">{useLocation().search}</output>
}

async function paint(entry = '/leads') {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <LeadsExplorer />
      <Search />
    </MemoryRouter>,
  )
  await act(async () => {})
}
const search = () => screen.getByLabelText('search').textContent

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  data.value = dataWith([
    lead({}),
    lead({ id: 'l2', profile_url: 'https://www.linkedin.com/in/bob', full_name: 'Bob Babbage', assigned_to: 7 }),
  ])
})

describe('the filter sheet', () => {
  it('changes nothing until Apply, then commits every key at once and resets the page', async () => {
    await paint('/leads?page=3')
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    const sheet = screen.getByRole('dialog', { name: 'Filters' })
    fireEvent.change(within(sheet).getByLabelText('Milestone'), { target: { value: 'invited' } })
    fireEvent.change(within(sheet).getByLabelText('Owner'), { target: { value: '7' } })
    expect(search()).toBe('?page=3')
    expect(within(sheet).getByText('2 filters selected')).toBeTruthy()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Apply' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    const params = new URLSearchParams(search() ?? '')
    expect(params.get('stage')).toBe('invited')
    expect(params.get('who')).toBe('7')
    expect(params.has('page')).toBe(false)
  })

  it('leaves the URL alone on Cancel, Escape and an un-applied Clear all', async () => {
    await paint('/leads?who=7')
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    let sheet = screen.getByRole('dialog', { name: 'Filters' })
    fireEvent.change(within(sheet).getByLabelText('Milestone'), { target: { value: 'invited' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    expect(search()).toBe('?who=7')

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    sheet = screen.getByRole('dialog', { name: 'Filters' })
    expect((within(sheet).getByLabelText('Milestone') as HTMLSelectElement).value).toBe('all')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear all' }))
    expect((within(sheet).getByLabelText('Owner') as HTMLSelectElement).value).toBe('all')
    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(search()).toBe('?who=7')
  })
})

describe('the leads table', () => {
  it('sorts from a header button and states the order on the header', async () => {
    await paint()
    const header = screen.getByRole('columnheader', { name: /^Lead/ })
    expect(header.hasAttribute('aria-sort')).toBe(false)
    expect(screen.getByRole('columnheader', { name: /Latest activity/ }).getAttribute('aria-sort')).toBe('descending')
    fireEvent.click(within(header).getByRole('button'))
    const params = new URLSearchParams(search() ?? '')
    expect(params.get('sort')).toBe('full_name')
    expect(params.get('dir')).toBe('asc')
    expect(screen.getByRole('columnheader', { name: /^Lead/ }).getAttribute('aria-sort')).toBe('ascending')
  })

  it('opens a conversation through a real button, not a row with role="button"', async () => {
    await paint()
    expect(document.querySelector('tr[role="button"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation with Bob Babbage' }))
    expect(openConversation).toHaveBeenCalledTimes(1)
    expect((openConversation.mock.calls[0] as unknown[])[0]).toMatchObject({ id: 'l2' })
  })

  it('names each row’s stage select and does not open the conversation from it', async () => {
    await paint()
    const select = screen.getByRole('combobox', { name: 'Pipeline stage for Ada Lovelace' })
    fireEvent.click(select)
    fireEvent.change(select, { target: { value: 'interested' } })
    expect(openConversation).not.toHaveBeenCalled()
    expect(setStage).toHaveBeenCalledWith(expect.objectContaining({ id: 'l1' }), 'interested')
  })

  it('tells an empty dataset from a filtered-out one', async () => {
    await paint('/leads?q=zzz')
    expect(screen.getByText('No leads match these filters').closest('[data-empty-kind]')?.getAttribute('data-empty-kind')).toBe('no-match')
    cleanup()
    data.value = dataWith([])
    await paint()
    expect(screen.getByText('No leads yet').closest('[data-empty-kind]')?.getAttribute('data-empty-kind')).toBe('empty')
  })
})
