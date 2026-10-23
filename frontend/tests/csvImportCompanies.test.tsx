/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CsvImport } from '../src/pages/CsvImport'
import { companiesCsv, companyFixture, leadsCsv, personFixture, PRIVATE_VALUES } from './fixtures/csvExports'

const api = vi.hoisted(() => ({
  fetchCompanyImportMetadata: vi.fn(),
  previewCompanies: vi.fn(),
  commitCompanies: vi.fn(),
  fetchContactImportMetadata: vi.fn(),
  previewLeads: vi.fn(),
  commitContacts: vi.fn(),
  searchAirtableCompanies: vi.fn(),
}))

vi.mock('../src/lib/importApi', () => api)

const file = (text: string) => new File([text], 'companies.csv', { type: 'text/csv' })

const csv = companiesCsv([
  companyFixture({ 'Company Name': 'Northwind Health', 'Company Domain': 'northwind.example' }),
  companyFixture({ 'Company Name': 'Tailspin Toys', 'Company Domain': 'tailspin.example' }),
  companyFixture({ 'Company Name': 'Contoso', 'Company Domain': 'contoso.example' }),
  companyFixture({ 'Company Name': 'Fabrikam', 'Company Domain': 'fabrikam.example' }),
])

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
  api.fetchCompanyImportMetadata.mockResolvedValue({ target: 'db', addedBy: ['David Gamanuk'], limits: { maxRows: 500, maxFileBytes: 5_000_000 } })
  api.fetchContactImportMetadata.mockResolvedValue({ target: 'contacts', addedBy: ['David Hamaniuk'], limits: { maxRows: 500, maxFileBytes: 5_000_000 } })
  api.previewCompanies.mockResolvedValue({
    results: [
      { rowNumber: 2, status: 'ready', domain: 'northwind.example' },
      { rowNumber: 3, status: 'name_match', domain: 'tailspin.example', reason: 'Same name', matches: [{ table: 'Companies', name: 'Tailspin Toys', website: 'tailspin.test', status: 'Approved' }] },
      { rowNumber: 4, status: 'duplicate', domain: 'contoso.example', reason: 'This domain is already in Airtable', matches: [{ table: 'DB', name: 'Contoso', website: 'https://contoso.example', status: 'Rejected' }] },
      { rowNumber: 5, status: 'ready', domain: 'fabrikam.example' },
    ],
    counts: { ready: 2, name_match: 1, duplicate: 1 },
  })
  api.commitCompanies.mockImplementation(async (_base: string, _addedBy: string, rows: Array<{ rowNumber: number; website: string }>) => ({
    results: rows.map((row) => ({ rowNumber: row.rowNumber, status: 'created', domain: row.website, recordId: `recDB00000000000${row.rowNumber}` })),
    counts: { created: rows.length, duplicate: 0, failed: 0 },
  }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function upload(text = csv) {
  const view = render(<CsvImport />)
  const panel = screen.getByRole('tabpanel', { name: 'Companies → DB' })
  await within(panel).findByLabelText(/Added by/)
  const input = panel.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [file(text)] } })
  })
  return { view, panel }
}

