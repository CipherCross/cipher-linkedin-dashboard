// An in-memory Airtable for the importer handler tests. It serves the schema,
// full-table reads, the POST `listRecords` formula endpoint, and creates, and
// records every request so a test can assert which table was queried or
// written and how.
//
// The two formula shapes the importers send are evaluated for real: the
// domain REGEX_MATCH prefilter and the name FIND list. Anything else is a test
// failure, so a new unscoped DB query cannot slip through.
import { vi } from 'vitest'
import { AIRTABLE_IDS } from '../../api/_lib/airtable'

export const BASE_ID = 'app12345678901234'

type Fields = Record<string, unknown>
interface StoredRecord {
  id: string
  fields: Fields
}

export interface FakeRequest {
  method: string
  path: string
  body: Record<string, unknown> | null
}

const choices = (...names: string[]) => ({ choices: names.map((name, index) => ({ id: `sel${index}`, name })) })

export const DB_ADDED_BY = ['Daria Krut', 'David Gamanuk', 'AI', 'Company Phone']
export const CONTACTS_ADDED_BY = ['Daria Krut', 'David Hamaniuk', 'David', 'Smith']

function schema() {
  const db = AIRTABLE_IDS.db
  const companies = AIRTABLE_IDS.companies
  const contacts = AIRTABLE_IDS.contacts
  return {
    tables: [
      {
        id: AIRTABLE_IDS.dbTable,
        name: 'DB',
        fields: [
          { id: db.website, name: 'Company Website', type: 'url' },
          { id: db.name, name: 'Company name', type: 'singleLineText' },
          { id: db.mailingName, name: 'Company name for mailing', type: 'singleLineText' },
          { id: db.linkedin, name: 'LinkedIn URL', type: 'url' },
          { id: db.country, name: 'HQ country', type: 'singleLineText' },
          { id: db.foundedYear, name: 'Founded year', type: 'number' },
          { id: db.employees, name: 'Employees', type: 'number' },
          { id: db.industry, name: 'Industry', type: 'singleLineText' },
          { id: db.keywords, name: 'Keywords', type: 'multilineText' },
          { id: db.description, name: 'Description', type: 'multilineText' },
          {
            id: db.initialStatus,
            name: 'Initial status',
            type: 'singleSelect',
            options: choices('New', 'Manual review', 'Manual approve', 'Approve', 'Rejected', 'Old', 'hospital & health care'),
          },
          { id: db.addedToCompanies, name: 'Added to Companies', type: 'singleSelect', options: choices('Added', 'Not added', 'Gina Health') },
          { id: db.addedBy, name: 'Added by', type: 'singleSelect', options: choices(...DB_ADDED_BY) },
        ],
      },
      {
        id: AIRTABLE_IDS.companiesTable,
        name: 'Companies',
        fields: [
          { id: companies.name, name: 'Company name', type: 'singleLineText' },
          { id: companies.website, name: 'Website URL', type: 'url' },
          { id: companies.linkedin, name: 'LinkedIn URL', type: 'url' },
          { id: companies.approveStatus, name: 'Approve Status', type: 'singleSelect', options: choices('New', 'Approved', 'Rejected', 'Edits') },
        ],
      },
      {
        id: AIRTABLE_IDS.contactsTable,
        name: 'Contacts',
        fields: [
          { id: contacts.personaLinkedin, name: 'Persona LinkedIn', type: 'url' },
          { id: contacts.approveStatus, name: 'Approve status', type: 'singleSelect', options: choices('New', 'Approved', 'Rejected', 'Last Name') },
          { id: contacts.fullName, name: 'Full name', type: 'singleLineText' },
          { id: contacts.firstName, name: 'First name', type: 'singleLineText' },
          { id: contacts.title, name: 'Title', type: 'singleLineText' },
          {
            id: contacts.company,
            name: 'Company',
            type: 'multipleRecordLinks',
            options: { linkedTableId: AIRTABLE_IDS.companiesTable },
          },
          { id: contacts.addedBy, name: 'Added by', type: 'singleSelect', options: choices(...CONTACTS_ADDED_BY) },
        ],
      },
    ],
  }
}

let nextId = 1
export const recordId = () => `rec${String(nextId++).padStart(14, '0')}`

function unescapeFormulaString(literal: string): string {
  return literal.replace(/\\(.)/g, '$1')
}

