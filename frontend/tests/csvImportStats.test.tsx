/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CsvImport } from '../src/pages/CsvImport'
import { DateRangePicker } from '../src/components/DateRangePicker'
import type { TeamStatsBucket, TeamStatsResponse } from '../src/lib/teamStats'

const api = vi.hoisted(() => ({
  fetchCompanyImportMetadata: vi.fn(),
  previewCompanies: vi.fn(),
  commitCompanies: vi.fn(),
  fetchContactImportMetadata: vi.fn(),
  previewLeads: vi.fn(),
  commitContacts: vi.fn(),
  searchAirtableCompanies: vi.fn(),
  fetchImportStats: vi.fn(),
}))

vi.mock('../src/lib/importApi', () => api)

const statuses = [
  { name: 'New', group: 'new' as const },
  { name: 'Approved', group: 'approve' as const },
  { name: 'Rejected', group: 'reject' as const },
  { name: 'Old', group: 'excluded' as const },
]

function configured(base: 'web2mob' | 'fintech_arabic', from: string, to: string, buckets: TeamStatsBucket[]): TeamStatsResponse {
  const table = { people: ['Daria Krut', 'David Gamanuk'], statuses }
  return {
    base, configured: true, from, to, fetchedAt: `${to}T12:00:00.000Z`,
    tables: { db: table, companies: table, contacts: table },
    buckets,
  }
}

