// @vitest-environment jsdom
/**
 * Hypotheses is Phase 4's list + comparison-table + dirty-form conversion:
 * a sortable comparison table with a keyboard-operable open control per row, a
 * read-only viewer Dialog, and an editor Dialog behind the shared dirty guard.
 * These pin the behaviour the redesign must keep — see SearchLibrary's and
 * Team's own page tests for the same contracts on the card-list and
 * table-directory shapes.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CampaignMetrics, Hypothesis, HypothesisCampaign, Icp, Instance, Lead, SavedSearch,
} from '../src/lib/types'

const api = vi.hoisted(() => ({ authPost: vi.fn() }))
const dataState = vi.hoisted(() => ({
  hypotheses: [] as Hypothesis[],
  icps: [] as Icp[],
  hypothesisCampaigns: [] as HypothesisCampaign[],
  campaigns: [] as CampaignMetrics[],
  leads: [] as Lead[],
  savedSearches: [] as SavedSearch[],
  instances: [] as Instance[],
  upsertHypothesis: vi.fn(),
  removeHypothesis: vi.fn(),
  assignCampaigns: vi.fn(),
  upsertSavedSearch: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('../src/lib/api', () => api)
vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({
    data: {
      hypotheses: dataState.hypotheses,
      icps: dataState.icps,
      hypothesisCampaigns: dataState.hypothesisCampaigns,
      campaigns: dataState.campaigns,
      leads: dataState.leads,
      savedSearches: dataState.savedSearches,
      instances: dataState.instances,
      messages: [],
      pipelineEvents: [],
    },
    upsertHypothesis: dataState.upsertHypothesis,
    removeHypothesis: dataState.removeHypothesis,
    assignCampaigns: dataState.assignCampaigns,
    upsertSavedSearch: dataState.upsertSavedSearch,
  }),
}))
vi.mock('../src/lib/ToastContext', () => ({ useToast: () => toast }))

import { Hypotheses } from '../src/pages/Hypotheses'

const hyp = (over: Partial<Hypothesis>): Hypothesis => ({
  id: 1, name: 'Hypothesis', icp_id: null, description: null, archived: false,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  ...over,
} as Hypothesis)

const campaign = (over: Partial<CampaignMetrics>): CampaignMetrics => ({
  campaign_id: 'c1', campaign_name: 'Campaign', instance_id: 'notebook-1', status: 'active',
  runtime_status: null, is_archived: false, status_observed_at: null, status_source: null,
  status_raw: null, total_leads: 0, invites_sent: 0, accepted: 0, replies: 0,
  acceptance_rate: null, reply_rate: null, lifetime_acceptance_rate: null,
  lifetime_reply_rate: null, last_activity_at: null,
  ...over,
} as CampaignMetrics)

const lead = (over: Partial<Lead>): Lead => ({
  id: 'l1', instance_id: 'notebook-1', campaign_id: 'c1', profile_url: 'https://linkedin.com/in/x',
  full_name: 'Someone', headline: null, company: null, added_at: '2026-08-01T00:00:00Z',
  invited_at: '2026-08-01T00:00:00Z', connected_at: null, first_message_at: null,
  replied_at: null, last_action_at: null, pipeline_stage: null, pipeline_substatus: null,
  ...over,
} as Lead)

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  dataState.instances = [{ id: 'notebook-1', label: 'Notebook 1', account_name: 'Acme LI' } as Instance]
  dataState.icps = [{ id: 10, name: 'Fintech ICP' } as Icp]
  dataState.campaigns = [
    campaign({ campaign_id: 'c1', campaign_name: 'Campaign A', instance_id: 'notebook-1' }),
    campaign({ campaign_id: 'c2', campaign_name: 'Campaign B', instance_id: 'notebook-1' }),
  ]
  // Beta has three leads on campaign A (more leads); Omega has one on campaign
  // B — deliberately so leads-desc and name-desc land in opposite orders.
  dataState.leads = [
    lead({ id: 'l1', profile_url: 'https://linkedin.com/in/a', campaign_id: 'c1' }),
    lead({ id: 'l2', profile_url: 'https://linkedin.com/in/b', campaign_id: 'c1' }),
    lead({ id: 'l3', profile_url: 'https://linkedin.com/in/c', campaign_id: 'c1' }),
    lead({ id: 'l4', profile_url: 'https://linkedin.com/in/d', campaign_id: 'c2' }),
  ]
  dataState.hypotheses = [
    hyp({ id: 1, name: 'Beta Hypothesis', icp_id: 10, description: 'Testing a wedge.' }),
    hyp({ id: 2, name: 'Omega Hypothesis' }),
    hyp({ id: 3, name: 'Old Hypothesis', archived: true }),
  ]
  dataState.hypothesisCampaigns = [
    { hypothesis_id: 1, campaign_id: 'c1', created_at: '2026-08-01T00:00:00Z' },
    { hypothesis_id: 2, campaign_id: 'c2', created_at: '2026-08-01T00:00:00Z' },
  ]
  dataState.savedSearches = [
    { id: 5, name: 'Search X', platform: 'Apollo', description: null, include_keywords: [],
      exclude_keywords: [], boolean_query: null, filters: {}, notes: null, author: null,
      archived: false, hypothesis_id: 1, created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z' },
  ]
})

function renderPage() {
  return render(<Hypotheses />, { wrapper: MemoryRouter })
}

const sortButton = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label},`) })
const ariaSortOf = (label: string) => sortButton(label).closest('th')!.getAttribute('aria-sort')
const openButton = (name: string) => screen.getByRole('button', { name: `Open ${name}` })

describe('the hypothesis comparison table', () => {
  it('lists visible hypotheses and hides archived ones until asked', () => {
    renderPage()
    expect(screen.getByText('Beta Hypothesis')).toBeTruthy()
    expect(screen.getByText('Omega Hypothesis')).toBeTruthy()
    expect(screen.queryByText('Old Hypothesis')).toBeNull()
    fireEvent.click(screen.getByLabelText(/Show archived/))
    expect(screen.getByText('Old Hypothesis')).toBeTruthy()
    expect(within(screen.getByText('Old Hypothesis').closest('td')!).getByText('Archived')).toBeTruthy()
  })

  it('says "no match" when every hypothesis is archived, and "empty" when there are none', () => {
    dataState.hypotheses = [hyp({ id: 3, name: 'Old Hypothesis', archived: true })]
    const { unmount } = renderPage()
    expect(screen.getByText('No hypotheses match this filter').closest('[data-empty-kind]')?.getAttribute('data-empty-kind')).toBe('no-match')
    unmount()
    dataState.hypotheses = []
    renderPage()
    expect(screen.getByText('No hypotheses yet').closest('[data-empty-kind]')?.getAttribute('data-empty-kind')).toBe('empty')
  })

  it('sorts by a column and reflects the active column and direction in aria-sort', () => {
    renderPage()
    // Default sort is Leads, descending: Beta (3 leads) before Omega (1 lead).
    expect(ariaSortOf('Leads')).toBe('descending')
    let names = screen.getAllByRole('button', { name: /^Open /}).map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['Open Beta Hypothesis', 'Open Omega Hypothesis'])

    fireEvent.click(sortButton('Hypothesis'))
    expect(ariaSortOf('Hypothesis')).toBe('descending')
    expect(ariaSortOf('Leads')).toBeNull()
    names = screen.getAllByRole('button', { name: /^Open /}).map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['Open Omega Hypothesis', 'Open Beta Hypothesis'])

    fireEvent.click(sortButton('Hypothesis'))
    expect(ariaSortOf('Hypothesis')).toBe('ascending')
    names = screen.getAllByRole('button', { name: /^Open /}).map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['Open Beta Hypothesis', 'Open Omega Hypothesis'])
  })

  it('opens the viewer through a real, keyboard-reachable button and by clicking it', () => {
    renderPage()
    const open = openButton('Beta Hypothesis')
    // A real <button> — not a bare <tr onClick>, so Enter/Space activates it
    // natively in every browser without any bespoke keydown handling.
    expect(open.tagName).toBe('BUTTON')
    fireEvent.click(open)
    expect(screen.getByRole('dialog', { name: 'Beta Hypothesis' })).toBeTruthy()
  })

  it('archives through the save endpoint and keeps the existing delete confirmation', async () => {
    api.authPost.mockResolvedValue(ok({ hypothesis: hyp({ id: 1, name: 'Beta Hypothesis', archived: true }) }))
    renderPage()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive Beta Hypothesis' })) })
    expect(api.authPost).toHaveBeenCalledWith('/api/playbook', {
      action: 'save_hypothesis',
      hypothesis: { id: 1, archived: true },
    })
    expect(dataState.upsertHypothesis).toHaveBeenCalled()

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Omega Hypothesis' }))
    expect(confirm).toHaveBeenCalled()
    expect(api.authPost).toHaveBeenCalledTimes(1)
    confirm.mockRestore()
  })
})

describe('the hypothesis viewer', () => {
  it('shows the linked ICP and hands off to the editor', () => {
    renderPage()
    fireEvent.click(openButton('Beta Hypothesis'))
    const dialog = screen.getByRole('dialog', { name: 'Beta Hypothesis' })
    expect(within(dialog).getByRole('link', { name: /Fintech ICP/ })).toBeTruthy()
    expect(within(dialog).getByText('Testing a wedge.')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit hypothesis' }))
    expect(screen.queryByRole('dialog', { name: 'Beta Hypothesis' })).toBeNull()
    const editor = screen.getByRole('dialog', { name: 'Edit hypothesis' })
    expect((within(editor).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Beta Hypothesis')
  })
})

describe('the hypothesis editor', () => {
  it('closes a clean editor at once and asks before discarding an edited one', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'New hypothesis' }))
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'New hypothesis' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Beta Hypothesis' }))
    const editor = screen.getByRole('dialog', { name: 'Edit hypothesis' })
    fireEvent.change(within(editor).getByLabelText(/^Name/), { target: { value: 'Beta Hypothesis (EU)' } })
    fireEvent.keyDown(editor, { key: 'Escape' })
    const prompt = screen.getByRole('dialog', { name: 'Discard unsaved changes?' })
    fireEvent.click(within(prompt).getAllByRole('button', { name: 'Keep editing' }).at(-1)!)
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Beta Hypothesis (EU)')
  })

  it('keeps the draft and shows the conflict when a save is refused', async () => {
    api.authPost.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'New hypothesis' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Beta Hypothesis' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create hypothesis' })) })
    expect(screen.getByRole('alert').textContent).toContain('A hypothesis with this name already exists.')
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Beta Hypothesis')
    expect(dataState.upsertHypothesis).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('saves the hypothesis, assigns campaigns and searches, and closes on success', async () => {
    api.authPost
      .mockResolvedValueOnce(ok({ hypothesis: hyp({ id: 9, name: 'New bet' }) }))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({ search: { id: 5, hypothesis_id: 9 } }))
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'New hypothesis' }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'New bet' } })
    fireEvent.click(screen.getByLabelText(/^Campaign A/))
    fireEvent.click(screen.getByLabelText(/^Search X/))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create hypothesis' })) })

    expect(api.authPost).toHaveBeenNthCalledWith(1, '/api/playbook', {
      action: 'save_hypothesis',
      hypothesis: { name: 'New bet', icp_id: null, description: null, archived: false },
    })
    expect(api.authPost).toHaveBeenNthCalledWith(2, '/api/playbook', {
      action: 'set_hypothesis_campaigns',
      hypothesis_id: 9,
      campaign_ids: ['c1'],
    })
    expect(api.authPost).toHaveBeenNthCalledWith(3, '/api/playbook', {
      action: 'assign_search',
      search_id: 5,
      hypothesis_id: 9,
    })
    expect(dataState.assignCampaigns).toHaveBeenCalledWith(9, ['c1'])
    expect(dataState.upsertHypothesis).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
