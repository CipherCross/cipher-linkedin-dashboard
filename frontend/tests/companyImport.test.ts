import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIRTABLE_IDS } from '../api/_lib/airtable'
import type { CompanyImportRow } from '../api/_lib/companyImport'
import { FakeAirtable, call } from './fixtures/fakeAirtable'

type Handler = typeof import('../api/_lib/companyImport').handleCompanyImport

let airtable: FakeAirtable
let handle: Handler

const row = (rowNumber: number, overrides: Partial<CompanyImportRow> = {}): CompanyImportRow => ({
  rowNumber,
  companyName: `Company ${rowNumber}`,
  website: `company${rowNumber}.example`,
  linkedin: '',
  country: 'Germany',
  employees: '42',
  foundedYear: '2019',
  industry: 'Hospital & Health Care',
  keywords: 'telehealth',
  description: 'Invented.',
  ...overrides,
})

beforeEach(async () => {
  // Fresh modules per test: the importers cache the schema and Companies.
  vi.resetModules()
  airtable = new FakeAirtable()
  airtable.install()
  handle = (await import('../api/_lib/companyImport')).handleCompanyImport
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Companies → DB metadata', () => {
  it('offers only the DB table’s own plausible Added by choices', async () => {
    const { status, body } = await call(handle, 'company_metadata')
    expect(status).toBe(200)
    expect(body.addedBy).toEqual(['Daria Krut', 'David Gamanuk'])
  })
})

describe('Companies → DB preview', () => {
  it('classifies new, repeated, DB, Companies, name-only and invalid rows', async () => {
    airtable.addDb('https://www.rejected.example/about', 'Rejected Co', 'Rejected')
    airtable.addDb('http://pending.example', 'Pending Co', 'Manual review')
    airtable.addCompany('Approved Co', 'https://www.APPROVED.example/', 'Approved')
    airtable.addCompany('Same Name GmbH', 'https://other-domain.example', 'New')

    const { status, body } = await call(handle, 'company_preview', {
      rows: [
        row(2),
        row(3, { website: 'https://www.Company2.example/path' }),
        row(4, { website: 'rejected.example' }),
        row(5, { website: 'PENDING.example.' }),
        row(6, { website: 'approved.example' }),
        row(7, { companyName: 'Same Name GmbH', website: 'same-name.example' }),
        row(8, { website: 'https://linktr.ee/someone' }),
        row(9, { website: '' }),
        row(10, { companyName: '' }),
      ],
    })

    expect(status).toBe(200)
    const byRow = new Map(body.results.map((result: { rowNumber: number }) => [result.rowNumber, result]))
    expect(byRow.get(2)).toEqual({ rowNumber: 2, status: 'ready', domain: 'company2.example' })
    expect(byRow.get(3)).toMatchObject({ status: 'duplicate', domain: 'company2.example', matches: [{ table: 'File', rowNumber: 2 }] })
    expect(byRow.get(4)).toMatchObject({ status: 'duplicate', matches: [{ table: 'DB', status: 'Rejected', name: 'Rejected Co' }] })
    expect(byRow.get(5)).toMatchObject({ status: 'duplicate', matches: [{ table: 'DB', status: 'Manual review' }] })
    expect(byRow.get(6)).toMatchObject({ status: 'duplicate', matches: [{ table: 'Companies', status: 'Approved' }] })
    expect(byRow.get(7)).toMatchObject({ status: 'name_match', matches: [{ table: 'Companies', name: 'Same Name GmbH' }] })
    expect(byRow.get(8)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('platform page') })
    expect(byRow.get(9)).toMatchObject({ status: 'invalid', reason: 'No company domain or website' })
    expect(byRow.get(10)).toMatchObject({ status: 'invalid', reason: 'Company name is required' })
  })

  it('reads DB only through formula-scoped listRecords, never in full', async () => {
    await call(handle, 'company_preview', { rows: [row(2), row(3)] })
    const dbRequests = airtable.requests.filter((request) => request.path.includes(AIRTABLE_IDS.dbTable))
    expect(dbRequests.length).toBeGreaterThan(0)
    for (const request of dbRequests) {
      expect(request.method).toBe('POST')
      expect(request.path.endsWith('/listRecords')).toBe(true)
      expect(String(request.body?.filterByFormula)).toMatch(/^(REGEX_MATCH|FIND)\(/)
    }
    const domainQuery = dbRequests.find((request) => String(request.body?.filterByFormula).startsWith('REGEX_MATCH'))
    expect(domainQuery?.body?.filterByFormula).toContain('company2[.]example|company3[.]example')
  })

  it('finds a DB website stored in its Unicode spelling for an IDN upload', async () => {
    airtable.addDb('https://www.bücher.de/shop', 'Bücher', 'Rejected')
    const { body } = await call(handle, 'company_preview', {
      rows: [row(2, { companyName: 'Books GmbH', website: 'https://xn--bcher-kva.de' })],
    })
    expect(body.results[0]).toMatchObject({
      status: 'duplicate',
      domain: 'xn--bcher-kva.de',
      matches: [{ table: 'DB', status: 'Rejected' }],
    })
  })

  it('escapes quotes and backslashes in names sent to a formula', async () => {
    airtable.addDb('https://quoted.example', 'O"Brien \\ Sons', 'Rejected')
    const { body } = await call(handle, 'company_preview', {
      rows: [row(2, { companyName: 'O"Brien \\ Sons', website: 'new-obrien.example' })],
    })
    expect(body.results[0]).toMatchObject({ status: 'name_match', matches: [{ table: 'DB', status: 'Rejected' }] })
    const nameQuery = airtable.requests.find((request) => String(request.body?.filterByFormula).startsWith('FIND'))
    expect(nameQuery?.body?.filterByFormula).toContain('o\\"brien \\\\ sons')
  })
})

