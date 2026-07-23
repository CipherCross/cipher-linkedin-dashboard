import {
  AIRTABLE_IDS,
  AirtableError,
  createRecords,
  getAirtableSchema,
  listAllRecords,
} from './airtable.js'

const MAX_ROWS = 500
const CACHE_MS = 5 * 60_000
const CONTACT_CACHE_MS = 60_000
const MAX_TEXT = 1000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })

export interface CompanyRecord {
  id: string
  name: string
  website: string
  linkedin: string
}

interface ContactRecord {
  id: string
  personaLinkedin: string
}

export interface PreviewRow {
  rowNumber: number
  personLinkedin: string
  firstName: string
  lastName: string
  fullName: string
  title: string
  companyName: string
  companyWebsite: string
  companyLinkedin: string
}

interface CommitRow {
  rowNumber: number
  personLinkedin: string
  firstName: string
  fullName: string
  title: string
  companyId: string
}

type RowResultStatus = 'created' | 'duplicate' | 'failed'

interface CommitResult {
  rowNumber: number
  status: RowResultStatus
  contactId?: string
  error?: string
}

let schemaCache: { at: number; addedBy: string[] } | null = null
let companyCache: { at: number; records: CompanyRecord[] } | null = null
let contactCache: { at: number; records: ContactRecord[] } | null = null

const asString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

// The live select currently contains a handful of choices accidentally created
// from old CSV headers/values. Only person-like labels belong in the importer.
// Keep this defensive even after Airtable is cleaned up so typecast pollution
// cannot reappear in the SDR selector.
export function isPlausibleAddedBy(value: string): boolean {
  const name = value.trim()
  if (!/^[\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+){1,4}$/u.test(name)) return false
  return !/\b(company|contact|phone|email|owner|title|first|last)\b/i.test(name)
}

export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function parseUrl(value: string): URL | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
}

export function normalizeLinkedin(value: string): string {
  const url = parseUrl(value)
  if (!url) return ''
  let host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) host = 'linkedin.com'
  if (host !== 'linkedin.com') return ''
  const path = url.pathname.toLowerCase().replace(/\/+/g, '/').replace(/\/$/, '')
  return `${host}${path}`
}

export function isCleanPersonLinkedin(value: string): boolean {
  return /^linkedin\.com\/in\/[^/]+$/.test(normalizeLinkedin(value))
}

export function normalizeDomain(value: string): string {
  const url = parseUrl(value)
  if (!url) return ''
  return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
}

function field(record: { fields: Record<string, unknown> }, id: string): string {
  return asString(record.fields[id])
}

async function getImportSchema(force = false): Promise<{ addedBy: string[] }> {
  if (!force && schemaCache && Date.now() - schemaCache.at < CACHE_MS) {
    return { addedBy: schemaCache.addedBy }
  }
  const tables = await getAirtableSchema()
  const companies = tables.find((table) => table.id === AIRTABLE_IDS.companiesTable)
  const contacts = tables.find((table) => table.id === AIRTABLE_IDS.contactsTable)
  if (!companies || !contacts) {
    throw new AirtableError('Required Airtable Companies or Contacts table is missing', 503)
  }

  const expected = [
    [companies, AIRTABLE_IDS.companies.name, 'singleLineText'],
    [companies, AIRTABLE_IDS.companies.website, 'url'],
    [companies, AIRTABLE_IDS.companies.linkedin, 'url'],
    [contacts, AIRTABLE_IDS.contacts.personaLinkedin, 'url'],
    [contacts, AIRTABLE_IDS.contacts.approveStatus, 'singleSelect'],
    [contacts, AIRTABLE_IDS.contacts.fullName, 'singleLineText'],
    [contacts, AIRTABLE_IDS.contacts.firstName, 'singleLineText'],
    [contacts, AIRTABLE_IDS.contacts.title, 'singleLineText'],
    [contacts, AIRTABLE_IDS.contacts.company, 'multipleRecordLinks'],
    [contacts, AIRTABLE_IDS.contacts.addedBy, 'singleSelect'],
  ] as const
  for (const [table, fieldId, type] of expected) {
    const schemaField = table.fields.find((item) => item.id === fieldId)
    if (!schemaField || schemaField.type !== type) {
      throw new AirtableError(
        `Airtable schema mismatch for ${table.name}.${fieldId}; expected ${type}`,
        503,
      )
    }
  }

  const companyLink = contacts.fields.find((item) => item.id === AIRTABLE_IDS.contacts.company)
  if (companyLink?.options?.linkedTableId !== AIRTABLE_IDS.companiesTable) {
    throw new AirtableError('Contacts.Company no longer links to Companies', 503)
  }

  const approve = contacts.fields.find(
    (item) => item.id === AIRTABLE_IDS.contacts.approveStatus,
  )
  const approveChoices = approve?.options?.choices?.map((choice) => choice.name) ?? []
  if (!approveChoices.includes('New')) {
    throw new AirtableError('Contacts.Approve status is missing the New choice', 503)
  }

  const added = contacts.fields.find((item) => item.id === AIRTABLE_IDS.contacts.addedBy)
  const addedBy = (added?.options?.choices ?? [])
    .map((choice) => choice.name.trim())
    .filter(isPlausibleAddedBy)
  if (!addedBy.length) {
    throw new AirtableError('Contacts.Added by has no available choices', 503)
  }

  schemaCache = { at: Date.now(), addedBy }
  return { addedBy }
}

