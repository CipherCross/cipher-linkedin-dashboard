// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Overview } from '../src/pages/Overview'
import type { DashboardData, OverviewAccountCampaigns, OverviewPerformance, OverviewSystemTotals } from '../src/lib/types'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
const localValues = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => localValues.set(key, value),
    removeItem: (key: string) => localValues.delete(key),
    clear: () => localValues.clear(),
  },
})

const fetchPerformance = vi.fn()
const fetchCampaigns = vi.fn()
const fetchSystem = vi.fn()
const resolvePath = vi.fn()
let data: DashboardData

vi.mock('../src/lib/DataContext', () => ({ useData: () => ({ data, phase: 'full' }) }))
vi.mock('../src/lib/dashboardReads', () => ({
  resolveReadPath: () => resolvePath(),
  fetchNeonOverviewSystemTotals: (...args: unknown[]) => fetchSystem(...args),
  fetchNeonOverviewPerformance: (...args: unknown[]) => fetchPerformance(...args),
  fetchNeonOverviewAccountCampaigns: (...args: unknown[]) => fetchCampaigns(...args),
}))

const totals = (over: Record<string, number> = {}) => ({
  leads: 100, invited: 100, connected: 40, messaged: 30, replied: 10,
  acceptedOfInvited: 40, repliedOfConnected: 10, ...over,
})
const system = (over: Partial<OverviewSystemTotals> = {}): OverviewSystemTotals => ({ leads: 100, invited: 100, connected: 40, messaged: 30, replied: 10, ...over })
const performance = (over: Partial<OverviewPerformance> = {}): OverviewPerformance => ({
  current: { invited: 20, connected: 40, replied: 10 },
  previous: { invited: 10, connected: 32, replied: 0 },
  cohort: { leads: 100, invited: 100, connected: 40, messaged: 30, replied: 10 },
  previousCohort: { leads: 80, invited: 80, connected: 32, messaged: 20, replied: 8 },
  lifetime: { leads: 200, invited: 200, connected: 100, messaged: 80, replied: 25 },
  accounts: [{
    instance_id: 'one',
    current: { invited: 20, connected: 40, replied: 10 },
    previous: { invited: 10, connected: 32, replied: 0 },
    cohort: { leads: 100, invited: 100, connected: 40, messaged: 30, replied: 10 },
    previousCohort: { leads: 80, invited: 80, connected: 32, messaged: 20, replied: 8 },
    lifetime: { leads: 200, invited: 200, connected: 100, messaged: 80, replied: 25 },
  }],
  activity: [],
  ...over,
})
const campaign = (index = 1, over: Record<string, unknown> = {}) => ({
  campaign_id: `one:${index}`, campaign_name: `Campaign ${index}`, instance_id: 'one', status: 'active',
  runtime_status: 'running', is_archived: false, status_observed_at: null, status_source: null, status_raw: null,
  total_leads: 20, invites_sent: 20, connected: 10, first_messages: 8, accepted: 10, replies: 4,
  acceptance_rate: 50, reply_rate: 40, lifetime_acceptance_rate: 50, lifetime_reply_rate: 40,
  last_activity_at: null, briefing_context: null, briefing_context_updated_at: null, ...over,
})
const accountCampaigns = (campaigns = [campaign()]): OverviewAccountCampaigns => ({
  accounts: [{
    instance_id: 'one', totals: totals(), previous: null, lifetime: totals(),
    cohort: { leads: 100, invited: 100, connected: 40, messaged: 30, replied: 10 }, previousCohort: null,
  }],
  campaigns: campaigns as never,
})
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const renderOverview = (entries = ['/']) => render(<MemoryRouter initialEntries={entries}><Overview /></MemoryRouter>)

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
  data = {
    instances: [{ id: 'one', label: 'Notebook one', account_name: 'Alice', last_sync_at: '2026-09-06T10:00:00Z', agent_version: null, account_url: null, account_avatar: null, config: null, config_updated_at: null }],
    campaigns: [campaign()] as never, leads: [], activity: [], syncRuns: [], messages: [], conversationReplyIntents: [], annotations: [], steps: [], teamMembers: [], rosterPath: 'neon', pipelineEvents: [], followUpStates: [], latestConversationMessages: [], followUpsAvailable: false, savedSearches: [], icps: [], icpPersonas: [], icpIndustries: [], hypotheses: [], hypothesisCampaigns: [], campaignSequenceContext: null,
  }
  resolvePath.mockReset().mockResolvedValue('neon')
  fetchSystem.mockReset().mockResolvedValue(system())
  fetchPerformance.mockReset().mockResolvedValue(performance())
  fetchCampaigns.mockReset().mockResolvedValue(accountCampaigns())
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('Overview narrow reads and loading orchestration', () => {
  it('starts System and Performance first, then starts Campaigns after the first settles', async () => {
    const first = deferred<OverviewSystemTotals>()
    const second = deferred<OverviewPerformance>()
    fetchSystem.mockReturnValueOnce(first.promise)
    fetchPerformance.mockReturnValueOnce(second.promise)
    renderOverview()
    await waitFor(() => {
      expect(fetchSystem).toHaveBeenCalledTimes(1)
      expect(fetchPerformance).toHaveBeenCalledTimes(1)
    })
    expect(fetchCampaigns).not.toHaveBeenCalled()
    first.resolve(system())
    await waitFor(() => expect(fetchCampaigns).toHaveBeenCalledTimes(1))
    expect(fetchSystem.mock.calls[0][0]).toMatchObject({ from: null, to: null })
    expect(fetchPerformance.mock.calls[0][0]).toMatchObject({ from: '2026-08-31', to: '2026-09-06' })
    second.resolve(performance())
    await screen.findByRole('heading', { name: 'Campaign comparison' })
  })

  it('makes exactly three narrow reads and renders the agreed cohort formulas', async () => {
    renderOverview()
    expect(await screen.findByText('100.0% of invited')).toBeTruthy()
    expect(screen.getByText('40.0% of invited')).toBeTruthy()
    expect(screen.getByText('75.0% of connected')).toBeTruthy()
    expect(screen.getByText('25.0% of connected')).toBeTruthy()
    expect(await screen.findByText((_, element) => element?.textContent === 'Acceptance 40.0%')).toBeTruthy()
    expect(await screen.findByText((_, element) => element?.textContent === 'Reply rate 25.0%')).toBeTruthy()
    expect(fetchSystem).toHaveBeenCalledTimes(1)
    expect(fetchPerformance).toHaveBeenCalledTimes(1)
    expect(fetchCampaigns).toHaveBeenCalledTimes(1)
  })

  it('renders safe 7-day comparison labels, including previous zero', async () => {
    renderOverview()
    expect(await screen.findByText('+100.0% vs previous 7 days')).toBeTruthy()
    expect(screen.getByText('+25.0% vs previous 7 days')).toBeTruthy()
    expect(screen.getByText('New vs previous 7 days')).toBeTruthy()
  })

  it('keeps account identities and healthy sync ages compact', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Campaign comparison' })
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0)
    expect(screen.queryByText('Notebook one')).toBeNull()
    expect(screen.getByText('2h')).toBeTruthy()
    expect(screen.queryByText(/2h ·/)).toBeNull()
  })

  it('keeps section failures independent and retries only the failed operation', async () => {
    fetchPerformance.mockRejectedValueOnce(new Error('performance down'))
    renderOverview()
    expect(await screen.findByText('Performance analytics could not load.')).toBeTruthy()
    expect(screen.getByText('100.0% of invited')).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'Campaign comparison' })).toBeTruthy()
    const before = fetchPerformance.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(fetchPerformance).toHaveBeenCalledTimes(before + 1))
    expect(fetchSystem).toHaveBeenCalledTimes(1)
    expect(fetchCampaigns).toHaveBeenCalledTimes(1)
  })

  it('reads Performance KPIs from overview.performance, never from the Account analytics range', async () => {
    // Account analytics has its own range. If Performance borrowed its totals,
    // the card would show one range's count above another range's comparison.
    fetchPerformance.mockResolvedValue(performance({
      accounts: [{
        instance_id: 'one',
        current: { invited: 20, connected: 41, replied: 11 },
        previous: { invited: 10, connected: 32, replied: 0 },
        cohort: { leads: 100, invited: 100, connected: 40, messaged: 30, replied: 10 },
        previousCohort: null,
        lifetime: { leads: 200, invited: 200, connected: 100, messaged: 80, replied: 25 },
      }],
    }))
    fetchCampaigns.mockResolvedValue({
      accounts: [{
        instance_id: 'one',
        totals: totals({ invited: 777, connected: 888, replied: 999 }),
        previous: null,
        lifetime: totals({ invited: 777, connected: 888, replied: 999 }),
        cohort: { leads: 777, invited: 777, connected: 888, messaged: 0, replied: 999 },
        previousCohort: null,
      }],
      campaigns: [campaign()] as never,
    })
    renderOverview()
    await screen.findByRole('heading', { name: 'Campaign comparison' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Performance account' }), { target: { value: 'one' } })
    const panel = screen.getByRole('region', { name: 'Performance' })
    expect(within(panel).getByText('20')).toBeTruthy()
    expect(within(panel).getByText('41')).toBeTruthy()
    expect(within(panel).getByText('11')).toBeTruthy()
    expect(within(panel).queryByText('777')).toBeNull()
    expect(within(panel).queryByText('888')).toBeNull()
    expect(within(panel).getByText('+100.0% vs previous 7 days')).toBeTruthy()
    // The account totals block keeps the Account analytics range.
    expect(screen.getByText('777')).toBeTruthy()
  })

  it('refetches only the section whose range changed', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Campaign comparison' })
    expect(fetchCampaigns).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'System totals date range' }))
    fireEvent.click(screen.getByRole('button', { name: 'Past 30 days' }))
    await waitFor(() => expect(fetchSystem).toHaveBeenCalledTimes(2))
    expect(fetchPerformance).toHaveBeenCalledTimes(1)
    expect(fetchCampaigns).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Performance date range' }))
    fireEvent.click(screen.getByRole('button', { name: 'Past 30 days' }))
    await waitFor(() => expect(fetchPerformance).toHaveBeenCalledTimes(2))
    expect(fetchSystem).toHaveBeenCalledTimes(2)
    expect(fetchCampaigns).toHaveBeenCalledTimes(1)
  })

  it('keeps Performance readable when the Account analytics read fails', async () => {
    fetchCampaigns.mockRejectedValue(new Error('campaigns down'))
    renderOverview()
    expect(await screen.findByText('Account analytics could not load.')).toBeTruthy()
    const panel = screen.getByRole('region', { name: 'Performance' })
    expect(within(panel).getByText('+25.0% vs previous 7 days')).toBeTruthy()
    expect(within(panel).queryByText(/Performance data unavailable/)).toBeNull()
    expect(screen.getByText('100.0% of invited')).toBeTruthy()
  })

  it('cancels obsolete range requests and does not render stale responses', async () => {
    const first = deferred<OverviewPerformance>()
    const second = deferred<OverviewPerformance>()
    fetchPerformance.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    renderOverview()
    await waitFor(() => expect(fetchPerformance).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Performance date range' }))
    fireEvent.click(screen.getByRole('button', { name: 'Past 30 days' }))
    await waitFor(() => expect(fetchPerformance).toHaveBeenCalledTimes(2))
    expect(fetchPerformance.mock.calls[0][2]).toBeInstanceOf(AbortSignal)
    expect(fetchPerformance.mock.calls[0][2].aborted).toBe(true)
    first.resolve(performance({ current: { invited: 999, connected: 0, replied: 0 } }))
    second.resolve(performance({ current: { invited: 30, connected: 2, replied: 1 } }))
    await waitFor(() => expect(screen.getByText('30')).toBeTruthy())
    expect(screen.queryByText('999')).toBeNull()
  })
})

