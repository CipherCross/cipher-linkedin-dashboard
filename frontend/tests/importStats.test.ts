import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIRTABLE_IDS } from '../api/_lib/airtable'
import type { TeamStatsBucket } from '../src/lib/teamStats'
import { FakeAirtable, call } from './fixtures/fakeAirtable'

type Handler = typeof import('../api/_lib/importStats').handleImportStats
type Module = typeof import('../api/_lib/importStats')

let airtable: FakeAirtable
let handle: (action: string, payload: Record<string, unknown>) => Promise<Response>
let stats: Module

const { db, companies, contacts } = AIRTABLE_IDS

const addDb = (addedBy: string | null, status: string | null, createdTime: string) =>
  airtable.add(AIRTABLE_IDS.dbTable, {
    [db.name]: 'Some company',
    ...(addedBy ? { [db.addedBy]: addedBy } : {}),
    ...(status ? { [db.initialStatus]: status } : {}),
  }, createdTime)

const addCompany = (addedBy: string, status: string, createdTime: string) =>
  airtable.add(AIRTABLE_IDS.companiesTable, { [companies.addedBy]: addedBy, [companies.approveStatus]: status }, createdTime)

const addContact = (addedBy: string, status: string, createdTime: string) =>
  airtable.add(AIRTABLE_IDS.contactsTable, { [contacts.addedBy]: addedBy, [contacts.approveStatus]: status }, createdTime)

const run = (payload: Record<string, unknown>) => call(handle, 'import_stats', payload)
const october = { base: 'web2mob', from: '2026-10-01', to: '2026-10-07' }

const bucketsOf = (body: Record<string, any>, table: string) =>
  (body.buckets as TeamStatsBucket[]).filter((bucket) => bucket.table === table)