async function getCompanies(force = false): Promise<CompanyRecord[]> {
  if (!force && companyCache && Date.now() - companyCache.at < CACHE_MS) {
    return companyCache.records
  }
  const records = await listAllRecords(AIRTABLE_IDS.companiesTable, [
    AIRTABLE_IDS.companies.name,
    AIRTABLE_IDS.companies.website,
    AIRTABLE_IDS.companies.linkedin,
  ])
  const companies = records.map((record) => ({
    id: record.id,
    name: field(record, AIRTABLE_IDS.companies.name),
    website: field(record, AIRTABLE_IDS.companies.website),
    linkedin: field(record, AIRTABLE_IDS.companies.linkedin),
  }))
  companyCache = { at: Date.now(), records: companies }
  return companies
}

async function getContacts(force = false): Promise<ContactRecord[]> {
  if (!force && contactCache && Date.now() - contactCache.at < CONTACT_CACHE_MS) {
    return contactCache.records
  }
  const records = await listAllRecords(AIRTABLE_IDS.contactsTable, [
    AIRTABLE_IDS.contacts.personaLinkedin,
  ])
  const contacts = records.map((record) => ({
    id: record.id,
    personaLinkedin: field(record, AIRTABLE_IDS.contacts.personaLinkedin),
  }))
  contactCache = { at: Date.now(), records: contacts }
  return contacts
}

function toMap<T>(records: T[], key: (record: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const record of records) {
    const value = key(record)
    if (!value) continue
    const existing = result.get(value) ?? []
    existing.push(record)
    result.set(value, existing)
  }
  return result
}

function uniqueCompanies(groups: Array<CompanyRecord[] | undefined>): CompanyRecord[] {
  const found = new Map<string, CompanyRecord>()
  for (const group of groups) {
    for (const company of group ?? []) found.set(company.id, company)
  }
  return [...found.values()].slice(0, 10)
}

export function buildCompanyMaps(companies: CompanyRecord[]) {
  return {
    linkedin: toMap(companies, (company) => normalizeLinkedin(company.linkedin)),
    domain: toMap(companies, (company) => normalizeDomain(company.website)),
    name: toMap(companies, (company) => normalizeName(company.name)),
  }
}

