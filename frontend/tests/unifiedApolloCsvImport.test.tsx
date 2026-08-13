/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

describe('Unified Apollo CSV import page', () => {
  it('processes Companies first and passes their exact Airtable ID to every Contact', async () => {
    const { container } = render(<UnifiedApolloCsvImport />)
    const addedBy = await screen.findByLabelText(/Added by/)
    fireEvent.change(addedBy, { target: { value: 'Ada Operator' } })

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File([csv], 'apollo-people.csv', { type: 'text/csv' })] },
    })

    expect(await screen.findByText(/2 Contacts · 1 unique Companies/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Preview Companies' }))
    expect(await screen.findByRole('button', { name: 'Process Companies' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Process Companies' }))

    expect(await screen.findByRole('heading', { name: '4. Review Contacts' })).toBeTruthy()
    expect(api.previewContacts).toHaveBeenCalledTimes(1)
    const previewRows = api.previewContacts.mock.calls[0][0]
    expect(previewRows).toHaveLength(2)
    expect(previewRows.every((row: { companyId?: string }) => row.companyId === company.id)).toBe(true)
    expect(api.previewContacts.mock.calls[0][1]).toEqual({ forceCompanies: true })

    fireEvent.click(screen.getByRole('button', { name: 'Import Contacts' }))
    expect(await screen.findByRole('heading', { name: 'Import results' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download report' })).toBeTruthy()
    await waitFor(() => expect(api.commitContacts).toHaveBeenCalledTimes(1))
  })

  it('refreshes Airtable and adopts a Company after an uncertain first write', async () => {
    api.previewCompanies
      .mockResolvedValueOnce({
        results: [{ rowNumber: 2, status: 'ready', canCreate: true }],
        counts: { ready: 1 },
      })
      .mockResolvedValueOnce({
        results: [{
          rowNumber: 2,
          status: 'duplicate',
          company,
          matchMethod: 'linkedin',
          reason: 'Company already exists in Airtable',
        }],
        counts: { duplicate: 1 },
      })
    api.commitCompanies.mockResolvedValueOnce({
      results: [{ rowNumber: 2, status: 'failed', error: 'Network outcome unknown' }],
      counts: { created: 0, duplicate: 0, failed: 1 },
    })

    const { container } = render(<UnifiedApolloCsvImport />)
    fireEvent.change(await screen.findByLabelText(/Added by/), {
      target: { value: 'Ada Operator' },
    })
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File([csv], 'apollo-people.csv', { type: 'text/csv' })] },
    })
    await screen.findByText(/2 Contacts · 1 unique Companies/)
    fireEvent.click(screen.getByRole('button', { name: 'Preview Companies' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Process Companies' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import Contacts' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Retry import' }))
    expect(await screen.findByText(/Company already exists in Airtable/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Process Companies' }))

    await screen.findByRole('heading', { name: '4. Review Contacts' })
    expect(api.commitCompanies).toHaveBeenCalledTimes(1)
    expect(api.previewContacts).toHaveBeenCalledTimes(1)
    const adoptedRows = api.previewContacts.mock.calls[0][0]
    expect(adoptedRows.every((row: { companyId?: string }) => row.companyId === company.id)).toBe(true)
  })
})
