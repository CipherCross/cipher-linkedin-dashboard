import { describe, expect, it } from 'vitest'
import {
  buildContactRows,
  mappingErrors,
  parseCsvFile,
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
