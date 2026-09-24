// @vitest-environment jsdom
/**
 * CampaignDetail after the Phase 9 conversion of its Performance/Sequence
 * presentation: the breadcrumb `PageHeader`, the Performance tab's compare
 * table (now `TableFrame`/`Table`/`SortHeader` in place of the hand-built
 * `<table>` with `sortable`/`sort-ind`), and the Sequence tab.
 *
 * What is real: `CampaignDetail`, `CampaignCompareTable`, `MessageSequence`,
 * the shared `LeadsAndRepliesWorkspace` and the router. Replaced:
 * `DataContext`, `ConversationContext`, `ToastContext` and `authPost`.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CampaignMetrics, DashboardData, Instance } from '../src/lib/types'

const data = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({ data: data.value, refetch: vi.fn(), patchCampaign: vi.fn() }),
}))
vi.mock('../src/lib/ConversationContext', () => ({
  useConversation: () => ({ openConversation: vi.fn() }),
}))
vi.mock('../src/lib/ToastContext', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))
vi.mock('../src/lib/api', () => ({ authFetch: vi.fn(), authPost: vi.fn() }))

const { CampaignDetail } = await import('../src/pages/CampaignDetail')

const INSTANCE: Instance = {
  id: 'notebook-1',
  label: 'Mykyta',
  account_name: 'Mykyta S',
  account_url: null,
  account_avatar: null,
  last_sync_at: '2026-09-01T00:00:00.000Z',
} as unknown as Instance

function campaign(over: Partial<CampaignMetrics>): CampaignMetrics {
  return {
    campaign_id: 'notebook-1:1',
    campaign_name: 'Campaign',
    instance_id: 'notebook-1',
    status: 'legacy-active',
    runtime_status: 'running',
    is_archived: false,
    status_observed_at: null,
    status_source: null,
    status_raw: null,
    invites_sent: 10,
    accepted: 6,
    replies: 3,
    acceptance_rate: 60,
    reply_rate: 50,
    total_leads: 10,
    briefing_context: null,
    briefing_context_updated_at: null,
    ...over,
  } as CampaignMetrics
}

const FOUNDERS = campaign({ campaign_id: 'notebook-1:1', campaign_name: 'Founders Outreach' })
const WARM = campaign({
  campaign_id: 'notebook-1:2', campaign_name: 'Warm Intros',
  invites_sent: 4, accepted: 2, replies: 1, acceptance_rate: 50, reply_rate: 50, total_leads: 4,
})

function dataWith(campaigns: CampaignMetrics[]): DashboardData {
  return {
    instances: [INSTANCE], campaigns, activity: [], leads: [], syncRuns: [], messages: [],
    conversationReplyIntents: [], annotations: [], steps: [], teamMembers: [],
    rosterPath: 'neon', pipelineEvents: [], followUpStates: [],
    latestConversationMessages: [], followUpsAvailable: true, savedSearches: [],
    icps: [], icpPersonas: [], icpIndustries: [], hypotheses: [], hypothesisCampaigns: [],
    campaignSequenceContext: null,
  } as unknown as DashboardData
}

function paint(id = 'notebook-1:1', search = '') {
  return render(
    <MemoryRouter initialEntries={[`/campaign/${encodeURIComponent(id)}${search}`]}>
      <Routes>
        <Route path="/campaign/:id" element={<CampaignDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('the campaign header', () => {
  it('names the page for the campaign with a breadcrumb back to the account', () => {
    data.value = dataWith([FOUNDERS, WARM])
    paint()

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeTruthy()
    expect(within(nav).getByRole('link', { name: 'Mykyta S' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Founders Outreach' })).toBeTruthy()
  })
})

describe('the Performance tab', () => {
  it('renders the compare table as a named table with sort headers that flip aria-sort', () => {
    data.value = dataWith([FOUNDERS, WARM])
    paint('notebook-1:1', '?tab=performance&cmp=notebook-1%3A2')

    const table = screen.getByRole('table', { name: 'Campaign comparison' })
    expect(within(table).getByText('Founders Outreach')).toBeTruthy()
    expect(within(table).getByText('Warm Intros')).toBeTruthy()

    const header = screen.getByRole('columnheader', { name: /Campaign/ })
    expect(header.getAttribute('aria-sort')).toBeNull()
    fireEvent.click(within(header).getByRole('button', { name: /Campaign/ }))
    expect(header.getAttribute('aria-sort')).toBe('ascending')
    fireEvent.click(within(header).getByRole('button', { name: /Campaign/ }))
    expect(header.getAttribute('aria-sort')).toBe('descending')
  })
})

describe('the Sequence tab', () => {
  it('renders', () => {
    data.value = dataWith([FOUNDERS])
    paint('notebook-1:1', '?tab=sequence')

    expect(screen.getByRole('heading', { name: 'Created in Linked Helper' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Message sequence' })).toBeTruthy()
  })
})

describe('an unknown campaign', () => {
  it('shows the not-found empty state instead of the dashboard', () => {
    data.value = dataWith([FOUNDERS])
    paint('does-not-exist')

    expect(screen.getByText('Campaign not found')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Campaign' })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: 'Campaign section' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Back to overview' })).toBeTruthy()
  })
})