/** Evaluates the importers' two DB formula shapes against one record. */
function matchesFormula(formula: string, fields: Fields): boolean {
  const regex = /^REGEX_MATCH\(LOWER\(\{(fld\w+)\}&""\), "(.*)"\)$/.exec(formula)
  if (regex) {
    return new RegExp(regex[2]).test(String(fields[regex[1]] ?? '').toLowerCase())
  }
  const find = /^FIND\("\|"&LOWER\(TRIM\(\{(fld\w+)\}&""\)\)&"\|", "((?:[^"\\]|\\.)*)"\)$/.exec(formula)
  if (find) {
    const value = String(fields[find[1]] ?? '').trim().toLowerCase()
    return unescapeFormulaString(find[2]).includes(`|${value}|`)
  }
  throw new Error(`fake Airtable: unsupported formula ${formula}`)
}

export class FakeAirtable {
  tables = new Map<string, StoredRecord[]>([
    [AIRTABLE_IDS.dbTable, []],
    [AIRTABLE_IDS.companiesTable, []],
    [AIRTABLE_IDS.contactsTable, []],
  ])
  requests: FakeRequest[] = []
  /** When set, the next create request answers with this status. */
  failNextCreate: number | null = null

  add(tableId: string, fields: Fields): string {
    const id = recordId()
    this.tables.get(tableId)!.push({ id, fields })
    return id
  }

  addDb(website: string, name: string, status = 'New', addedToCompanies = '') {
    return this.add(AIRTABLE_IDS.dbTable, {
      [AIRTABLE_IDS.db.website]: website,
      [AIRTABLE_IDS.db.name]: name,
      [AIRTABLE_IDS.db.initialStatus]: status,
      ...(addedToCompanies ? { [AIRTABLE_IDS.db.addedToCompanies]: addedToCompanies } : {}),
    })
  }

  addCompany(name: string, website: string, approveStatus = 'Approved', linkedin = '') {
    return this.add(AIRTABLE_IDS.companiesTable, {
      [AIRTABLE_IDS.companies.name]: name,
      [AIRTABLE_IDS.companies.website]: website,
      [AIRTABLE_IDS.companies.approveStatus]: approveStatus,
      ...(linkedin ? { [AIRTABLE_IDS.companies.linkedin]: linkedin } : {}),
    })
  }

  addContact(personaLinkedin: string) {
    return this.add(AIRTABLE_IDS.contactsTable, {
      [AIRTABLE_IDS.contacts.personaLinkedin]: personaLinkedin,
    })
  }

  records(tableId: string) {
    return this.tables.get(tableId)!
  }

  writes() {
    return this.requests.filter((request) => request.method !== 'GET' && !request.path.endsWith('/listRecords'))
  }

  install() {
    vi.stubEnv('AIRTABLE_TOKEN', 'pat-test-token')
    vi.stubEnv('AIRTABLE_BASE_ID', BASE_ID)
    // The adapter spaces requests 225 ms apart. A clock that jumps ahead on
    // every read keeps that gap at zero without changing the adapter.
    let clock = Date.parse('2026-09-25T00:00:00Z')
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => this.handle(input, init)))
  }

  private respond(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  private handle(input: RequestInfo | URL, init?: RequestInit): Response {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    this.requests.push({ method, path: url.pathname, body })

    if (url.pathname === `/v0/meta/bases/${BASE_ID}/tables`) return this.respond(schema())

    const list = new RegExp(`^/v0/${BASE_ID}/(tbl\\w+)/listRecords$`).exec(url.pathname)
    if (list && method === 'POST') {
      const formula = String(body?.filterByFormula ?? '')
      const records = this.records(list[1]).filter((record) => matchesFormula(formula, record.fields))
      return this.respond({ records })
    }

    const table = new RegExp(`^/v0/${BASE_ID}/(tbl\\w+)$`).exec(url.pathname)
    if (table && method === 'GET') return this.respond({ records: this.records(table[1]) })
    if (table && method === 'POST') {
      if (this.failNextCreate) {
        const status = this.failNextCreate
        this.failNextCreate = null
        return this.respond({ error: { type: 'INVALID_VALUE_FOR_COLUMN', message: 'Rejected by fake' } }, status)
      }
      const created = (body?.records as Array<{ fields: Fields }>).map(({ fields }) => ({
        id: this.add(table[1], fields),
        fields,
      }))
      return this.respond({ records: created })
    }
    return this.respond({ error: 'NOT_FOUND' }, 404)
  }
}

export async function call(
  handler: (action: string, payload: Record<string, unknown>) => Promise<Response>,
  action: string,
  payload: Record<string, unknown> = {},
) {
  const response = await handler(action, payload)
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}
