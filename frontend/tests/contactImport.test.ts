import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIRTABLE_IDS, createRecords, formulaString } from '../api/_lib/airtable'
import {
  buildCompanyMaps,
  companyLinkedinKey,
  domainFormula,
  importAddedByChoices,
  isCleanPersonLinkedin,
  isPlausibleAddedBy,
  normalizeLinkedin,
  type CompanyRecord,
  type DbRecord,
} from '../api/_lib/airtableDirectory'
import {
  classifyGroups,
  groupRows,
  type LeadGroup,
  type LeadRow,
} from '../api/_lib/contactImport'
import { FakeAirtable, call } from './fixtures/fakeAirtable'

const lead = (rowNumber: number, overrides: Partial<LeadRow> = {}): LeadRow => ({
  rowNumber,
  personLinkedin: `https://www.linkedin.com/in/person-${rowNumber}/`,
  firstName: 'Avery',
  lastName: `Example${rowNumber}`,
  fullName: `Avery Example${rowNumber}`,
  title: 'Founder',
  companyName: 'Northwind Health',
  companyWebsite: 'northwind.example',
  companyLinkedin: '',
  ...overrides,
})

const company = (id: string, overrides: Partial<CompanyRecord> = {}): CompanyRecord => ({
  id,
  name: 'Northwind Health',
  website: 'https://www.northwind.example/',
  linkedin: '',
  approveStatus: 'Approved',
  ...overrides,
})

const dbRow = (status: string, overrides: Partial<DbRecord> = {}): DbRecord => ({
  id: 'recDB000000000001',
  name: 'Northwind Health',
  website: 'https://northwind.example',
  domain: 'northwind.example',
  status,
  addedToCompanies: false,
  ...overrides,
})

function classify(
  rows: LeadRow[],
  companies: CompanyRecord[],
  db: DbRecord[] = [],
): LeadGroup[] {
  const byDomain = new Map<string, DbRecord[]>()
  const byName = new Map<string, DbRecord[]>()
  for (const record of db) {
    byDomain.set(record.domain, [...(byDomain.get(record.domain) ?? []), record])
    const key = record.name.toLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), record])
  }
  return classifyGroups(groupRows(rows), buildCompanyMaps(companies), { byDomain, byName })
}

