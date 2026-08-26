import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCompanyMaps } from '../api/_lib/contactImport'
import { AIRTABLE_IDS, updateRecords } from '../api/_lib/airtable'
import {
  buildBlankCompanyFields,
  classifyCompanyRow,
  existingCompanyIdentityConflict,
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

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
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

describe('Existing Company enrichment', () => {
  it('fills only blank Airtable fields and never rewrites the Company name or populated values', () => {
    const fields = buildBlankCompanyFields(row, 'Ada Operator', {
      [AIRTABLE_IDS.companies.name]: 'Existing name',
      [AIRTABLE_IDS.companies.website]: '',
      [AIRTABLE_IDS.companies.linkedin]: 'https://linkedin.com/company/kept',
      [AIRTABLE_IDS.companies.employees]: 99,
      [AIRTABLE_IDS.companies.approveStatus]: '',
      [AIRTABLE_IDS.companies.addedBy]: 'Existing operator',
    })

    expect(fields).toMatchObject({
      [AIRTABLE_IDS.companies.website]: 'https://analytical.test/',
      [AIRTABLE_IDS.companies.approveStatus]: 'New',
      [AIRTABLE_IDS.companies.mailingName]: 'Analytical Engines',
      [AIRTABLE_IDS.companies.industry]: 'Computer Software',
    })
    expect(fields).not.toHaveProperty(AIRTABLE_IDS.companies.name)
    expect(fields).not.toHaveProperty(AIRTABLE_IDS.companies.linkedin)
    expect(fields).not.toHaveProperty(AIRTABLE_IDS.companies.employees)
    expect(fields).not.toHaveProperty(AIRTABLE_IDS.companies.addedBy)
  })

  it('refuses enrichment when an incoming stable identifier belongs to another Company', () => {
    const selected = company('rec00000000000001', { website: '', linkedin: '' })
    const conflicting = company('rec00000000000002')
    const error = existingCompanyIdentityConflict(
      row,
      selected.id,
      buildCompanyMaps([selected, conflicting]),
    )

    expect(error).toContain('different Airtable Company')
  })

  it('allows enrichment when the selected Company already owns the stable identifiers', () => {
    const selected = company('rec00000000000001')
    expect(
      existingCompanyIdentityConflict(row, selected.id, buildCompanyMaps([selected])),
    ).toBeNull()
  })
})

describe('Airtable Company updates', () => {
  it('uses PATCH with stable record and field IDs', async () => {
    vi.stubEnv('AIRTABLE_TOKEN', 'pat-test-token')
    vi.stubEnv('AIRTABLE_BASE_ID', 'app12345678901234')
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      records: [{ id: 'rec00000000000001', fields: {} }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)

    await updateRecords(
      AIRTABLE_IDS.companiesTable,
      [{
        id: 'rec00000000000001',
        fields: { [AIRTABLE_IDS.companies.website]: 'https://analytical.test/' },
      }],
      { typecast: true },
    )

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toContain(`/v0/app12345678901234/${AIRTABLE_IDS.companiesTable}`)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({
      typecast: true,
      records: [{
        id: 'rec00000000000001',
        fields: { [AIRTABLE_IDS.companies.website]: 'https://analytical.test/' },
      }],
    })
  })
})
