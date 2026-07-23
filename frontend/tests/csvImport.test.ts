import { describe, expect, it } from 'vitest'
import {
  buildCompanyRows,
  buildContactRows,
  companyMappingErrors,
  mappingErrors,
  parseCompanyCsvFile,
  parseCsvFile,
  suggestApolloCompanyMapping,
  suggestApolloMapping,
} from '../src/lib/csvImport'

const APOLLO_HEADERS = [
  'First Name',
  'Last Name',
  'Title',
  'Company Name',
  'Person Linkedin Url',
  'Website',
  'Company Linkedin Url',
]

const APOLLO_COMPANY_HEADERS = [
  'Company Name',
  'Company Name for Emails',
  '# Employees',
  'Industry',
  'Website',
  'Company Linkedin Url',
  'Company Country',
  'Keywords',
  'Apollo Record Id',
  'Short Description',
  'Founded Year',
  'Subsidiary of (Organization ID)',
]

describe('Apollo CSV import parsing', () => {
  it('detects the fixed Apollo mapping case-insensitively', () => {
    const mapping = suggestApolloMapping(APOLLO_HEADERS.map((header) => header.toUpperCase()))
    expect(mapping.personLinkedin).toBe('PERSON LINKEDIN URL')
    expect(mapping.companyLinkedin).toBe('COMPANY LINKEDIN URL')
    expect(mapping.companyName).toBe('COMPANY NAME')
  })

  it('parses quoted cells and builds only the allowlisted contact shape', async () => {
    const csv = [
      APOLLO_HEADERS.join(','),
      [
        'Ada',
        'Lovelace',
        '"Founder, CEO"',
        'Analytical Engines',
        'https://www.linkedin.com/in/ada-lovelace/',
        'https://example.com',
        'https://www.linkedin.com/company/analytical-engines/',
      ].join(','),
    ].join('\r\n')
    const document = await parseCsvFile(new File([csv], 'apollo.csv', { type: 'text/csv' }))
    const [row] = buildContactRows(document, document.mapping)

    expect(row).toEqual({
      rowNumber: 2,
      personLinkedin: 'https://www.linkedin.com/in/ada-lovelace/',
      firstName: 'Ada',
      lastName: 'Lovelace',
      fullName: 'Ada Lovelace',
      title: 'Founder, CEO',
      companyName: 'Analytical Engines',
      companyWebsite: 'https://example.com',
      companyLinkedin: 'https://www.linkedin.com/company/analytical-engines/',
    })
  })

  it('rejects an Ensun company export', async () => {
    const csv = 'Name,URI,LinkedIn\nAcme,https://acme.test,https://linkedin.com/company/acme\n'
    await expect(
      parseCsvFile(new File([csv], 'ensun.csv', { type: 'text/csv' })),
    ).rejects.toThrow('Ensun')
  })

  it('rejects duplicate source mappings', () => {
    const mapping = suggestApolloMapping(APOLLO_HEADERS)
    mapping.title = mapping.firstName
    expect(mappingErrors(mapping).join(' ')).toContain('only be mapped once')
  })
})

describe('Apollo Company CSV import parsing', () => {
  it('detects and builds every compatible Companies field', async () => {
    const csv = [
      APOLLO_COMPANY_HEADERS.join(','),
      [
        'Analytical Engines',
        'Analytical Engines',
        '35',
        'Computer Software',
        'https://analytical.test',
        'http://www.linkedin.com/company/analytical-engines/',
        'United Kingdom',
        `"${'analysis, '.repeat(220)}"`,
        '66aabbccddeeff0011223344',
        '"A company with a detailed, multiline description."',
        '1843',
        '',
      ].join(','),
    ].join('\r\n')
    const document = await parseCompanyCsvFile(
      new File([csv], 'apollo-accounts.csv', { type: 'text/csv' }),
    )
    const [row] = buildCompanyRows(document, document.mapping)

    expect(row.companyName).toBe('Analytical Engines')
    expect(row.mailingName).toBe('Analytical Engines')
    expect(row.employees).toBe('35')
    expect(row.foundedYear).toBe('1843')
    expect(row.keywords.length).toBeGreaterThan(1_000)
    expect(row).not.toHaveProperty('apolloRecordId')
  })

  it('detects the fixed Accounts mapping case-insensitively', () => {
    const mapping = suggestApolloCompanyMapping(
      APOLLO_COMPANY_HEADERS.map((header) => header.toUpperCase()),
    )
    expect(mapping.companyName).toBe('COMPANY NAME')
    expect(mapping.mailingName).toBe('COMPANY NAME FOR EMAILS')
    expect(mapping.description).toBe('SHORT DESCRIPTION')
  })

  it('rejects an Apollo people export in Company mode', async () => {
    const csv = `${APOLLO_HEADERS.join(',')}\nAda,Lovelace,Founder,Analytical Engines,https://linkedin.com/in/ada,https://analytical.test,https://linkedin.com/company/analytical\n`
    await expect(
      parseCompanyCsvFile(new File([csv], 'apollo-people.csv', { type: 'text/csv' })),
    ).rejects.toThrow('Leads / Contacts')
  })

  it('requires Company name and rejects duplicate source mappings', () => {
    const mapping = suggestApolloCompanyMapping(APOLLO_COMPANY_HEADERS)
    mapping.companyName = ''
    expect(companyMappingErrors(mapping).join(' ')).toContain('Company name is required')
    mapping.companyName = mapping.website
    expect(companyMappingErrors(mapping).join(' ')).toContain('only be mapped once')
  })
})
