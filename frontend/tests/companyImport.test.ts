import { describe, expect, it } from 'vitest'
import { buildCompanyMaps } from '../api/_lib/contactImport'
import {
  classifyCompanyRow,
} from '../api/_lib/companyImport'
import type {
  CompanyImportRow,
  CompanyRecord,
} from '../api/_lib/companyImport'

const row: CompanyImportRow = {
  rowNumber: 2,
  companyName: 'Analytical Engines',
  mailingName: 'Analytical Engines',
  employees: '35',
  industry: 'Computer Software',
  website: 'https://analytical.test',
  linkedin: 'https://www.linkedin.com/company/analytical-engines/',
  country: 'United Kingdom',
  keywords: 'analysis, engines',
  description: 'A computing company.',
  foundedYear: '1843',
}

const company = (
  id: string,
  overrides: Partial<CompanyRecord> = {},
): CompanyRecord => ({
  id,
  name: 'Analytical Engines',
  website: 'https://analytical.test',
  linkedin: 'https://www.linkedin.com/company/analytical-engines/',
  ...overrides,
})

describe('Company CSV duplicate classification', () => {
  it('marks one stable LinkedIn/domain match as an existing duplicate', () => {
    const result = classifyCompanyRow(
      row,
      buildCompanyMaps([company('rec00000000000001')]),
    )
    expect(result.status).toBe('duplicate')
    expect(result.company?.id).toBe('rec00000000000001')
  })

  it('allows a new Company when no Airtable identity matches', () => {
    const result = classifyCompanyRow(row, buildCompanyMaps([]))
    expect(result.status).toBe('ready')
    expect(result.canCreate).toBe(true)
  })

  it('requires a decision for a name-only match and permits explicit creation', () => {
    const result = classifyCompanyRow(
      row,
      buildCompanyMaps([
        company('rec00000000000001', {
          website: '',
          linkedin: '',
        }),
      ]),
    )
    expect(result.status).toBe('company_action')
    expect(result.reason).toBe('name_match')
    expect(result.canCreate).toBe(true)
  })

  it('blocks creation when LinkedIn and domain identify different Companies', () => {
    const result = classifyCompanyRow(
      row,
      buildCompanyMaps([
        company('rec00000000000001', { website: 'https://other.test' }),
        company('rec00000000000002', {
          name: 'Different',
          linkedin: 'https://linkedin.com/company/different',
        }),
      ]),
    )
    expect(result.status).toBe('company_action')
    expect(result.reason).toBe('conflict')
    expect(result.canCreate).toBe(false)
  })

  it('blocks creation when a stable key is duplicated in Airtable', () => {
    const result = classifyCompanyRow(
      row,
      buildCompanyMaps([
        company('rec00000000000001'),
        company('rec00000000000002'),
      ]),
    )
    expect(result.status).toBe('company_action')
    expect(result.reason).toBe('ambiguous')
    expect(result.canCreate).toBe(false)
  })
})
