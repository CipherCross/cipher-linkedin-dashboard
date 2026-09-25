/** @vitest-environment jsdom */
/*
 * CSV Import presentation contract: the states around the flows that
 * csvImportCompanies.test.tsx and csvImportLeads.test.tsx walk. Every read and
 * write is mocked.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CsvImport } from '../src/pages/CsvImport'
import { companiesCsv, companyFixture, leadsCsv, personFixture } from './fixtures/csvExports'

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

const COMPANY = { id: 'recC00000000000001', name: 'Northwind Health', website: 'northwind.example', linkedin: '', approveStatus: 'Approved' }

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
  api.fetchCompanyImportMetadata.mockResolvedValue({ target: 'db', addedBy: ['David Gamanuk'], limits: { maxRows: 500, maxFileBytes: 5_000_000 } })
  api.fetchContactImportMetadata.mockResolvedValue({ target: 'contacts', addedBy: ['David Hamaniuk'], limits: { maxRows: 500, maxFileBytes: 5_000_000 } })
  api.previewCompanies.mockResolvedValue({ results: [{ rowNumber: 2, status: 'ready', domain: 'northwindhealth.example' }], counts: { ready: 1 } })
  api.previewLeads.mockResolvedValue({
    rows: [{ rowNumber: 2, status: 'ready', groupKey: 'domain:northwind.example' }],
    groups: [{
      key: 'domain:northwind.example', companyName: 'Northwind Health', domain: 'northwind.example', linkedin: '',
      rowNumbers: [2], status: 'ambiguous', method: 'domain', candidates: [COMPANY], rejected: [], db: [], reason: '2 Companies records share this domain; choose one',
    }],
    counts: {},
  })
  api.searchAirtableCompanies.mockResolvedValue([COMPANY])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

// A hidden tabpanel has no accessible name, so it is found by its label.
const panelNamed = (name: string) =>
  document.querySelector(`[role="tabpanel"][aria-label="${name}"]`) as HTMLElement

async function choose(panel: HTMLElement, text: string, name: string) {
  await act(async () => {
    fireEvent.change(panel.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File([text], name, { type: 'text/csv' })] },
    })
  })
}

describe('CSV import states', () => {
  it('reports a failed Airtable metadata read, keeps upload disabled, and retries', async () => {
    api.fetchCompanyImportMetadata.mockRejectedValueOnce(new Error('Airtable 503'))
    render(<CsvImport />)
    const panel = panelNamed('Companies → DB')
    const alert = await within(panel).findByRole('alert')
    expect(alert.textContent).toContain('Airtable 503')
    expect((within(panel).getByRole('button', { name: 'Choose CSV' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })) })
    expect(await within(panel).findByLabelText(/Added by/)).toBeTruthy()
    expect(api.fetchCompanyImportMetadata).toHaveBeenCalledTimes(2)
  })

  it('loads each tab’s Added by choices from its own table', async () => {
    render(<CsvImport />)
    const companies = panelNamed('Companies → DB')
    const leads = panelNamed('Leads → Contacts')
    await within(companies).findByLabelText(/Added by/)
    expect(within(companies).getByRole('option', { name: 'David Gamanuk' })).toBeTruthy()
    expect(within(companies).queryByRole('option', { name: 'David Hamaniuk' })).toBeNull()
    expect(within(leads).getByRole('option', { name: 'David Hamaniuk', hidden: true })).toBeTruthy()
  })

  it('keeps each tab’s loaded file when switching tabs', async () => {
    render(<CsvImport />)
    const companies = panelNamed('Companies → DB')
    await within(companies).findByLabelText(/Added by/)
    await choose(companies, companiesCsv([companyFixture()]), 'companies.csv')
    expect(await within(companies).findByRole('heading', { name: 'Review companies' })).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Leads → Contacts' }))
    expect(companies.hidden).toBe(true)
    expect(screen.getByRole('tab', { name: 'Leads → Contacts' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Companies → DB' }))
    expect(within(companies).getByRole('heading', { name: 'Review companies' })).toBeTruthy()
  })

  it('opens the company picker as a named dialog and closes it on Escape', async () => {
    render(<CsvImport />)
    fireEvent.click(screen.getByRole('tab', { name: 'Leads → Contacts' }))
    const leads = panelNamed('Leads → Contacts')
    await within(leads).findByLabelText(/Added by/)
    await choose(leads, leadsCsv([{ person: personFixture(), company: companyFixture() }]), 'leads.csv')
    fireEvent.click(await within(leads).findByRole('button', { name: 'Choose' }))
    const picker = screen.getByRole('dialog', { name: 'Choose the Airtable company' })
    expect(within(picker).getByLabelText('Search Airtable companies')).toBeTruthy()
    fireEvent.keyDown(picker, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(leads).getByText('Choose company')).toBeTruthy()
  })

  it('keeps the review stage and shows a dismissible error when a DB write fails', async () => {
    api.commitCompanies.mockRejectedValueOnce(new Error('Airtable write timed out'))
    render(<CsvImport />)
    const companies = panelNamed('Companies → DB')
    fireEvent.change(await within(companies).findByLabelText(/Added by/), { target: { value: 'David Gamanuk' } })
    await choose(companies, companiesCsv([companyFixture()]), 'companies.csv')
    await act(async () => {
      fireEvent.click(await within(companies).findByRole('button', { name: 'Add 1 company to DB' }))
    })
    const alert = await within(companies).findByRole('alert')
    expect(alert.textContent).toContain('Airtable write timed out')
    expect(within(companies).getByRole('heading', { name: 'Review companies' })).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(within(companies).queryByRole('alert')).toBeNull()
  })

  it('offers a retry when the preview itself fails, without writing anything', async () => {
    api.previewCompanies.mockRejectedValueOnce(new Error('Airtable 429'))
    render(<CsvImport />)
    const companies = panelNamed('Companies → DB')
    await within(companies).findByLabelText(/Added by/)
    await choose(companies, companiesCsv([companyFixture()]), 'companies.csv')
    expect(await within(companies).findByRole('heading', { name: 'Could not check Airtable' })).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(companies).getByRole('button', { name: 'Try again' }))
    })
    expect(await within(companies).findByRole('heading', { name: 'Review companies' })).toBeTruthy()
    expect(api.commitCompanies).not.toHaveBeenCalled()
  })
})