export function companyMatch(
  row: PreviewRow,
  maps: {
    linkedin: Map<string, CompanyRecord[]>
    domain: Map<string, CompanyRecord[]>
    name: Map<string, CompanyRecord[]>
  },
) {
  const linkedinKey = normalizeLinkedin(row.companyLinkedin)
  const domainKey = normalizeDomain(row.companyWebsite)
  const nameKey = normalizeName(row.companyName)
  const linkedinMatches = linkedinKey ? maps.linkedin.get(linkedinKey) ?? [] : []
  const domainMatches = domainKey ? maps.domain.get(domainKey) ?? [] : []
  const nameMatches = nameKey ? maps.name.get(nameKey) ?? [] : []
  const suggestions = uniqueCompanies([linkedinMatches, domainMatches, nameMatches])

  if (linkedinMatches.length > 1 || domainMatches.length > 1) {
    return { status: 'company_action' as const, reason: 'ambiguous', suggestions }
  }

  const stable = new Map<string, { company: CompanyRecord; method: 'linkedin' | 'domain' }>()
  if (linkedinMatches.length === 1) {
    stable.set(linkedinMatches[0].id, { company: linkedinMatches[0], method: 'linkedin' })
  }
  if (domainMatches.length === 1) {
    stable.set(domainMatches[0].id, { company: domainMatches[0], method: 'domain' })
  }
  if (stable.size === 1) {
    const match = [...stable.values()][0]
    return {
      status: 'ready' as const,
      company: match.company,
      matchMethod: match.method,
      suggestions,
    }
  }
  if (stable.size > 1) {
    return { status: 'company_action' as const, reason: 'conflict', suggestions }
  }

  if (nameMatches.length === 1) {
    const candidate = nameMatches[0]
    const storedLinkedin = normalizeLinkedin(candidate.linkedin)
    const storedDomain = normalizeDomain(candidate.website)
    const stableConflict =
      (!!linkedinKey && !!storedLinkedin && linkedinKey !== storedLinkedin) ||
      (!!domainKey && !!storedDomain && domainKey !== storedDomain)
    if (!stableConflict) {
      return {
        status: 'ready' as const,
        company: candidate,
        matchMethod: 'name' as const,
        suggestions,
      }
    }
    return { status: 'company_action' as const, reason: 'conflict', suggestions }
  }
  if (nameMatches.length > 1) {
    return { status: 'company_action' as const, reason: 'ambiguous', suggestions }
  }
  return { status: 'company_action' as const, reason: 'not_found', suggestions }
}

function validPreviewRow(value: unknown): value is PreviewRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<PreviewRow>
  const strings = [
    row.personLinkedin,
    row.firstName,
    row.lastName,
    row.fullName,
    row.title,
    row.companyName,
    row.companyWebsite,
    row.companyLinkedin,
  ]
  return (
    typeof row.rowNumber === 'number' &&
    Number.isInteger(row.rowNumber) &&
    row.rowNumber > 1 &&
    strings.every((item) => typeof item === 'string' && item.length <= MAX_TEXT)
  )
}

async function metadata() {
  const schema = await getImportSchema()
  return json({
    ok: true,
    source: 'apollo',
    mappingVersion: 1,
    addedBy: schema.addedBy,
    limits: { maxRows: MAX_ROWS, maxFileBytes: 5_000_000 },
  })
}

async function preview(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    return json({ error: 'rows (non-empty array) is required' }, 400)
  }
  if (payload.rows.length > MAX_ROWS) {
    return json({ error: `too many rows (max ${MAX_ROWS})` }, 400)
  }
  if (!payload.rows.every(validPreviewRow)) {
    return json({ error: 'one or more preview rows are invalid' }, 400)
  }

  await getImportSchema()
  const [companies, contacts] = await Promise.all([getCompanies(), getContacts()])
  const companyMaps = buildCompanyMaps(companies)
  const contactMap = toMap(contacts, (contact) => normalizeLinkedin(contact.personaLinkedin))
  const seen = new Set<string>()

  const results = (payload.rows as PreviewRow[]).map((row) => {
    const personKey = normalizeLinkedin(row.personLinkedin)
    if (!isCleanPersonLinkedin(row.personLinkedin)) {
      return {
        rowNumber: row.rowNumber,
        status: 'invalid',
        reason: 'A clean public LinkedIn /in/ URL is required',
      }
    }
    if (!row.firstName.trim() || !row.fullName.trim() || !row.title.trim()) {
      return {
        rowNumber: row.rowNumber,
        status: 'invalid',
        reason: 'First name, full name, and title are required',
      }
    }
    if (seen.has(personKey)) {
      return {
        rowNumber: row.rowNumber,
        status: 'duplicate',
        reason: 'Duplicate person in this CSV',
      }
    }
    seen.add(personKey)
    const existing = contactMap.get(personKey) ?? []
    if (existing.length) {
      return {
        rowNumber: row.rowNumber,
        status: 'duplicate',
        reason: 'Contact already exists in Airtable',
        contactIds: existing.map((contact) => contact.id),
      }
    }
    return { rowNumber: row.rowNumber, ...companyMatch(row, companyMaps) }
  })

  return json({
    ok: true,
    results,
    counts: results.reduce<Record<string, number>>((counts, result) => {
      counts[result.status] = (counts[result.status] ?? 0) + 1
      return counts
    }, {}),
  })
}