describe('identity keys', () => {
  it('normalizes person and company LinkedIn identities', () => {
    expect(normalizeLinkedin('https://uk.linkedin.com/in/Ada-Lovelace/?trk=x')).toBe('linkedin.com/in/ada-lovelace')
    expect(isCleanPersonLinkedin('https://linkedin.com/in/ada-lovelace/')).toBe(true)
    expect(isCleanPersonLinkedin('https://linkedin.com/sales/lead/abc')).toBe(false)
    expect(companyLinkedinKey('https://www.linkedin.com/company/109209384/about/')).toBe('linkedin.com/company/109209384')
    expect(companyLinkedinKey('109209384')).toBe('linkedin.com/company/109209384')
    expect(companyLinkedinKey('https://linkedin.com/in/someone')).toBe('')
    expect(companyLinkedinKey('acme.example')).toBe('')
  })

  it('offers only plausible Added by choices and never invents one', () => {
    expect(isPlausibleAddedBy('Anastasia Prokopenko')).toBe(true)
    expect(isPlausibleAddedBy('David')).toBe(true)
    expect(isPlausibleAddedBy('Company Phone')).toBe(false)
    expect(isPlausibleAddedBy('+1 604-626-3301')).toBe(false)
    expect(importAddedByChoices(['Daria Krut', 'Company Phone', 'Smith'])).toEqual(['Daria Krut'])
  })

  it('builds formula literals that cannot break out of their string', () => {
    expect(formulaString('O"Brien \\ Co')).toBe('"O\\"Brien \\\\ Co"')
    expect(formulaString('line\nbreak')).toBe('"line break"')
    expect(formulaString('x'.repeat(500))).toHaveLength(202)
    expect(domainFormula(['a.example', 'b-c.example'])).toContain('(a[.]example|b-c[.]example)')
  })

  it('refuses to create records in Companies at the adapter', async () => {
    vi.stubEnv('AIRTABLE_TOKEN', 'pat-test-token')
    vi.stubEnv('AIRTABLE_BASE_ID', 'app12345678901234')
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(
      createRecords(AIRTABLE_IDS.companiesTable, [{ [AIRTABLE_IDS.companies.name]: 'X' }]),
    ).rejects.toThrow('only create records in DB or Contacts')
    expect(fetcher).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
})

describe('lead grouping', () => {
  it('groups by domain first, then company LinkedIn, then name', () => {
    const groups = groupRows([
      lead(2, { companyWebsite: 'https://www.Northwind.example/team' }),
      lead(3, { companyWebsite: 'NORTHWIND.EXAMPLE' }),
      lead(4, { companyWebsite: '', companyLinkedin: 'https://www.linkedin.com/company/555/' }),
      lead(5, { companyWebsite: 'https://linktr.ee/x', companyLinkedin: '555' }),
      lead(6, { companyWebsite: '', companyName: 'Tailspin Toys' }),
      lead(7, { companyWebsite: '', companyName: 'TAILSPIN toys ' }),
    ])
    expect(groups.map((group) => [group.key, group.rowNumbers])).toEqual([
      ['domain:northwind.example', [2, 3]],
      ['linkedin:linkedin.com/company/555', [4, 5]],
      ['name:tailspin toys', [6, 7]],
    ])
  })
})

describe('lead group classification', () => {
  it('suggests a single domain match, then LinkedIn, then an exact name', () => {
    const [byDomain] = classify([lead(2)], [company('recA0000000000001')])
    expect(byDomain).toMatchObject({ status: 'suggested', method: 'domain', suggestion: { id: 'recA0000000000001' } })

    const [byLinkedin] = classify(
      [lead(2, { companyWebsite: '', companyLinkedin: '555' })],
      [company('recA0000000000001', { website: '', linkedin: 'https://www.linkedin.com/company/555/' })],
    )
    expect(byLinkedin).toMatchObject({ status: 'suggested', method: 'linkedin' })

    const [byName] = classify([lead(2, { companyWebsite: '' })], [company('recA0000000000001', { website: '' })])
    expect(byName).toMatchObject({ status: 'suggested', method: 'name' })
  })

  it('never suggests a same-name record whose domain says it is another company', () => {
    const [group] = classify([lead(2)], [company('recA0000000000001', { website: 'https://other.example' })])
    expect(group.status).toBe('not_uploaded')
    expect(group.suggestion).toBeUndefined()
    expect(group.candidates.map((candidate) => candidate.id)).toEqual(['recA0000000000001'])
  })

  it('shows every candidate when a domain is ambiguous in Companies', () => {
    const [group] = classify([lead(2)], [company('recA0000000000001'), company('recA0000000000002')])
    expect(group.status).toBe('ambiguous')
    expect(group.candidates).toHaveLength(2)
    expect(group.suggestion).toBeUndefined()
  })

  it('declines a company that is Rejected in Companies', () => {
    const [group] = classify([lead(2)], [company('recA0000000000001', { approveStatus: 'Rejected' })])
    expect(group).toMatchObject({ status: 'declined', declinedBy: 'Companies', candidates: [] })
  })

  it('ignores a Rejected duplicate when one linkable record shares the domain', () => {
    const [group] = classify([lead(2)], [
      company('recA0000000000001', { approveStatus: 'Rejected' }),
      company('recA0000000000002', { approveStatus: 'New' }),
    ])
    expect(group).toMatchObject({ status: 'suggested', suggestion: { id: 'recA0000000000002' } })
  })

  it('declines a company that is Rejected in DB', () => {
    const [group] = classify([lead(2)], [], [dbRow('Rejected')])
    expect(group).toMatchObject({ status: 'declined', declinedBy: 'DB', db: [{ status: 'Rejected' }] })
  })

  for (const status of ['New', 'Manual review', 'Manual approve', 'Approve', 'Old', '']) {
    it(`holds leads as pending when DB status is ${JSON.stringify(status)}`, () => {
      const [group] = classify([lead(2)], [], [dbRow(status)])
      expect(group).toMatchObject({ status: 'pending', db: [{ status }] })
    })
  }

  it('says so when DB marks the company as transferred but Companies has no match', () => {
    const [group] = classify([lead(2)], [], [dbRow('Approve', { addedToCompanies: true })])
    expect(group.status).toBe('pending')
    expect(group.reason).toContain('added to Companies')
  })

  it('holds leads whose company is found nowhere', () => {
    const [group] = classify([lead(2), lead(3)], [])
    expect(group).toMatchObject({ status: 'not_uploaded', rowNumbers: [2, 3] })
  })
})

describe('Leads → Contacts handler', () => {
  type Handler = typeof import('../api/_lib/contactImport').handleContactImport
  let airtable: FakeAirtable
  let handle: Handler

  beforeEach(async () => {
    vi.resetModules()
    airtable = new FakeAirtable()
    airtable.install()
    handle = (await import('../api/_lib/contactImport')).handleContactImport
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const commitRow = (row: LeadRow, companyId: string) => ({
    rowNumber: row.rowNumber,
    personLinkedin: row.personLinkedin,
    firstName: row.firstName,
    fullName: row.fullName,
    title: row.title,
    companyId,
    companyWebsite: row.companyWebsite,
  })

  it('offers the Contacts table’s own Added by choices', async () => {
    const { body } = await call(handle, 'contact_metadata')
    expect(body.addedBy).toEqual(['Daria Krut', 'David Hamaniuk', 'David'])
  })

  it('previews groups, marks existing contacts and holds unapproved companies', async () => {
    airtable.addContact('https://www.linkedin.com/in/person-3')
    airtable.addDb('https://www.tailspin.example', 'Tailspin', 'Manual review')
    const { status, body } = await call(handle, 'contact_preview', {
      rows: [
        lead(2),
        lead(3),
        lead(4, { companyName: 'Tailspin', companyWebsite: 'tailspin.example' }),
        lead(5, { personLinkedin: 'https://www.linkedin.com/sales/lead/x' }),
        lead(6, { personLinkedin: lead(2).personLinkedin }),
      ],
    })
    expect(status).toBe(200)
    expect(body.rows.map((row: { status: string }) => row.status)).toEqual([
      'ready',
      'existing',
      'ready',
      'invalid',
      'duplicate',
    ])
    expect(body.groups).toEqual([
      expect.objectContaining({ key: 'domain:northwind.example', status: 'not_uploaded', rowNumbers: [2] }),
      expect.objectContaining({ key: 'domain:tailspin.example', status: 'pending', rowNumbers: [4], db: [expect.objectContaining({ status: 'Manual review' })] }),
    ])
    const dbRequests = airtable.requests.filter((request) => request.path.includes(AIRTABLE_IDS.dbTable))
    expect(dbRequests.every((request) => request.path.endsWith('/listRecords'))).toBe(true)
  })

  it('makes a held group linkable once its company reaches Companies (Re-check)', async () => {
    airtable.addDb('https://northwind.example', 'Northwind Health', 'New')
    const before = await call(handle, 'contact_preview', { rows: [lead(2)] })
    expect(before.body.groups[0].status).toBe('pending')

    const id = airtable.addCompany('Northwind Health', 'northwind.example', 'Approved')
    const after = await call(handle, 'contact_preview', { rows: [lead(2)], forceCompanies: true })
    expect(after.body.groups[0]).toMatchObject({ status: 'suggested', method: 'domain', suggestion: { id } })
  })

  it('writes only confirmed links, with typecast off, to Contacts', async () => {
    const id = airtable.addCompany('Northwind Health', 'https://www.northwind.example', 'New')
    const { body } = await call(handle, 'contact_commit', {
      addedBy: 'David Hamaniuk',
      rows: [commitRow(lead(2, { title: 'Founder & CEO ' }), id)],
    })
    expect(body.counts).toEqual({ created: 1, duplicate: 0, failed: 0 })
    const writes = airtable.writes()
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe(`/v0/app12345678901234/${AIRTABLE_IDS.contactsTable}`)
    expect(writes[0].body).toEqual({
      typecast: false,
      records: [{
        fields: {
          [AIRTABLE_IDS.contacts.personaLinkedin]: 'https://www.linkedin.com/in/person-2/',
          [AIRTABLE_IDS.contacts.fullName]: 'Avery Example2',
          [AIRTABLE_IDS.contacts.firstName]: 'Avery',
          [AIRTABLE_IDS.contacts.title]: 'Founder & CEO',
          [AIRTABLE_IDS.contacts.company]: [id],
          [AIRTABLE_IDS.contacts.addedBy]: 'David Hamaniuk',
          [AIRTABLE_IDS.contacts.approveStatus]: 'New',
        },
      }],
    })
  })

  it('never commits a declined group, whichever record the request names', async () => {
    const rejected = airtable.addCompany('Northwind Health', 'northwind.example', 'Rejected')
    const other = airtable.addCompany('Other Co', 'other.example', 'Approved')
    airtable.addDb('https://tailspin.example', 'Tailspin', 'Rejected')

    const { body } = await call(handle, 'contact_commit', {
      addedBy: 'Daria Krut',
      rows: [
        commitRow(lead(2), rejected),
        commitRow(lead(3), other),
        commitRow(lead(4, { companyWebsite: 'tailspin.example' }), other),
        commitRow(lead(5), 'rec00000000009999'),
      ],
    })
    expect(body.results.map((result: { status: string; error?: string }) => [result.status, result.error])).toEqual([
      ['failed', 'The confirmed Company is Rejected in Companies'],
      ['failed', 'This lead’s company is Rejected in Companies'],
      ['failed', 'This lead’s company is Rejected in DB'],
      ['failed', 'The confirmed Company no longer exists in Airtable'],
    ])
    expect(airtable.writes()).toHaveLength(0)
  })

  it('allows a manual link for a company that is only missing from DB', async () => {
    const id = airtable.addCompany('Northwind (renamed)', 'https://northwind-health.example', 'Approved')
    const { body } = await call(handle, 'contact_commit', {
      addedBy: 'Daria Krut',
      rows: [commitRow(lead(2), id)],
    })
    expect(body.counts.created).toBe(1)
  })

  it('skips existing contacts and repeats, and refuses a DB-only Added by', async () => {
    const id = airtable.addCompany('Northwind Health', 'northwind.example')
    airtable.addContact('https://linkedin.com/in/person-2')
    const skipped = await call(handle, 'contact_commit', {
      addedBy: 'Daria Krut',
      rows: [commitRow(lead(2), id), commitRow(lead(3), id), commitRow(lead(3), id)],
    })
    expect(skipped.body.counts).toEqual({ created: 1, duplicate: 2, failed: 0 })

    const refused = await call(handle, 'contact_commit', {
      addedBy: 'David Gamanuk',
      rows: [commitRow(lead(4), id)],
    })
    expect(refused.status).toBe(400)
  })

  it('rejects a commit row without a confirmed record ID', async () => {
    const { status } = await call(handle, 'contact_commit', {
      addedBy: 'Daria Krut',
      rows: [{ ...commitRow(lead(2), ''), companyId: undefined }],
    })
    expect(status).toBe(400)
    expect(airtable.writes()).toHaveLength(0)
  })

  it('searches Companies and returns the approval status', async () => {
    airtable.addCompany('Northwind Health', 'https://www.northwind.example', 'Rejected')
    const { body } = await call(handle, 'company_search', { query: 'northwind.example' })
    expect(body.companies).toEqual([expect.objectContaining({ name: 'Northwind Health', approveStatus: 'Rejected' })])
  })
})
