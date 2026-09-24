// @vitest-environment jsdom
/**
 * AccountDetail is Phase 9's account-drilldown conversion: the breadcrumb
 * PageHeader, the KPI grid, the "Added this week" meter and the shared
 * `CampaignTable` (canonical select filters, `SortHeader` columns, and a
 * campaign-name link in place of the old pressable `<tr role="button">`).
 *
 * What is real: `AccountDetail` and `CampaignTable`. Replaced: `DataContext`
 * and the router (the page reads `:id` and the `range` search param).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CampaignMetrics, DashboardData, Instance } from '../src/lib/types'

const data = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('../src/lib/DataContext', () => ({
  useData: () => ({ data: data.value }),
}))

const { AccountDetail } = await import('../src/pages/AccountDetail')

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
    total_leads: 10,
    invites_sent: 8,
    accepted: 5,
    replies: 3,
    acceptance_rate: 0.625,
    reply_rate: 0.6,
    last_activity_at: '2026-09-01T00:00:00.000Z',
    ...over,
  } as CampaignMetrics
}

const FOUNDERS = campaign({
  campaign_id: 'notebook-1:1', campaign_name: 'Founders Outreach', runtime_status: 'running',
})
const WARM = campaign({
  campaign_id: 'notebook-1:2', campaign_name: 'Warm Intros', runtime_status: 'completed',
  total_leads: 4, invites_sent: 2, accepted: 1, replies: 0,
})

function dataWith(campaigns: CampaignMetrics[], instances: Instance[] = [INSTANCE]): DashboardData {
  return {
    instances, campaigns, activity: [], leads: [], syncRuns: [], messages: [],
    conversationReplyIntents: [], annotations: [], steps: [], teamMembers: [],
    rosterPath: 'supabase', pipelineEvents: [], followUpStates: [],
    latestConversationMessages: [], followUpsAvailable: true, savedSearches: [],
    icps: [], icpPersonas: [], icpIndustries: [], hypotheses: [], hypothesisCampaigns: [],
    campaignSequenceContext: null,
  } as unknown as DashboardData
}

function paint(id = 'notebook-1') {
  return render(
    <MemoryRouter initialEntries={[`/account/${encodeURIComponent(id)}`]}>
      <Routes>
        <Route path="/account/:id" element={<AccountDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('the account header', () => {
  it('shows a breadcrumb back to Overview and the account name as the heading', () => {
    data.value = dataWith([FOUNDERS, WARM])
    paint()
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeTruthy()
    // Exact: the avatar's initials must not leak into the heading's name.
    expect(screen.getByRole('heading', { level: 1, name: 'Mykyta S' })).toBeTruthy()
  })
})

describe('the campaign table', () => {
  it('is a named table listing every campaign on the account', () => {
    data.value = dataWith([FOUNDERS, WARM])
    paint()
    const table = screen.getByRole('table', { name: 'Campaigns on this instance' })
    expect(within(table).getByText('Founders Outreach')).toBeTruthy()
    expect(within(table).getByText('Warm Intros')).toBeTruthy()
  })

  it('flips aria-sort on a sortable header when clicked', () => {
    data.value = dataWith([FOUNDERS, WARM])
    paint()
    const header = screen.getByRole('columnheader', { name: /Campaign/ })
    expect(header.getAttribute('aria-sort')).toBeNull()
    fireEvent.click(within(header).getByRole('button', { name: /Campaign/ }))
    expect(header.getAttribute('aria-sort')).toBe('ascending')
    fireEvent.click(within(header).getByRole('button', { name: /Campaign/ }))
    expect(header.getAttribute('aria-sort')).toBe('descending')
  })

  it('links the campaign name to the campaign route with no pressable-row button', () => {
    data.value = dataWith([FOUNDERS, WARM])
    paint()
    const link = screen.getByRole('link', { name: 'Founders Outreach' })
    expect(link.getAttribute('href')).toBe(`/campaign/${encodeURIComponent('notebook-1:1')}`)
    expect(screen.queryByRole('button', { name: /Open campaign/ })).toBeNull()
    expect(document.querySelector('tr[role="button"]')).toBeNull()
  })

  it('narrows rows with the runtime-status filter and shows the no-match copy', () => {
    data.value = dataWith([FOUNDERS, WARM])
    paint()
    expect(screen.getByText('Founders Outreach')).toBeTruthy()
    expect(screen.getByText('Warm Intros')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Filter campaigns by runtime status'), {
      target: { value: 'completed' },
    })
    expect(screen.getByText('Warm Intros')).toBeTruthy()
    expect(screen.queryByText('Founders Outreach')).toBeNull()

    fireEvent.change(screen.getByLabelText('Filter campaigns by runtime status'), {
      target: { value: 'draft' },
    })
    expect(screen.getByText('No campaigns match these filters.')).toBeTruthy()
  })
})

describe('an unknown account', () => {
  it('shows the not-found empty state instead of the dashboard', () => {
    data.value = dataWith([FOUNDERS], [INSTANCE])
    paint('does-not-exist')
    expect(screen.getByText('Account not found')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('link', { name: 'Back to overview' })).toBeTruthy()
  })
})
