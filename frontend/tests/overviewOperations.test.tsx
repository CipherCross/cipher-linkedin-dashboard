// @vitest-environment jsdom
import { render, screen, waitFor, cleanup, within, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Overview } from '../src/pages/Overview'
import type { DashboardData, OverviewSummary } from '../src/lib/types'
const fetchSummary = vi.fn()
const resolvePath = vi.fn()
let data: DashboardData
vi.mock('../src/lib/DataContext', () => ({ useData: () => ({ data, phase: 'full' }) }))
vi.mock('../src/lib/dashboardReads', () => ({
  resolveReadPath: () => resolvePath(),
  fetchNeonOverviewSummary: (...args: unknown[]) => fetchSummary(...args),
}))
const campaign = (id: string, invites: number, acceptance: number | null, reply: number | null) => ({
  campaign_id: id, campaign_name: 'Outreach', instance_id: id.split(':')[0],
  invites_sent: invites, lifetime_acceptance_rate: acceptance, lifetime_reply_rate: reply,
})
const summary = {
  totals: { invites: 20, accepted: 10, replies: 3 },
  prevTotals: { invites: 0, accepted: 12, replies: 3 },
  campaigns: [campaign('a:1', 5, 50, 25), campaign('b:1', 15, null, 0)],
} as OverviewSummary
const paint = () => render(<MemoryRouter><Overview /></MemoryRouter>)
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
  data = { instances: [
    { id: 'a', account_name: 'Alice', last_sync_at: '2026-09-06T11:00:00Z' },
    { id: 'b', account_name: 'Bob', last_sync_at: '2026-09-06T11:00:00Z' },
  ], campaigns: [], leads: [] } as unknown as DashboardData
  resolvePath.mockReset().mockResolvedValue('neon')
  fetchSummary.mockReset().mockResolvedValue(summary)
})
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('weekly Overview', () => {
  it('requests seven UTC days and shows exact non-overlapping comparison dates and count deltas', async () => {
    paint()
    await screen.findByText('Campaign performance')
    expect(fetchSummary).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-08-31', to: '2026-09-06' }))
    expect(screen.getByText(/2026-08-31 – 2026-09-06 vs 2026-08-24 – 2026-08-30/)).toBeTruthy()
    expect(screen.getByText('+20 vs previous 7 days')).toBeTruthy()
    expect(screen.getByText('-2 vs previous 7 days')).toBeTruthy()
    expect(screen.getByText('0 vs previous 7 days')).toBeTruthy()
    const sections = document.querySelectorAll('section')
    expect(sections).toHaveLength(2)
    expect(sections[0].textContent).toContain('Invites sent')
    expect(sections[1].textContent).toContain('Campaign performance')
  })
  it('sorts campaign/account rows by weekly invites and keeps lifetime rates separate', async () => {
    paint()
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0].textContent).toContain('Bob')
    expect(rows[0].textContent).toContain('—')
    expect(rows[0].textContent).toContain('0.0%')
    expect(rows[1].textContent).toContain('Alice')
    expect(rows[1].textContent).toContain('50.0%')
    expect(rows[1].textContent).toContain('25.0%')
    expect(within(rows[1]).getByRole('link').getAttribute('href')).toBe('/campaign/a%3A1')
  })
  it('offers retry on failure without displaying stale metrics as current', async () => {
    fetchSummary.mockRejectedValueOnce(new Error('Unavailable'))
    paint()
    await screen.findByRole('alert')
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('table')
  })
  it('shows a genuine empty campaign state', async () => {
    fetchSummary.mockResolvedValue({ ...summary, campaigns: [] })
    paint()
    expect(await screen.findByText(/No campaigns yet/)).toBeTruthy()
  })
  it('refreshes the date when midnight passes', async () => {
    paint()
    await screen.findByRole('table')
    vi.setSystemTime(new Date('2026-09-07T00:00:00Z'))
    await vi.advanceTimersByTimeAsync(60_000)
    await waitFor(() => expect(fetchSummary).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2026-09-01', to: '2026-09-07' })))
  })
  it('uses lifetime denominators on the legacy path even for delayed outcomes', async () => {
    resolvePath.mockResolvedValue('supabase')
    data = { ...data, campaigns: [{ ...campaign('a:1', 0, null, null), campaign_name: 'Legacy' }], leads: [
      { campaign_id: 'a:1', instance_id: 'a', invited_at: '2026-08-01', connected_at: '2026-09-01', replied_at: '2026-09-02' },
      { campaign_id: 'a:1', instance_id: 'a', invited_at: '2026-09-02', connected_at: null, replied_at: null },
    ] } as unknown as DashboardData
    paint()
    const row = (await screen.findByRole('table')).querySelector('tbody tr')!
    expect(row.textContent).toContain('50.0%')
    expect(row.textContent).toContain('100.0%')
    expect(row.lastChild?.textContent).toBe('1')
    expect(fetchSummary).not.toHaveBeenCalled()
  })
})
