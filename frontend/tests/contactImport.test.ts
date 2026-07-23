import { describe, expect, it } from 'vitest'
import {
  buildCompanyMaps,
  companyMatch,
  isPlausibleAddedBy,
  isCleanPersonLinkedin,
  normalizeDomain,
  normalizeLinkedin,
} from '../api/_lib/contactImport'
import type { CompanyRecord, PreviewRow } from '../api/_lib/contactImport'

const row: PreviewRow = {
  rowNumber: 2,
  personLinkedin: 'https://www.linkedin.com/in/ada-lovelace/',
  firstName: 'Ada',
  lastName: 'Lovelace',
  fullName: 'Ada Lovelace',
  title: 'Founder',
  companyName: 'Analytical Engines',
  companyWebsite: 'https://analytical.test',
  companyLinkedin: 'https://www.linkedin.com/company/analytical-engines/',
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

describe('Airtable company matching', () => {
  it('normalizes public LinkedIn and website identities', () => {
    expect(normalizeLinkedin('https://uk.linkedin.com/in/Ada-Lovelace/?trk=x')).toBe(
      'linkedin.com/in/ada-lovelace',
    )
    expect(normalizeDomain('HTTP://WWW.Example.com/path')).toBe('example.com')
    expect(isCleanPersonLinkedin('https://linkedin.com/in/ada-lovelace/')).toBe(true)
    expect(isCleanPersonLinkedin('https://linkedin.com/sales/lead/abc')).toBe(false)
    expect(isPlausibleAddedBy('Anastasia Prokopenko')).toBe(true)
    expect(isPlausibleAddedBy('Company Phone')).toBe(false)
    expect(isPlausibleAddedBy('+1 604-626-3301')).toBe(false)
  })

  it('automatically selects one stable LinkedIn/domain match', () => {
    const match = companyMatch(row, buildCompanyMaps([company('rec00000000000001')]))
    expect(match.status).toBe('ready')
    expect(match.company?.id).toBe('rec00000000000001')
  })

  it('requires review when stable identifiers point to different records', () => {
    const companies = [
      company('rec00000000000001', { website: 'https://other.test' }),
      company('rec00000000000002', {
        name: 'Different',
        linkedin: 'https://linkedin.com/company/different',
      }),
    ]
    const match = companyMatch(row, buildCompanyMaps(companies))
    expect(match.status).toBe('company_action')
    expect(match.reason).toBe('conflict')
  })

  it('does not auto-select a name match whose stable identifiers conflict', () => {
    const candidate = company('rec00000000000001', {
      website: 'https://wrong.test',
      linkedin: 'https://linkedin.com/company/wrong',
    })
    const match = companyMatch(row, buildCompanyMaps([candidate]))
    expect(match.status).toBe('company_action')
    expect(match.reason).toBe('conflict')
  })

  it('does not pick the first record when a stable key is duplicated', () => {
    const match = companyMatch(
      row,
      buildCompanyMaps([
        company('rec00000000000001'),
        company('rec00000000000002'),
      ]),
    )
    expect(match.status).toBe('company_action')
    expect(match.reason).toBe('ambiguous')
  })
})