describe('Companies → DB tab', () => {
  it('previews, lets a name match be unticked, and commits only the ticked rows', async () => {
    const { panel } = await upload()
    const table = await within(panel).findByRole('table', { name: 'Companies in this file' })
    expect(within(table).getByText('Name match')).toBeTruthy()
    expect(within(table).getByText(/Found in DB · Rejected/)).toBeTruthy()

    const commit = within(panel).getByRole('button', { name: 'Add 3 companies to DB' }) as HTMLButtonElement
    expect(commit.disabled).toBe(true)
    fireEvent.change(within(panel).getByLabelText(/Added by/), { target: { value: 'David Gamanuk' } })
    expect(commit.disabled).toBe(false)

    fireEvent.click(within(table).getByLabelText('Include Tailspin Toys'))
    const button = within(panel).getByRole('button', { name: 'Add 2 companies to DB' })
    await act(async () => {
      fireEvent.click(button)
    })

    expect(api.commitCompanies).toHaveBeenCalledTimes(1)
    const [base, addedBy, rows] = api.commitCompanies.mock.calls[0]
    expect(base).toBe('web2mob')
    expect(addedBy).toBe('David Gamanuk')
    expect(rows.map((row: { rowNumber: number }) => row.rowNumber)).toEqual([2, 5])

    expect(await within(panel).findByRole('heading', { name: 'Import results' })).toBeTruthy()
    const duplicates = within(panel).getByRole('table', { name: 'Companies skipped as duplicates' })
    expect(within(duplicates).getByText('Contoso')).toBeTruthy()
    expect(within(duplicates).getByText(/DB · Rejected/)).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Download report' })).toBeTruthy()
  })

  it('sends only allowlisted columns to the server', async () => {
    await upload()
    await waitFor(() => expect(api.previewCompanies).toHaveBeenCalled())
    const payload = JSON.stringify(api.previewCompanies.mock.calls[0][1])
    for (const value of PRIVATE_VALUES) expect(payload).not.toContain(value)
  })

  it('rejects a leads file with a pointer to the other tab and sends nothing', async () => {
    const { panel } = await upload(leadsCsv([{ person: personFixture(), company: companyFixture() }]))
    const alert = await within(panel).findByRole('alert')
    expect(alert.textContent).toContain('Leads → Contacts tab')
    expect(api.previewCompanies).not.toHaveBeenCalled()
  })

  it('Re-check after an import runs the preview again on the same file', async () => {
    const { panel } = await upload()
    fireEvent.change(within(panel).getByLabelText(/Added by/), { target: { value: 'David Gamanuk' } })
    await act(async () => {
      fireEvent.click(await within(panel).findByRole('button', { name: 'Add 3 companies to DB' }))
    })
    await within(panel).findByRole('heading', { name: 'Import results' })
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Re-check' }))
    })
    expect(api.previewCompanies).toHaveBeenCalledTimes(2)
    expect(api.previewCompanies.mock.calls[1][1]).toEqual(api.previewCompanies.mock.calls[0][1])
    expect(await within(panel).findByRole('heading', { name: 'Review companies' })).toBeTruthy()
  })
})

describe('Airtable base switch', () => {
  let store: Map<string, string>

  beforeEach(() => {
    // Node's own localStorage shadows jsdom's and has no working store.
    store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    })
  })

  it('runs the Fintech (Arabic) base on its own, keeping the Web 2 Mob file loaded', async () => {
    const { panel: web2mob } = await upload()
    await within(web2mob).findByRole('table', { name: 'Companies in this file' })
    expect(api.fetchCompanyImportMetadata).toHaveBeenCalledWith('web2mob')
    expect(api.previewCompanies.mock.calls[0][0]).toBe('web2mob')

    fireEvent.click(screen.getByRole('radio', { name: 'Fintech (Arabic)' }))
    expect(store.get('csv-import-base')).toBe('fintech_arabic')
    const fintech = screen.getByRole('tabpanel', { name: 'Companies → DB' })
    expect(fintech).not.toBe(web2mob)
    await within(fintech).findByLabelText(/Added by/)
    expect(api.fetchCompanyImportMetadata).toHaveBeenCalledWith('fintech_arabic')
    expect(api.fetchContactImportMetadata).toHaveBeenCalledWith('fintech_arabic')
    expect(within(fintech).getByText(/Choices come from the Fintech \(Arabic\) DB table/)).toBeTruthy()

    const input = fintech.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [file(csv)] } })
    })
    await within(fintech).findByRole('table', { name: 'Companies in this file' })
    expect(api.previewCompanies.mock.calls[1][0]).toBe('fintech_arabic')

    fireEvent.change(within(fintech).getByLabelText(/Added by/), { target: { value: 'David Gamanuk' } })
    await act(async () => {
      fireEvent.click(within(fintech).getByRole('button', { name: 'Add 3 companies to DB' }))
    })
    expect(api.commitCompanies.mock.calls[0][0]).toBe('fintech_arabic')

    fireEvent.click(screen.getByRole('radio', { name: 'Web 2 Mob' }))
    expect(screen.getByRole('tabpanel', { name: 'Companies → DB' })).toBe(web2mob)
    expect(within(web2mob).getByRole('heading', { name: 'Review companies' })).toBeTruthy()
  })

  it('opens on the base picked last time', async () => {
    store.set('csv-import-base', 'fintech_arabic')
    render(<CsvImport />)
    expect(screen.getByRole('radio', { name: 'Fintech (Arabic)' }).getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect(api.fetchCompanyImportMetadata).toHaveBeenCalledWith('fintech_arabic'))
    expect(api.fetchCompanyImportMetadata).not.toHaveBeenCalledWith('web2mob')
  })
})