describe('Companies → DB commit', () => {
  it('creates New rows in DB with a bare domain and never touches Companies', async () => {
    const { status, body } = await call(handle, 'company_commit', {
      addedBy: 'David Gamanuk',
      rows: [
        row(2, {
          website: 'http://www.Northwind.example/',
          linkedin: 'https://www.linkedin.com/company/109209384/about/',
          foundedYear: '0',
          employees: '1200',
        }),
        row(3, { linkedin: '109209999', foundedYear: '1500' }),
      ],
    })

    expect(status).toBe(200)
    expect(body.counts).toEqual({ created: 2, duplicate: 0, failed: 0 })
    const writes = airtable.writes()
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe(`/v0/app12345678901234/${AIRTABLE_IDS.dbTable}`)
    expect(writes[0].body?.typecast).toBe(false)
    const [first, second] = (writes[0].body?.records as Array<{ fields: Record<string, unknown> }>).map((record) => record.fields)
    expect(first).toEqual({
      [AIRTABLE_IDS.db.website]: 'northwind.example',
      [AIRTABLE_IDS.db.name]: 'Company 2',
      [AIRTABLE_IDS.db.linkedin]: 'https://www.linkedin.com/company/109209384/',
      [AIRTABLE_IDS.db.country]: 'Germany',
      [AIRTABLE_IDS.db.employees]: 1200,
      [AIRTABLE_IDS.db.industry]: 'Hospital & Health Care',
      [AIRTABLE_IDS.db.keywords]: 'telehealth',
      [AIRTABLE_IDS.db.description]: 'Invented.',
      [AIRTABLE_IDS.db.initialStatus]: 'New',
      [AIRTABLE_IDS.db.addedBy]: 'David Gamanuk',
    })
    expect(first).not.toHaveProperty(AIRTABLE_IDS.db.foundedYear)
    expect(first).not.toHaveProperty(AIRTABLE_IDS.db.mailingName)
    expect(second[AIRTABLE_IDS.db.linkedin]).toBe('https://www.linkedin.com/company/109209999/')
    expect(second).not.toHaveProperty(AIRTABLE_IDS.db.foundedYear)
    expect(airtable.records(AIRTABLE_IDS.companiesTable)).toHaveLength(0)
  })

  it('skips every row of a re-upload as a duplicate in DB', async () => {
    const rows = Array.from({ length: 13 }, (_, index) => row(index + 2))
    const first = await call(handle, 'company_commit', { addedBy: 'Daria Krut', rows })
    expect(first.body.counts.created).toBe(13)

    const again = await call(handle, 'company_preview', { rows })
    expect(again.body.counts).toEqual({ duplicate: 13 })
    for (const result of again.body.results) {
      expect(result.matches).toEqual([expect.objectContaining({ table: 'DB', status: 'New' })])
    }
    const recommit = await call(handle, 'company_commit', { addedBy: 'Daria Krut', rows })
    expect(recommit.body.counts).toEqual({ created: 0, duplicate: 13, failed: 0 })
    expect(airtable.records(AIRTABLE_IDS.dbTable)).toHaveLength(13)
  })

  it('re-checks DB right before creating, so a row added since preview is skipped', async () => {
    const preview = await call(handle, 'company_preview', { rows: [row(2)] })
    expect(preview.body.results[0].status).toBe('ready')
    airtable.addDb('https://www.company2.example', 'Company 2', 'New')
    const { body } = await call(handle, 'company_commit', { addedBy: 'Daria Krut', rows: [row(2)] })
    expect(body.counts).toEqual({ created: 0, duplicate: 1, failed: 0 })
    expect(airtable.writes()).toHaveLength(0)
  })

  it('collapses domain spellings inside one commit', async () => {
    const { body } = await call(handle, 'company_commit', {
      addedBy: 'Daria Krut',
      rows: [
        row(2, { website: 'https://www.Acme.example/path' }),
        row(3, { website: 'ACME.EXAMPLE' }),
        row(4, { website: 'acme.example.' }),
      ],
    })
    expect(body.counts).toEqual({ created: 1, duplicate: 2, failed: 0 })
  })

  it('refuses an Added by that exists only in Contacts', async () => {
    const { status, body } = await call(handle, 'company_commit', { addedBy: 'David Hamaniuk', rows: [row(2)] })
    expect(status).toBe(400)
    expect(body.error).toContain('DB choices')
    expect(airtable.writes()).toHaveLength(0)
  })

  it('isolates a rejected row so the rest of its batch still lands', async () => {
    airtable.failNextCreate = 422
    const { body } = await call(handle, 'company_commit', {
      addedBy: 'Daria Krut',
      rows: [row(2), row(3)],
    })
    expect(body.counts).toEqual({ created: 2, duplicate: 0, failed: 0 })
    expect(airtable.writes()).toHaveLength(3)
  })

  it('fails closed when the DB schema drifts', async () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init)
      if (!String(input).includes('/meta/bases/')) return response
      const schema = await response.json()
      const db = schema.tables.find((table: { id: string }) => table.id === AIRTABLE_IDS.dbTable)
      db.fields = db.fields.filter((item: { id: string }) => item.id !== AIRTABLE_IDS.db.website)
      return new Response(JSON.stringify(schema), { status: 200 })
    }))
    const { status, body } = await call(handle, 'company_metadata')
    expect(status).toBe(503)
    expect(body.error).toContain('schema mismatch')
  })
})