describe('Campaign comparison client-only controls', () => {
  it('shows all accounts, filters archived rows, sorts, paginates, removes and restores without reads', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => campaign(index + 1, { invites_sent: 25 - index, campaign_name: index === 24 ? 'A very long campaign name that remains available in the cell title' : `Campaign ${index + 1}` }))
    rows[24] = campaign(25, { is_archived: true, invites_sent: 1, campaign_name: 'A very long campaign name that remains available in the cell title' })
    fetchCampaigns.mockResolvedValue(accountCampaigns(rows))
    renderOverview()
    await screen.findByRole('heading', { name: 'Campaign comparison' })
    expect(screen.getByText('Page 1 of 2')).toBeTruthy()
    expect(screen.getByText('Campaign 1')).toBeTruthy()
    expect(screen.queryByText('A very long campaign name that remains available in the cell title')).toBeNull()
    const campaignTable = screen.getByRole('region', { name: 'Campaign comparison table' })
    const header = within(campaignTable).getByRole('columnheader', { name: /Invited/ })
    expect(header.getAttribute('aria-sort')).toBe('descending')
    expect(within(campaignTable).getByRole('columnheader', { name: 'Account' }).hasAttribute('aria-sort')).toBe(false)
    const before = [fetchSystem.mock.calls.length, fetchPerformance.mock.calls.length, fetchCampaigns.mock.calls.length]
    fireEvent.click(screen.getByRole('button', { name: 'Next campaigns' }))
    expect(screen.getByText('Page 2 of 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Campaign 24' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected (1)' }))
    expect(screen.queryByText('Campaign 24')).toBeNull()
    expect(JSON.parse(localStorage.getItem('overview.hiddenCampaignIds.v1') ?? '[]')).toContain('one:24')
    expect(fetchSystem).toHaveBeenCalledTimes(before[0])
    expect(fetchPerformance).toHaveBeenCalledTimes(before[1])
    expect(fetchCampaigns).toHaveBeenCalledTimes(before[2])
    fireEvent.click(screen.getByRole('button', { name: 'Show removed (1)' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Campaign 24' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected (1)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show active' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next campaigns' }))
    expect(screen.getByText('Campaign 24')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Show archived'))
    fireEvent.click(screen.getByRole('button', { name: 'Next campaigns' }))
    expect(screen.getByText('A very long campaign name that remains available in the cell title')).toBeTruthy()
  })

  it('shows a distinct hidden empty state and account filtering is client-only', async () => {
    fetchCampaigns.mockResolvedValue(accountCampaigns([campaign(1), campaign(2)]))
    renderOverview()
    await screen.findByText('Campaign 2')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all campaigns on this page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected (2)' }))
    expect(screen.getByText('All campaigns are removed from comparison.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show removed (2)' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all campaigns on this page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected (2)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show active' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Performance account' }), { target: { value: 'one' } })
    expect(screen.getByText('Campaign 1')).toBeTruthy()
    expect(fetchSystem).toHaveBeenCalledTimes(1)
    expect(fetchPerformance).toHaveBeenCalledTimes(1)
    expect(fetchCampaigns).toHaveBeenCalledTimes(1)
  })
})

describe('Overview section chrome (Phase 9)', () => {
  it('replaces only the section whose range changed, never showing its old numbers under the new range', async () => {
    renderOverview()
    await screen.findByRole('heading', { name: 'Campaign comparison' })
    const next = deferred<OverviewPerformance>()
    fetchPerformance.mockReturnValueOnce(next.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Performance date range' }))
    fireEvent.click(screen.getByRole('button', { name: 'Past 30 days' }))
    const panel = screen.getByRole('region', { name: 'Performance' })
    await waitFor(() => expect(panel.getAttribute('aria-busy')).toBe('true'))
    expect(within(panel).getByRole('status', { name: 'Loading performance analytics' })).toBeTruthy()
    expect(within(panel).queryByText('+25.0% vs previous 7 days')).toBeNull()
    // Heading and controls stay put; the other two sections are untouched.
    expect(within(panel).getByRole('combobox', { name: 'Performance account' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'System totals' }).getAttribute('aria-busy')).toBe('false')
    expect(screen.getByRole('region', { name: 'Account analytics' }).getAttribute('aria-busy')).toBe('false')
    expect(screen.getByText('100.0% of invited')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'System totals date range' }).textContent).toContain('All time')
    expect(screen.getByRole('button', { name: 'Account analytics date range' }).textContent).toContain('Lifetime')
    next.resolve(performance({ current: { invited: 31, connected: 2, replied: 1 } }))
    await waitFor(() => expect(panel.getAttribute('aria-busy')).toBe('false'))
    expect(within(panel).getByText('31')).toBeTruthy()
  })

  it('says Updating… over the current answer when the same range is read again', async () => {
    // Range A loads, range B fails, and returning to A re-reads A while A's
    // answer — still the right scope — stays on screen.
    renderOverview()
    await screen.findByRole('heading', { name: 'Campaign comparison' })
    fetchPerformance.mockRejectedValueOnce(new Error('performance down'))
    fireEvent.click(screen.getByRole('button', { name: 'Performance date range' }))
    fireEvent.click(screen.getByRole('button', { name: 'Past 30 days' }))
    expect(await screen.findByText('Performance analytics could not load.')).toBeTruthy()
    const again = deferred<OverviewPerformance>()
    fetchPerformance.mockReturnValueOnce(again.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Performance date range' }))
    fireEvent.click(screen.getByRole('button', { name: 'Past 7 days' }))
    const panel = screen.getByRole('region', { name: 'Performance' })
    await waitFor(() => expect(within(panel).getByText('Updating…')).toBeTruthy())
    expect(panel.getAttribute('aria-busy')).toBe('true')
    expect(within(panel).getByText('+25.0% vs previous 7 days')).toBeTruthy()
    again.resolve(performance())
    await waitFor(() => expect(within(panel).queryByText('Updating…')).toBeNull())
  })

  it('opens a campaign through a real link, with no focusable pseudo-button rows', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/campaign/:id" element={<p>Campaign page</p>} />
        </Routes>
      </MemoryRouter>,
    )
    const table = await screen.findByRole('table', { name: 'Campaign comparison' })
    expect(table.querySelector('tr[tabindex], tr[role="button"]')).toBeNull()
    const link = within(table).getByRole('link', { name: 'Campaign 1' })
    expect(link.getAttribute('href')).toBe('/campaign/one%3A1')
    // Selecting a row never navigates.
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Campaign 1' }))
    expect(screen.queryByText('Campaign page')).toBeNull()
    fireEvent.click(link)
    expect(await screen.findByText('Campaign page')).toBeTruthy()
  })

  it('sorts the account table from a column-header button', async () => {
    renderOverview()
    const table = await screen.findByRole('table', { name: 'Account analytics' })
    const invited = within(table).getByRole('columnheader', { name: 'Invited' })
    expect(invited.getAttribute('aria-sort')).toBe('descending')
    fireEvent.click(within(invited).getByRole('button', { name: 'Invited' }))
    expect(invited.getAttribute('aria-sort')).toBe('ascending')
    expect(within(table).getByRole('columnheader', { name: 'Account' }).hasAttribute('aria-sort')).toBe(false)
  })
})