async function searchCompanies(payload: Record<string, unknown>) {
  const query = asString(payload.query)
  if (query.length < 2 || query.length > 200) {
    return json({ error: 'query must contain 2–200 characters' }, 400)
  }
  await getImportSchema()
  const companies = await getCompanies()
  const qName = normalizeName(query)
  const qDomain = normalizeDomain(query)
  const qLinkedin = normalizeLinkedin(query)
  const directId = /^rec[a-zA-Z0-9]{14}$/.test(query) ? query : ''
  const matches = companies
    .filter((company) => {
      if (directId) return company.id === directId
      return (
        (!!qName && normalizeName(company.name).includes(qName)) ||
        (!!qDomain && normalizeDomain(company.website).includes(qDomain)) ||
        (!!qLinkedin && normalizeLinkedin(company.linkedin).includes(qLinkedin))
      )
    })
    .slice(0, 20)
  return json({ ok: true, companies: matches })
}

function validCommitRow(value: unknown): value is CommitRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<CommitRow>
  return (
    typeof row.rowNumber === 'number' &&
    Number.isInteger(row.rowNumber) &&
    row.rowNumber > 1 &&
    typeof row.personLinkedin === 'string' &&
    row.personLinkedin.length <= MAX_TEXT &&
    typeof row.firstName === 'string' &&
    row.firstName.length <= MAX_TEXT &&
    typeof row.fullName === 'string' &&
    row.fullName.length <= MAX_TEXT &&
    typeof row.title === 'string' &&
    row.title.length <= MAX_TEXT &&
    typeof row.companyId === 'string' &&
    /^rec[a-zA-Z0-9]{14}$/.test(row.companyId)
  )
}

