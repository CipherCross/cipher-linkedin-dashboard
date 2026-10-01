/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

const northwind = companyFixture({ 'Company Name': 'Northwind Health', 'Company Domain': 'northwind.example' })
const tailspin = companyFixture({ 'Company Name': 'Tailspin Toys', 'Company Domain': 'tailspin.example' })
const contoso = companyFixture({ 'Company Name': 'Contoso', 'Company Domain': 'contoso.example' })
const fabrikam = companyFixture({ 'Company Name': 'Fabrikam', 'Company Domain': 'fabrikam.example' })

const csv = leadsCsv([
  { person: personFixture({ 'Linkedin URL Public': 'https://linkedin.com/in/lead-2' }), company: northwind },
  { person: personFixture({ 'Linkedin URL Public': 'https://linkedin.com/in/lead-3' }), company: northwind },
  { person: personFixture({ 'Linkedin URL Public': 'https://linkedin.com/in/lead-4' }), company: tailspin },
  { person: personFixture({ 'Linkedin URL Public': 'https://linkedin.com/in/lead-5' }), company: contoso },
  { person: personFixture({ 'Linkedin URL Public': 'https://linkedin.com/in/lead-6' }), company: fabrikam },
])

const company = (id: string, name: string, approveStatus = 'Approved') => ({
  id, name, website: `https://${name.toLowerCase().split(' ')[0]}.example`, linkedin: '', approveStatus,
})

const NORTHWIND = company('recC00000000000001', 'Northwind Health')
const OTHER = company('recC00000000000009', 'Tailspin Holdings')

const group = (overrides: Record<string, unknown>) => ({
  candidates: [], rejected: [], db: [], linkedin: '', reason: '', ...overrides,
})

const preview = {
  rows: [
    { rowNumber: 2, status: 'ready', groupKey: 'domain:northwind.example' },
    { rowNumber: 3, status: 'ready', groupKey: 'domain:northwind.example' },
    { rowNumber: 4, status: 'ready', groupKey: 'domain:tailspin.example' },
    { rowNumber: 5, status: 'ready', groupKey: 'domain:contoso.example' },
    { rowNumber: 6, status: 'ready', groupKey: 'domain:fabrikam.example' },
  ],
  groups: [
    group({ key: 'domain:northwind.example', companyName: 'Northwind Health', domain: 'northwind.example', rowNumbers: [2, 3], status: 'suggested', method: 'domain', suggestion: NORTHWIND, candidates: [NORTHWIND] }),
    group({ key: 'domain:tailspin.example', companyName: 'Tailspin Toys', domain: 'tailspin.example', rowNumbers: [4], status: 'not_uploaded', candidates: [OTHER], reason: 'This company is in neither DB nor Companies' }),
    group({ key: 'domain:contoso.example', companyName: 'Contoso', domain: 'contoso.example', rowNumbers: [5], status: 'pending', db: [{ id: 'recDB0000000000001', name: 'Contoso', website: 'contoso.example', status: 'Manual review', addedToCompanies: false }], reason: 'Waiting for approval in DB' }),
    group({ key: 'domain:fabrikam.example', companyName: 'Fabrikam', domain: 'fabrikam.example', rowNumbers: [6], status: 'declined', declinedBy: 'DB', reason: 'This company is Rejected in DB' }),
  ],
  counts: {},
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
  api.fetchCompanyImportMetadata.mockResolvedValue({ target: 'db', addedBy: ['David Gamanuk'], limits: { maxRows: 500, maxFileBytes: 5_000_000 } })
  api.fetchContactImportMetadata.mockResolvedValue({ target: 'contacts', addedBy: ['David Hamaniuk'], limits: { maxRows: 500, maxFileBytes: 5_000_000 } })
  api.previewLeads.mockResolvedValue(preview)
  api.searchAirtableCompanies.mockResolvedValue([OTHER, company('recC00000000000008', 'Tailspin Rejected', 'Rejected')])
  api.commitContacts.mockImplementation(async (_addedBy: string, rows: Array<{ rowNumber: number }>) => ({
    results: rows.map((row) => ({ rowNumber: row.rowNumber, status: 'created', contactId: `recK0000000000000${row.rowNumber}` })),
    counts: { created: rows.length, duplicate: 0, failed: 0 },
  }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function upload(text = csv) {
  render(<CsvImport />)
  fireEvent.click(screen.getByRole('tab', { name: 'Leads → Contacts' }))
  const panel = screen.getByRole('tabpanel', { name: 'Leads → Contacts' })
  await within(panel).findByLabelText(/Added by/)
  const input = panel.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([text], 'leads.csv', { type: 'text/csv' })] } })
  })
  return panel
}