const WEB2MOB: TeamStatsBucket[] = [
  { table: 'db', day: '2026-10-06', addedBy: 'Daria Krut', group: 'new', count: 3 },
  { table: 'db', day: '2026-10-07', addedBy: 'Daria Krut', group: 'approve', count: 2 },
  { table: 'db', day: '2026-10-07', addedBy: '', group: 'new', count: 1 },
  { table: 'companies', day: '2026-10-07', addedBy: 'Daria Krut', group: 'approve', count: 2 },
  { table: 'contacts', day: '2026-10-05', addedBy: 'Daria Krut', group: 'approve', count: 4 },
  { table: 'contacts', day: '2026-10-05', addedBy: 'Daria Krut', group: 'reject', count: 1 },
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
  vi.stubGlobal('scrollTo', vi.fn())
  window.localStorage.clear()
  api.fetchCompanyImportMetadata.mockResolvedValue({ target: 'db', addedBy: ['David Gamanuk'], limits: { maxRows: 500, maxFileBytes: 5_000_000 } })
  api.fetchContactImportMetadata.mockResolvedValue({ target: 'contacts', addedBy: ['David Hamaniuk'], limits: { maxRows: 500, maxFileBytes: 5_000_000 } })
  api.fetchImportStats.mockImplementation(async (base: 'web2mob' | 'fintech_arabic', from: string, to: string) =>
    base === 'web2mob'
      ? configured(base, from, to, WEB2MOB)
      : { base, configured: false, from, to })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function openStats() {
  render(<CsvImport />)
  expect(api.fetchImportStats).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Team stats' })) })
  const panel = screen.getByRole('tabpanel', { name: 'Team stats' })
  await within(panel).findByRole('table', { name: /Company additions/ })
  return panel
}

const rowOf = (table: HTMLElement, label: string) =>
  within(table).getAllByRole('row').find((row) => within(row).queryAllByRole('cell')[0]?.textContent === label)!

const cellsOf = (row: HTMLElement) => within(row).getAllByRole('cell').slice(1).map((cell) => cell.textContent)

describe('CSV import Team stats', () => {
  it('loads the picked base for the past 14 UTC days only once the tab opens', async () => {
    const panel = await openStats()
    expect(api.fetchImportStats).toHaveBeenCalledTimes(1)
    expect(api.fetchImportStats).toHaveBeenCalledWith('web2mob', '2026-09-24', '2026-10-07', { force: false })
    expect(within(panel).getByRole('button', { name: 'Team stats period' }).textContent).toContain('Past 14 days')
    expect(within(panel).getAllByRole('table')).toHaveLength(4)
  })

  it('shows every person, with explicit zeros, a Not set row, and All/New/Approve/Reject totals', async () => {
    const panel = await openStats()
    const table = within(panel).getByRole('table', { name: /Company additions/ })
    // 14 day columns, then All / New / Approve / Reject.
    const daria = cellsOf(rowOf(table, 'Daria Krut'))
    expect(daria).toHaveLength(18)
    expect(daria.slice(-6)).toEqual(['3', '2', '5', '3', '2', '0'])
    const david = cellsOf(rowOf(table, 'David Gamanuk'))
    expect(david.every((value) => value === '0')).toBe(true)
    expect(cellsOf(rowOf(table, 'Not set')).slice(-4)).toEqual(['1', '1', '0', '0'])
    expect(within(table).getByRole('rowheader', { name: 'All people' })).toBeTruthy()
  })

  it('shows Approve per day in Lead approvals, and lets the cells switch to Reject', async () => {
    const panel = await openStats()
    const table = within(panel).getByRole('table', { name: /Lead approvals/ })
    // 5 Oct is the 12th day column of 24 Sep – 7 Oct.
    expect(cellsOf(rowOf(table, 'Daria Krut'))[11]).toBe('4')
    const group = within(panel).getByRole('radiogroup', { name: 'Lead approvals: cells show' })
    fireEvent.click(within(group).getByRole('radio', { name: 'Reject' }))
    expect(cellsOf(rowOf(table, 'Daria Krut'))[11]).toBe('1')
  })

  it('sums the KPI tiles from the four blocks', async () => {
    const panel = await openStats()
    expect(within(panel).getByText('Companies added').parentElement?.textContent).toContain('6')
    expect(within(panel).getByText('Leads approved').parentElement?.textContent).toMatch(/^Leads approved4of 5 added/)
  })

  it('says a base is not configured instead of failing', async () => {
    await openStats()
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Fintech (Arabic)' })) })
    expect(await screen.findByText('Fintech (Arabic) is not configured')).toBeTruthy()
    expect(api.fetchImportStats).toHaveBeenLastCalledWith('fintech_arabic', '2026-09-24', '2026-10-07', { force: false })
  })

  it('sums every base for All bases, loading them one after another and naming the base left out', async () => {
    const panel = await openStats()
    api.fetchImportStats.mockClear()
    await act(async () => { fireEvent.click(within(panel).getByRole('radio', { name: 'All bases' })) })
    expect(await within(panel).findByText(/Not included in All bases: Fintech \(Arabic\) \(not configured\)/)).toBeTruthy()
    // Web 2 Mob is already loaded for this period; only Fintech (Arabic) is asked for.
    expect(api.fetchImportStats.mock.calls.map((call) => call[0])).toEqual(['fintech_arabic'])
    const table = within(panel).getByRole('table', { name: /Company additions by person and day · All bases/ })
    expect(cellsOf(rowOf(table, 'Daria Krut')).slice(-4)).toEqual(['5', '3', '2', '0'])
  })

  it('reloads every shown base, bypassing the cache, on Refresh', async () => {
    const panel = await openStats()
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Refresh' })) })
    await waitFor(() => expect(api.fetchImportStats).toHaveBeenLastCalledWith('web2mob', '2026-09-24', '2026-10-07', { force: true }))
  })

  it('shows a failure with a retry', async () => {
    api.fetchImportStats.mockRejectedValueOnce(new Error('DB has more than 5,000 records created in this period. Pick a shorter period.'))
    render(<CsvImport />)
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Team stats' })) })
    expect(await screen.findByText(/DB has more than 5,000 records/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Retry|Try again/ })) })
    expect(await screen.findByRole('table', { name: /Company additions/ })).toBeTruthy()
  })

  it('switches to week columns for a period longer than 31 days', async () => {
    const panel = await openStats()
    fireEvent.click(within(panel).getByRole('button', { name: 'Team stats period' }))
    const dialog = await screen.findByRole('dialog', { name: 'Team stats period calendar' })
    expect(within(dialog).getByText('Custom range: up to 92 days')).toBeTruthy()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Past 30 days' })) })
    const table = await within(panel).findByRole('table', { name: /Company additions by person and day/ })
    expect(cellsOf(rowOf(table, 'Daria Krut'))).toHaveLength(30 + 4)
  })
})

describe('DateRangePicker maxDays', () => {
  it('disables days that would make a custom range longer than the cap', async () => {
    const range = { id: 'custom', label: '', from: '2026-10-10', to: '2026-10-10' }
    render(<DateRangePicker presets={[]} value={range} onChange={vi.fn()} ariaLabel="Capped" maxDays={3} />)
    fireEvent.click(screen.getByRole('button', { name: 'Capped' }))
    const dialog = await screen.findByRole('dialog', { name: 'Capped calendar' })
    // October 2026 is the month on show; outside days belong to its neighbours.
    const day = (n: number) => within(dialog).getAllByRole('button')
      .find((button) => button.textContent === String(n) && !button.closest('[data-outside]'))!
    expect((day(20) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(day(10))
    expect((day(12) as HTMLButtonElement).disabled).toBe(false)
    expect((day(13) as HTMLButtonElement).disabled).toBe(true)
    expect((day(8) as HTMLButtonElement).disabled).toBe(false)
    expect((day(7) as HTMLButtonElement).disabled).toBe(true)
  })
})