async function commit(payload: Record<string, unknown>) {
  const addedBy = asString(payload.addedBy)
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    return json({ error: 'rows (non-empty array) is required' }, 400)
  }
  if (payload.rows.length > MAX_ROWS) {
    return json({ error: `too many rows (max ${MAX_ROWS})` }, 400)
  }
  if (!payload.rows.every(validCommitRow)) {
    return json({ error: 'one or more commit rows are invalid' }, 400)
  }

  const schema = await getImportSchema(true)
  if (!schema.addedBy.includes(addedBy)) {
    return json({ error: 'Added by must be one of the current Airtable choices' }, 400)
  }

  // Force fresh identity reads: preview caches make the UI fast, but they are
  // never the final authority for a write.
  const [companies, contacts] = await Promise.all([getCompanies(true), getContacts(true)])
  const companyIds = new Set(companies.map((company) => company.id))
  const contactMap = toMap(contacts, (contact) => normalizeLinkedin(contact.personaLinkedin))
  const results: CommitResult[] = []
  const valid: Array<{ row: CommitRow; fields: Record<string, unknown> }> = []
  const seen = new Set<string>()

  for (const row of payload.rows as CommitRow[]) {
    const personKey = normalizeLinkedin(row.personLinkedin)
    if (
      !isCleanPersonLinkedin(row.personLinkedin) ||
      !row.firstName.trim() ||
      !row.fullName.trim() ||
      !row.title.trim()
    ) {
      results.push({ rowNumber: row.rowNumber, status: 'failed', error: 'Required Contact fields are invalid' })
      continue
    }
    if (!companyIds.has(row.companyId)) {
      results.push({ rowNumber: row.rowNumber, status: 'failed', error: 'Selected Company no longer exists' })
      continue
    }
    if (seen.has(personKey)) {
      results.push({ rowNumber: row.rowNumber, status: 'duplicate', error: 'Duplicate person in this commit' })
      continue
    }
    seen.add(personKey)
    const existing = contactMap.get(personKey) ?? []
    if (existing.length) {
      results.push({
        rowNumber: row.rowNumber,
        status: 'duplicate',
        contactId: existing[0].id,
        error: 'Contact already exists in Airtable',
      })
      continue
    }

    const canonicalUrl = `https://www.${personKey}/`
    valid.push({
      row,
      fields: {
        [AIRTABLE_IDS.contacts.personaLinkedin]: canonicalUrl,
        [AIRTABLE_IDS.contacts.fullName]: row.fullName.trim(),
        [AIRTABLE_IDS.contacts.firstName]: row.firstName.trim(),
        [AIRTABLE_IDS.contacts.title]: row.title.trim(),
        [AIRTABLE_IDS.contacts.company]: [row.companyId],
        [AIRTABLE_IDS.contacts.addedBy]: addedBy,
        [AIRTABLE_IDS.contacts.approveStatus]: 'New',
      },
    })
  }

  for (let index = 0; index < valid.length; index += 10) {
    const chunk = valid.slice(index, index + 10)
    try {
      const created = await createRecords(
        AIRTABLE_IDS.contactsTable,
        chunk.map((item) => item.fields),
      )
      chunk.forEach((item, itemIndex) => {
        const record = created[itemIndex]
        if (record) {
          results.push({
            rowNumber: item.row.rowNumber,
            status: 'created',
            contactId: record.id,
          })
        } else {
          results.push({
            rowNumber: item.row.rowNumber,
            status: 'failed',
            error: 'Airtable did not return the created record',
          })
        }
      })
    } catch (error) {
      // A single invalid Airtable row rejects its whole 10-row request. Retry
      // one-by-one only for a definitive non-rate-limit 4xx so good rows still
      // land and the result identifies the bad row. A network/5xx failure has an
      // uncertain outcome; marking the chunk failed lets the user's retry run a
      // fresh duplicate check before any second create attempt.
      const canIsolate =
        error instanceof AirtableError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      if (!canIsolate) {
        for (const item of chunk) {
          results.push({
            rowNumber: item.row.rowNumber,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
        }
        continue
      }
      for (const item of chunk) {
        try {
          const [created] = await createRecords(AIRTABLE_IDS.contactsTable, [item.fields])
          results.push({
            rowNumber: item.row.rowNumber,
            status: 'created',
            contactId: created?.id,
          })
        } catch (singleError) {
          results.push({
            rowNumber: item.row.rowNumber,
            status: 'failed',
            error: singleError instanceof Error ? singleError.message : String(singleError),
          })
        }
      }
    }
  }

  contactCache = null
  results.sort((a, b) => a.rowNumber - b.rowNumber)
  const counts = results.reduce<Record<RowResultStatus, number>>(
    (summary, result) => {
      summary[result.status]++
      return summary
    },
    { created: 0, duplicate: 0, failed: 0 },
  )
  return json({ ok: true, results, counts })
}

export async function handleContactImport(
  action: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  try {
    if (action === 'contact_metadata') return await metadata()
    if (action === 'contact_preview') return await preview(payload)
    if (action === 'company_search') return await searchCompanies(payload)
    if (action === 'contact_commit') return await commit(payload)
    return json({ error: 'unknown contact import action' }, 400)
  } catch (error) {
    if (error instanceof AirtableError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502
      return json({ error: error.message, retryable: error.retryable }, status)
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
}