const row = (panel: HTMLElement, key: string) => panel.querySelector(`[data-group="${key}"]`) as HTMLElement

describe('Leads → Contacts tab', () => {
  it('writes nothing until a group is confirmed', async () => {
    const panel = await upload()
    fireEvent.change(within(panel).getByLabelText(/Added by/), { target: { value: 'David Hamaniuk' } })
    expect(within(row(panel, 'domain:northwind.example')).getByText('Suggested')).toBeTruthy()
    const create = within(panel).getByRole('button', { name: 'Create 0 contacts' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
  })

  it('bulk-confirms single domain matches and commits them with the confirmed record ID', async () => {
    const panel = await upload()
    fireEvent.change(within(panel).getByLabelText(/Added by/), { target: { value: 'David Hamaniuk' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm all single domain matches (1)' }))
    expect(within(row(panel, 'domain:northwind.example')).getByText('Confirmed')).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Create 2 contacts' }))
    })
    const [addedBy, rows] = api.commitContacts.mock.calls[0]
    expect(addedBy).toBe('David Hamaniuk')
    expect(rows).toEqual([
      expect.objectContaining({ rowNumber: 2, companyId: NORTHWIND.id, companyWebsite: 'northwind.example' }),
      expect.objectContaining({ rowNumber: 3, companyId: NORTHWIND.id }),
    ])
    for (const value of PRIVATE_VALUES) expect(JSON.stringify(rows)).not.toContain(value)
  })

  it('never offers a way to link a declined group', async () => {
    const panel = await upload()
    const declined = row(panel, 'domain:fabrikam.example')
    expect(within(declined).getByText('Declined')).toBeTruthy()
    expect(within(declined).getByText('DB · Rejected')).toBeTruthy()
    expect(within(declined).queryByRole('button', { name: /Confirm|Choose|Change/ })).toBeNull()
    fireEvent.click(within(declined).getByRole('button', { name: /Show 1 lead of Fabrikam/ }))
    const leads = within(panel).getByRole('list', { name: 'Leads of Fabrikam' })
    expect(within(leads).queryByRole('button', { name: /Use|Choose|Change/ })).toBeNull()
  })

  it('links a not-uploaded lead to the one Companies record its headline names, with Undo', async () => {
    const AIFORIA = company('recC00000000000011', 'Aiforia Technologies')
    api.previewLeads.mockResolvedValue({
      ...preview,
      rows: preview.rows.map((item) => (item.rowNumber === 4 ? { ...item, headlineMatches: [AIFORIA] } : item)),
    })
    const panel = await upload()
    fireEvent.change(within(panel).getByLabelText(/Added by/), { target: { value: 'David Hamaniuk' } })
    const leads = within(panel).getByRole('list', { name: 'Leads of Tailspin Toys' })
    expect(within(leads).getByText('Found in headline', { exact: false })).toBeTruthy()
    expect(within(row(panel, 'domain:tailspin.example')).getByText('Every lead linked on its own')).toBeTruthy()
    expect(within(panel).getByText('linked from headline', { exact: false })).toBeTruthy()

    fireEvent.click(within(leads).getByRole('button', { name: 'Undo' }))
    expect(within(panel).getByRole('button', { name: 'Create 0 contacts' })).toBeTruthy()
    fireEvent.click(within(leads).getByRole('button', { name: 'Use Aiforia Technologies' }))
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Create 1 contact' }))
    })
    expect(api.commitContacts.mock.calls[0][1]).toEqual([
      expect.objectContaining({ rowNumber: 4, companyId: AIFORIA.id, companyWebsite: 'tailspin.example' }),
    ])
  })

  it('asks instead of linking when the headline names several companies, or the company is pending', async () => {
    const AIFORIA = company('recC00000000000011', 'Aiforia Technologies')
    const AXIOS = company('recC00000000000012', 'Axios Care')
    api.previewLeads.mockResolvedValue({
      ...preview,
      rows: preview.rows.map((item) =>
        item.rowNumber === 4 ? { ...item, headlineMatches: [AIFORIA, AXIOS] }
          : item.rowNumber === 5 ? { ...item, headlineMatches: [AXIOS] }
            : item),
    })
    const panel = await upload()
    const tailspin = within(panel).getByRole('list', { name: 'Leads of Tailspin Toys' })
    expect(within(tailspin).getByRole('button', { name: 'Use Aiforia Technologies' })).toBeTruthy()
    expect(within(tailspin).getByRole('button', { name: 'Use Axios Care' })).toBeTruthy()
    const contoso = within(panel).getByRole('list', { name: 'Leads of Contoso' })
    expect(within(contoso).getByRole('button', { name: 'Use Axios Care' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Create 0 contacts' })).toBeTruthy()
  })

  it('links one lead of a group to another company without moving the rest', async () => {
    const panel = await upload()
    fireEvent.change(within(panel).getByLabelText(/Added by/), { target: { value: 'David Hamaniuk' } })
    fireEvent.click(within(row(panel, 'domain:northwind.example')).getByRole('button', { name: /Show 2 leads of Northwind Health/ }))
    const leads = within(panel).getByRole('list', { name: 'Leads of Northwind Health' })
    const third = leads.querySelector('[data-lead="3"]') as HTMLElement
    fireEvent.click(within(third).getByRole('button', { name: 'Choose for this lead' }))
    const dialog = await screen.findByRole('dialog', { name: 'Choose the Airtable company' })
    expect(within(dialog).getByText('Lead:', { exact: false })).toBeTruthy()
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'Tailspin' } })
    fireEvent.click((await within(dialog).findAllByText('Tailspin Holdings', {}, { timeout: 2000 }))[0].closest('button')!)
    expect(within(third).getByText('Chosen for this lead', { exact: false })).toBeTruthy()

    fireEvent.click(within(row(panel, 'domain:northwind.example')).getByRole('button', { name: 'Confirm' }))
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Create 2 contacts' }))
    })
    expect(api.commitContacts.mock.calls[0][1]).toEqual([
      expect.objectContaining({ rowNumber: 2, companyId: NORTHWIND.id }),
      expect.objectContaining({ rowNumber: 3, companyId: OTHER.id }),
    ])
  })

  it('links a not-uploaded group manually and refuses a Rejected pick', async () => {
    const panel = await upload()
    fireEvent.click(within(row(panel, 'domain:tailspin.example')).getByRole('button', { name: 'Choose' }))
    const dialog = await screen.findByRole('dialog', { name: 'Choose the Airtable company' })
    const rejected = (await within(dialog).findByText('Tailspin Rejected')).closest('button') as HTMLButtonElement
    expect(rejected.disabled).toBe(true)
    fireEvent.click(within(dialog).getAllByText('Tailspin Holdings')[0].closest('button')!)
    expect(screen.queryByRole('dialog')).toBeNull()
    const linked = row(panel, 'domain:tailspin.example')
    expect(within(linked).getByText('Confirmed')).toBeTruthy()
    expect(within(linked).getByText(/Chosen manually/)).toBeTruthy()
  })

  it('reports held and declined companies after commit, and Re-check re-runs the preview', async () => {
    const panel = await upload()
    fireEvent.change(within(panel).getByLabelText(/Added by/), { target: { value: 'David Hamaniuk' } })
    fireEvent.click(within(row(panel, 'domain:northwind.example')).getByRole('button', { name: 'Confirm' }))
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Create 2 contacts' }))
    })

    expect(await within(panel).findByRole('heading', { name: 'Import results' })).toBeTruthy()
    const held = within(panel).getByRole('table', { name: 'Companies awaiting approval' })
    expect(within(held).getByText('Contoso')).toBeTruthy()
    expect(within(held).getByText('DB · Manual review')).toBeTruthy()
    expect(within(held).getByText('Tailspin Toys')).toBeTruthy()
    expect(within(panel).getByRole('heading', { name: /2 leads held — 2 companies awaiting approval/ })).toBeTruthy()
    const declined = within(panel).getByRole('table', { name: 'Declined companies' })
    expect(within(declined).getByText('Fabrikam')).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Re-check' }))
    })
    expect(api.previewLeads).toHaveBeenCalledTimes(2)
    expect(api.previewLeads.mock.calls[1][1]).toEqual({ forceCompanies: true })
    expect(await within(panel).findByRole('heading', { name: 'Confirm companies' })).toBeTruthy()
  })

  it('makes the SDR type the title of a lead with several current jobs before anything is created', async () => {
    const multi = leadsCsv([
      { person: personFixture({ 'Linkedin URL Public': 'https://linkedin.com/in/lead-2', 'Current Jobs Number': '3' }), company: northwind },
      { person: personFixture({ 'Linkedin URL Public': 'https://linkedin.com/in/lead-3' }), company: northwind },
    ])
    api.previewLeads.mockResolvedValue({
      rows: [
        { rowNumber: 2, status: 'ready', groupKey: 'domain:northwind.example' },
        { rowNumber: 3, status: 'ready', groupKey: 'domain:northwind.example' },
      ],
      groups: [preview.groups[0]],
      counts: {},
    })
    const panel = await upload(multi)
    fireEvent.change(within(panel).getByLabelText(/Added by/), { target: { value: 'David Hamaniuk' } })
    fireEvent.click(within(row(panel, 'domain:northwind.example')).getByRole('button', { name: 'Confirm' }))

    // Opened without a click because a lead needs a title.
    const leads = within(panel).getByRole('list', { name: 'Leads of Northwind Health' })
    const multiTitle = within(leads.querySelector('[data-lead="2"]') as HTMLElement).getByLabelText(/Title/) as HTMLInputElement
    const singleTitle = within(leads.querySelector('[data-lead="3"]') as HTMLElement).getByLabelText(/Title/) as HTMLInputElement
    expect(multiTitle.value).toBe('')
    expect(multiTitle.required).toBe(true)
    expect(within(leads).getByText(/3 current jobs — enter the title at Northwind Health \(CSV says “Founder & CEO”\)/)).toBeTruthy()
    expect(singleTitle.value).toBe('Founder & CEO')

    const create = within(panel).getByRole('button', { name: 'Create 2 contacts' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    expect(within(panel).getByText(/Enter a title for 1 lead first/)).toBeTruthy()

    fireEvent.change(multiTitle, { target: { value: ' CTO ' } })
    fireEvent.change(singleTitle, { target: { value: 'President' } })
    expect(create.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(create)
    })
    expect(api.commitContacts.mock.calls[0][1]).toEqual([
      expect.objectContaining({ rowNumber: 2, title: 'CTO' }),
      expect.objectContaining({ rowNumber: 3, title: 'President' }),
    ])
  })

  it('rejects a companies file with a pointer to the other tab', async () => {
    const panel = await upload(companiesCsv([northwind]))
    expect((await within(panel).findByRole('alert')).textContent).toContain('Companies → DB tab')
    expect(api.previewLeads).not.toHaveBeenCalled()
  })
})