beforeEach(async () => {
  // Fresh modules per test: the handler caches the schema and the buckets.
  vi.resetModules()
  airtable = new FakeAirtable()
  airtable.install()
  stats = await import('../api/_lib/importStats')
  const handler: Handler = stats.handleImportStats
  handle = (_action, payload) => handler(payload)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('import_stats status mapping', () => {
  it('maps every known status, sends unknown and blank to New, and drops Old everywhere', () => {
    const { statusGroup } = stats
    expect(['Approve', 'Approved', 'Manual approve', ' manual APPROVE '].map(statusGroup)).toEqual(Array(4).fill('approve'))
    expect(['Reject', 'Rejected', 'rejected'].map(statusGroup)).toEqual(Array(3).fill('reject'))
    expect(['New', 'Manual review', '', 'Edits', 'Something added later'].map(statusGroup)).toEqual(Array(5).fill('new'))
    expect(['Old', ' old '].map(statusGroup)).toEqual([null, null])
  })
})

describe('import_stats', () => {
  it('buckets records by created day, Added by and status group, inside the UTC period only', async () => {
    addDb('Daria Krut', 'New', '2026-10-01T00:00:00.000Z')
    addDb('Daria Krut', 'Manual review', '2026-10-01T23:59:59.999Z')
    addDb('Daria Krut', 'Approve', '2026-10-03T10:00:00.000Z')
    addDb('Daria Krut', 'Manual approve', '2026-10-03T11:00:00.000Z')
    addDb('David Gamanuk', 'Rejected', '2026-10-07T23:59:59.000Z')
    addDb('David Gamanuk', 'Something new', '2026-10-05T08:00:00.000Z')
    // Outside the period, though inside the formula's one-day margin.
    addDb('Daria Krut', 'New', '2026-09-30T23:59:59.999Z')
    addDb('Daria Krut', 'New', '2026-10-08T00:00:00.000Z')
    // Old is never counted, not even in All.
    addDb('Daria Krut', 'Old', '2026-10-02T09:00:00.000Z')
    addDb('David Gamanuk', 'old', '2026-10-02T09:00:00.000Z')

    const { status, body } = await run(october)
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, base: 'web2mob', configured: true, from: '2026-10-01', to: '2026-10-07' })
    expect(bucketsOf(body, 'db')).toEqual([
      { table: 'db', day: '2026-10-01', addedBy: 'Daria Krut', group: 'new', count: 2 },
      { table: 'db', day: '2026-10-03', addedBy: 'Daria Krut', group: 'approve', count: 2 },
      { table: 'db', day: '2026-10-05', addedBy: 'David Gamanuk', group: 'new', count: 1 },
      { table: 'db', day: '2026-10-07', addedBy: 'David Gamanuk', group: 'reject', count: 1 },
    ])
  })

  it('reads Companies and Contacts with their own status and Added by fields', async () => {
    addCompany('Daria Krut', 'Approved', '2026-10-02T12:00:00.000Z')
    addCompany('Daria Krut', 'Edits', '2026-10-02T13:00:00.000Z')
    addContact('David Hamaniuk', 'Approved', '2026-10-04T12:00:00.000Z')
    addContact('David Hamaniuk', 'Rejected', '2026-10-04T13:00:00.000Z')
    addContact('David Hamaniuk', 'Old', '2026-10-04T14:00:00.000Z')

    const { body } = await run(october)
    expect(bucketsOf(body, 'companies')).toEqual([
      { table: 'companies', day: '2026-10-02', addedBy: 'Daria Krut', group: 'approve', count: 1 },
      { table: 'companies', day: '2026-10-02', addedBy: 'Daria Krut', group: 'new', count: 1 },
    ])
    expect(bucketsOf(body, 'contacts')).toEqual([
      { table: 'contacts', day: '2026-10-04', addedBy: 'David Hamaniuk', group: 'approve', count: 1 },
      { table: 'contacts', day: '2026-10-04', addedBy: 'David Hamaniuk', group: 'reject', count: 1 },
    ])
  })

  it('keeps records with no Added by (Not set) and with a non-person Added by', async () => {
    addDb(null, 'New', '2026-10-02T12:00:00.000Z')
    addDb('AI', null, '2026-10-02T12:00:00.000Z')
    const { body } = await run(october)
    expect(bucketsOf(body, 'db')).toEqual([
      { table: 'db', day: '2026-10-02', addedBy: '', group: 'new', count: 1 },
      { table: 'db', day: '2026-10-02', addedBy: 'AI', group: 'new', count: 1 },
    ])
  })

  it('lists every plausible Added by choice and each status choice with its group', async () => {
    const { body } = await run(october)
    expect(body.buckets).toEqual([])
    expect(body.tables.db.people).toEqual(['Daria Krut', 'David Gamanuk'])
    expect(body.tables.companies.people).toEqual(['Daria Krut', 'David Gamanuk'])
    expect(body.tables.contacts.people).toEqual(['Daria Krut', 'David Hamaniuk', 'David'])
    expect(body.tables.db.statuses).toEqual([
      { name: 'New', group: 'new' },
      { name: 'Manual review', group: 'new' },
      { name: 'Manual approve', group: 'approve' },
      { name: 'Approve', group: 'approve' },
      { name: 'Rejected', group: 'reject' },
      { name: 'Old', group: 'excluded' },
      { name: 'hospital & health care', group: 'new' },
    ])
  })

  it('reads only through a created-time formula that drops Old, asks for two fields, and writes nothing', async () => {
    await run(october)
    expect(airtable.writes()).toEqual([])
    const reads = airtable.requests.filter((request) => request.path.endsWith('/listRecords'))
    expect(reads.map((request) => request.path.split('/')[3]).sort()).toEqual(
      [AIRTABLE_IDS.companiesTable, AIRTABLE_IDS.contactsTable, AIRTABLE_IDS.dbTable].sort(),
    )
    const dbRead = reads.find((request) => request.path.includes(AIRTABLE_IDS.dbTable))!
    expect(dbRead.method).toBe('POST')
    expect(dbRead.body?.fields).toEqual([db.addedBy, db.initialStatus])
    expect(dbRead.body?.filterByFormula).toBe(
      'AND(IS_AFTER(CREATED_TIME(), DATETIME_PARSE("2026-09-30T00:00:00.000Z")), '
      + 'IS_BEFORE(CREATED_TIME(), DATETIME_PARSE("2026-10-09T00:00:00.000Z")), '
      + `LOWER(TRIM({${db.initialStatus}}&"")) != "old")`,
    )
    // Nothing else: the schema, then one formula read per table.
    expect(airtable.requests.filter((request) => !request.path.endsWith('/listRecords'))).toEqual([
      expect.objectContaining({ method: 'GET', path: expect.stringContaining('/v0/meta/bases/') }),
    ])
  })

  it('caches per base, table and period, and re-reads Airtable on force', async () => {
    addDb('Daria Krut', 'New', '2026-10-02T12:00:00.000Z')
    await run(october)
    const first = airtable.requests.length
    addDb('Daria Krut', 'New', '2026-10-02T13:00:00.000Z')

    const cached = await run(october)
    expect(airtable.requests.length).toBe(first)
    expect(bucketsOf(cached.body, 'db')[0].count).toBe(1)

    const otherPeriod = await run({ ...october, to: '2026-10-06' })
    expect(airtable.requests.length).toBeGreaterThan(first)
    expect(bucketsOf(otherPeriod.body, 'db')[0].count).toBe(2)

    const forced = await run({ ...october, force: true })
    expect(bucketsOf(forced.body, 'db')[0].count).toBe(2)
  })

  it('answers a clear 422, not a timeout, when a table outruns the page budget', async () => {
    for (let index = 0; index < 5_001; index++) addDb('Daria Krut', 'New', '2026-10-02T12:00:00.000Z')
    const { status, body } = await run(october)
    expect(status).toBe(422)
    expect(body.error).toBe('DB has more than 5,000 records created in this period. Pick a shorter period.')
    const dbPages = airtable.requests.filter((request) => request.path.includes(AIRTABLE_IDS.dbTable))
    expect(dbPages).toHaveLength(stats.MAX_PAGES_PER_TABLE)
  })

  it('answers configured: false for a base without its env var and reads nothing', async () => {
    const { status, body } = await run({ ...october, base: 'fintech_arabic' })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, base: 'fintech_arabic', configured: false, from: '2026-10-01', to: '2026-10-07' })
    expect(airtable.requests).toEqual([])
  })

  it('reads the Fintech (Arabic) base when it is configured, and only that base', async () => {
    const fintech = new FakeAirtable('app98765432109876')
    vi.unstubAllGlobals()
    airtable.install(fintech)
    fintech.add(AIRTABLE_IDS.dbTable, { [db.addedBy]: 'Daria Krut', [db.initialStatus]: 'New' }, '2026-10-02T12:00:00.000Z')
    const { body } = await run({ ...october, base: 'fintech_arabic' })
    expect(bucketsOf(body, 'db')).toEqual([{ table: 'db', day: '2026-10-02', addedBy: 'Daria Krut', group: 'new', count: 1 }])
    expect(airtable.requests).toEqual([])
  })

  it('refuses an unknown base', async () => {
    const { status, body } = await run({ ...october, base: 'nowhere' })
    expect(status).toBe(400)
    expect(body.error).toBe('base must be one of the known Airtable bases')
  })

  it('refuses a malformed, inverted or longer than 92-day period before reading Airtable', async () => {
    for (const range of [
      { from: '2026-10-01', to: '2026-13-01' },
      { from: '2026-02-30', to: '2026-03-01' },
      { from: '1 Oct', to: '2026-10-07' },
      { to: '2026-10-07' },
    ]) {
      const { status, body } = await run({ base: 'web2mob', ...range })
      expect(status).toBe(400)
      expect(body.error).toBe('from and to must be dates in YYYY-MM-DD form')
    }
    expect((await run({ base: 'web2mob', from: '2026-10-07', to: '2026-10-01' })).body.error).toBe('from must not be after to')
    const tooLong = await run({ base: 'web2mob', from: '2026-08-01', to: '2026-11-01' })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error).toBe('The period is longer than 92 days. Pick a shorter period.')
    expect(airtable.requests).toEqual([])

    const longest = await run({ base: 'web2mob', from: '2026-08-02', to: '2026-11-01' })
    expect(longest.status).toBe(200)
  })

  it('names a schema mismatch when a counted field is gone', async () => {
    vi.unstubAllGlobals()
    const original = airtable.handle.bind(airtable)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = original(input, init)
      if (!String(input).includes('/meta/')) return response
      const schema = await response.json()
      for (const table of schema.tables) {
        table.fields = table.fields.filter((field: { id: string }) => field.id !== companies.addedBy)
      }
      return new Response(JSON.stringify(schema), { status: 200 })
    }))
    const { status, body } = await run(october)
    expect(status).toBe(503)
    expect(body.error).toContain(`Companies.${companies.addedBy}`)
  })
})
