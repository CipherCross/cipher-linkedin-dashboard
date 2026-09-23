/** @vitest-environment jsdom */
/*
 * CSV Import presentation contract (Phase 5): the states around the flows that
 * unifiedApolloCsvImport.test.tsx already walks. Every write is mocked.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnifiedApolloCsvImport } from '../src/pages/UnifiedApolloCsvImport'

const api = vi.hoisted(() => ({
  fetchImportMetadata: vi.fn(),
  fetchCompanyImportMetadata: vi.fn(),
  previewCompanies: vi.fn(),
  commitCompanies: vi.fn(),
  previewContacts: vi.fn(),
  commitContacts: vi.fn(),
  searchAirtableCompanies: vi.fn(),
}))

vi.mock('../src/lib/importApi', () => api)

const metadata = {
  source: 'apollo' as const,
  mappingVersion: 1,
  addedBy: ['Ada Operator'],
  limits: { maxRows: 500, maxFileBytes: 5_000_000 },
}

const company = {
  id: 'rec00000000000001',
  name: 'Analytical Engines',
  website: 'https://analytical.test',
  linkedin: 'https://linkedin.com/company/analytical-engines',
}

const csv = [
  [
    'First Name',
    'Last Name',
    'Title',
    'Company Name',
    'Company Name for Emails',
    '# Employees',
    'Industry',
    'Keywords',
    'Person Linkedin Url',
    'Website',
    'Company Linkedin Url',
    'Company Country',
    'Apollo Account Id',
  ].join(','),
  'Ada,Lovelace,Founder,Analytical Engines,Analytical Engines,35,Software,analysis,https://linkedin.com/in/ada,https://analytical.test,https://linkedin.com/company/analytical-engines,United Kingdom,account-1',
  'Grace,Hopper,CTO,Analytical Engines,Analytical Engines,35,Software,analysis,https://linkedin.com/in/grace,https://analytical.test,https://linkedin.com/company/analytical-engines,United Kingdom,account-1',
].join('\n')

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
  api.fetchImportMetadata.mockResolvedValue(metadata)
  api.fetchCompanyImportMetadata.mockResolvedValue(metadata)
  api.previewCompanies.mockResolvedValue({
    results: [{ rowNumber: 2, status: 'ready', canCreate: true }],
    counts: { ready: 1 },
  })
  api.commitCompanies.mockResolvedValue({
    results: [{ rowNumber: 2, status: 'created', companyId: company.id }],
    counts: { created: 1, duplicate: 0, failed: 0 },
  })
  api.previewContacts.mockImplementation(async (rows: Array<{ rowNumber: number; companyId?: string }>) => ({
    results: rows.map((row) => ({
      rowNumber: row.rowNumber,
      status: 'ready',
      company,
      matchMethod: 'resolved',
    })),
    counts: { ready: rows.length },
  }))
  api.commitContacts.mockImplementation(async (_addedBy: string, rows: Array<{ rowNumber: number }>) => ({
    results: rows.map((row, index) => ({
      rowNumber: row.rowNumber,
      status: 'created',
      contactId: `rec0000000000000${index + 2}`,
    })),
    counts: { created: rows.length, duplicate: 0, failed: 0 },
  }))
  api.searchAirtableCompanies.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})


async function toFileReview() {
  const view = render(<UnifiedApolloCsvImport />)
  fireEvent.change(await screen.findByLabelText(/Added by/), { target: { value: 'Ada Operator' } })
  fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, {
    target: { files: [new File([csv], 'apollo-people.csv', { type: 'text/csv' })] },
  })
  await screen.findByText(/2 Contacts · 1 unique Companies/)
  return view
}

describe('CSV import states', () => {
  it('reports a failed Airtable metadata read and retries it', async () => {
    api.fetchImportMetadata.mockRejectedValueOnce(new Error('Airtable 503'))
    render(<UnifiedApolloCsvImport />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Airtable 503')
    expect((screen.getByRole('button', { name: 'Choose CSV' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })) })
    expect(await screen.findByLabelText(/Added by/)).toBeTruthy()
    expect(api.fetchImportMetadata).toHaveBeenCalledTimes(2)
  })

  it('marks the current step and keeps upload disabled until Added by is chosen', async () => {
    render(<UnifiedApolloCsvImport />)
    await screen.findByLabelText(/Added by/)
    const steps = within(screen.getByRole('list', { name: 'Import progress' })).getAllByRole('listitem')
    expect(steps[0].getAttribute('aria-current')).toBe('step')
    expect(screen.getByText('Select Added by first.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Choose CSV' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens the company picker as a named dialog, closes it on Escape, and records a skip', async () => {
    api.previewCompanies.mockResolvedValueOnce({
      results: [{ rowNumber: 2, status: 'company_action', reason: 'name_match', suggestions: [company], canCreate: true }],
      counts: { company_action: 1 },
    })
    await toFileReview()
    fireEvent.click(screen.getByRole('button', { name: 'Preview Companies' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Choose existing' }))
    const picker = screen.getByRole('dialog', { name: 'Choose the Airtable company' })
    expect(within(picker).getByLabelText('Search Airtable companies')).toBeTruthy()
    fireEvent.keyDown(picker, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByRole('button', { name: 'Process Companies' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Choose existing' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Skip all 2 leads/ }))
    expect(screen.getByText('Skip this group')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Process Companies' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('skips and restores a Contact before import', async () => {
    await toFileReview()
    fireEvent.click(screen.getByRole('button', { name: 'Preview Companies' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Process Companies' }))
    const table = await screen.findByRole('table', { name: 'Contacts to import' })
    const [skip] = within(table).getAllByRole('button', { name: 'Skip' })
    fireEvent.click(skip)
    expect(within(table).getByText('Skipped')).toBeTruthy()
    expect(screen.getByText(/Contacts ready to create/).textContent).toContain('1')
    fireEvent.click(within(table).getByRole('button', { name: 'Restore' }))
    expect(within(table).queryByText('Skipped')).toBeNull()
  })

  it('keeps the stage and shows a dismissible error when a Company write fails', async () => {
    api.commitCompanies.mockRejectedValueOnce(new Error('Airtable write timed out'))
    await toFileReview()
    fireEvent.click(screen.getByRole('button', { name: 'Preview Companies' }))
    const process = await screen.findByRole('button', { name: 'Process Companies' })
    await act(async () => { fireEvent.click(process) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Airtable write timed out')
    expect(screen.getByRole('heading', { name: '3. Resolve Companies' })).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
