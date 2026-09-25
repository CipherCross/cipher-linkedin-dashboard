// Shared lookups for the two CSV importers: how a company is identified, where
// it already is (DB or Companies), and how records are created.
//
// Companies (≈5k rows) is read in full and cached, because lead → company
// matching needs every record. DB (≈22k rows) is never read in full — that is
// ~218 pages, about 50 s at the adapter's request gap, against a 60 s function
// budget. DB is queried only for the domains and names in the upload, with a
// formula that over-matches on purpose; the exact comparison happens here,
// through the same normalizer the browser uses.
import { domainToUnicode } from 'node:url'
import { normalizeDomain } from '../../src/lib/domain.js'
import {
  AIRTABLE_IDS,
  AirtableError,
  createRecords,
  findRecordsByFormula,
  formulaString,
  listAllRecords,
  type AirtableFieldSchema,
  type AirtableRecord,
  type AirtableTableSchema,
} from './airtable.js'

export { normalizeDomain }

export const CACHE_MS = 5 * 60_000
export const RECORD_ID = /^rec[a-zA-Z0-9]{14}$/

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })

export function errorResponse(error: unknown): Response {
  if (error instanceof AirtableError) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 502
    return json({ error: error.message, retryable: error.retryable }, status)
  }
  return json({ error: error instanceof Error ? error.message : String(error) }, 500)
}

export const asString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

function field(record: { fields: Record<string, unknown> }, id: string): string {
  const value = record.fields[id]
  if (typeof value === 'string') return value.trim()
  // A singleSelect read back by field ID can arrive as { name } on some
  // endpoints; accept both shapes.
  if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
    return (value as { name: string }).name.trim()
  }
  return ''
}

// ---------------------------------------------------------------- identity keys

export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
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

/** `linkedin.com/<path>` in lower case, or `''` for anything not on LinkedIn. */
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

/**
 * A company page key: `linkedin.com/company/<id or slug>`. Accepts a full URL
 * (`/company/109209384/about`) or the bare ID an export puts in its
 * "Unique ID" column.
 */
export function companyLinkedinKey(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^[a-z0-9_%-]+$/i.test(trimmed)) return `linkedin.com/company/${trimmed.toLowerCase()}`
  const match = /^linkedin\.com\/(company|school|showcase)\/([^/]+)/.exec(normalizeLinkedin(trimmed))
  return match ? `linkedin.com/${match[1]}/${match[2]}` : ''
}

export function canonicalCompanyLinkedin(value: string): string {
  const key = companyLinkedinKey(value)
  return key ? `https://www.${key}/` : ''
}

// ------------------------------------------------------------------- schema

export function requireFields(
  table: AirtableTableSchema,
  expected: ReadonlyArray<readonly [string, string]>,
) {
  for (const [fieldId, type] of expected) {
    const schemaField = table.fields.find((item) => item.id === fieldId)
    if (!schemaField || schemaField.type !== type) {
      throw new AirtableError(
        `Airtable schema mismatch for ${table.name}.${fieldId}; expected ${type}`,
        503,
      )
    }
  }
}

export function choicesOf(table: AirtableTableSchema, fieldId: string): string[] {
  const schemaField: AirtableFieldSchema | undefined = table.fields.find((item) => item.id === fieldId)
  return (schemaField?.options?.choices ?? []).map((choice) => choice.name)
}

/**
 * The live select fields contain choices accidentally created from old CSV
 * headers and values. Only person-like labels belong in the "Added by" picker,
 * and since nothing is written with typecast, a label must already exist in
 * that table's own choices to be offered at all.
 */
export function isPlausibleAddedBy(value: string): boolean {
  const name = value.trim()
  if (/^David$/iu.test(name)) return true
  if (!/^[\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+){1,4}$/u.test(name)) return false
  return !/\b(company|contact|phone|email|owner|title|first|last)\b/i.test(name)
}

export function importAddedByChoices(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(isPlausibleAddedBy))]
}

export const COMPANIES_SCHEMA = [
  [AIRTABLE_IDS.companies.name, 'singleLineText'],
  [AIRTABLE_IDS.companies.website, 'url'],
  [AIRTABLE_IDS.companies.linkedin, 'url'],
  [AIRTABLE_IDS.companies.approveStatus, 'singleSelect'],
] as const

// ---------------------------------------------------------------- Companies

export interface CompanyRecord {
  id: string
  name: string
  website: string
  linkedin: string
  /** `Approve Status`: New, Approved, Rejected, Edits, or blank. */
  approveStatus: string
}

export const isRejected = (status: string) => status.trim().toLowerCase() === 'rejected'

let companyCache: { at: number; records: CompanyRecord[] } | null = null

const COMPANY_FIELDS = [
  AIRTABLE_IDS.companies.name,
  AIRTABLE_IDS.companies.website,
  AIRTABLE_IDS.companies.linkedin,
  AIRTABLE_IDS.companies.approveStatus,
] as const

export function companyFromRecord(record: AirtableRecord): CompanyRecord {
  return {
    id: record.id,
    name: field(record, AIRTABLE_IDS.companies.name),
    website: field(record, AIRTABLE_IDS.companies.website),
    linkedin: field(record, AIRTABLE_IDS.companies.linkedin),
    approveStatus: field(record, AIRTABLE_IDS.companies.approveStatus),
  }
}

/** Every Companies record. Cached for previews; `force` for anything that writes. */
export async function getCompanies(force = false): Promise<CompanyRecord[]> {
  if (!force && companyCache && Date.now() - companyCache.at < CACHE_MS) {
    return companyCache.records
  }
  const records = (await listAllRecords(AIRTABLE_IDS.companiesTable, COMPANY_FIELDS)).map(
    companyFromRecord,
  )
  companyCache = { at: Date.now(), records }
  return records
}

export function resetDirectoryCache() {
  companyCache = null
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

export interface CompanyMaps {
  domain: Map<string, CompanyRecord[]>
  linkedin: Map<string, CompanyRecord[]>
  name: Map<string, CompanyRecord[]>
}

export function buildCompanyMaps(companies: CompanyRecord[]): CompanyMaps {
  return {
    domain: toMap(companies, (company) => normalizeDomain(company.website)),
    linkedin: toMap(companies, (company) => companyLinkedinKey(company.linkedin)),
    name: toMap(companies, (company) => normalizeName(company.name)),
  }
}

// ----------------------------------------------------------------------- DB

export interface DbRecord {
  id: string
  name: string
  website: string
  domain: string
  /** `Initial status`: New, Manual review, Manual approve, Approve, Rejected, Old, or blank. */
  status: string
  addedToCompanies: boolean
}

const DB_FIELDS = [
  AIRTABLE_IDS.db.website,
  AIRTABLE_IDS.db.name,
  AIRTABLE_IDS.db.initialStatus,
  AIRTABLE_IDS.db.addedToCompanies,
] as const

function dbFromRecord(record: AirtableRecord): DbRecord {
  const website = field(record, AIRTABLE_IDS.db.website)
  return {
    id: record.id,
    name: field(record, AIRTABLE_IDS.db.name),
    website,
    domain: normalizeDomain(website),
    status: field(record, AIRTABLE_IDS.db.initialStatus),
    addedToCompanies: field(record, AIRTABLE_IDS.db.addedToCompanies).toLowerCase() === 'added',
  }
}

const DOMAINS_PER_QUERY = 100
const NAME_FORMULA_BUDGET = 8_000

/**
 * A prefilter that matches every DB website whose host could normalize to one
 * of `domains`: the domain preceded by start, `/`, `.` or `@` and followed by
 * end, `/`, `:`, `?`, `#` or `.`. It deliberately over-matches (subdomains,
 * `acme.com.au` for `acme.com`); the exact comparison is `normalizeDomain`.
 * Domains are already `[a-z0-9.-]` (plus the Unicode form of an IDN), so the
 * only character to escape is `.`.
 */
export function domainFormula(domains: string[]): string {
  // An IDN domain arrives as punycode, but a stored website may hold its
  // Unicode spelling, so both forms are matched. Unicode letters are not regex
  // syntax; a stray quote or backslash cannot survive `normalizeDomain`.
  const forms = domains.flatMap((domain) => {
    const unicode = domain.includes('xn--') ? domainToUnicode(domain) : ''
    return unicode && unicode !== domain ? [domain, unicode] : [domain]
  })
  const alternatives = forms.map((domain) => domain.replace(/\./g, '[.]')).join('|')
  return `REGEX_MATCH(LOWER({${AIRTABLE_IDS.db.website}}&""), "(^|[/.@])(${alternatives})([/:?#.]|$)")`
}

export function nameFormula(names: string[]): string {
  const list = `|${names.join('|')}|`
  return `FIND("|"&LOWER(TRIM({${AIRTABLE_IDS.db.name}}&""))&"|", ${formulaString(list, 1_000_000)})`
}

/** Lower-case, trimmed, pipe-free and capped: the form `nameFormula` compares. */
function formulaName(value: string): string {
  return value.trim().toLowerCase().replace(/[|\u0000-\u001f\u007f]+/g, ' ').slice(0, 200)
}

/** DB rows whose `Company Website` normalizes to one of `domains`. */
export async function findDbByDomains(domains: string[]): Promise<Map<string, DbRecord[]>> {
  const wanted = [...new Set(domains.map(normalizeDomain).filter(Boolean))]
  const found = new Map<string, DbRecord>()
  for (let index = 0; index < wanted.length; index += DOMAINS_PER_QUERY) {
    const chunk = wanted.slice(index, index + DOMAINS_PER_QUERY)
    for (const record of await findRecordsByFormula(AIRTABLE_IDS.dbTable, domainFormula(chunk), DB_FIELDS)) {
      found.set(record.id, dbFromRecord(record))
    }
  }
  const wantedSet = new Set(wanted)
  return toMap(
    [...found.values()].filter((record) => wantedSet.has(record.domain)),
    (record) => record.domain,
  )
}

/** DB rows whose `Company name` equals one of `names` after `normalizeName`. */
export async function findDbByNames(names: string[]): Promise<Map<string, DbRecord[]>> {
  const wanted = [...new Set(names.map(formulaName).filter(Boolean))]
  const chunks: string[][] = []
  let current: string[] = []
  let length = 0
  for (const name of wanted) {
    if (current.length && length + name.length + 1 > NAME_FORMULA_BUDGET) {
      chunks.push(current)
      current = []
      length = 0
    }
    current.push(name)
    length += name.length + 1
  }
  if (current.length) chunks.push(current)

  const found = new Map<string, DbRecord>()
  for (const chunk of chunks) {
    for (const record of await findRecordsByFormula(AIRTABLE_IDS.dbTable, nameFormula(chunk), DB_FIELDS)) {
      found.set(record.id, dbFromRecord(record))
    }
  }
  const wantedKeys = new Set(names.map(normalizeName).filter(Boolean))
  return toMap(
    [...found.values()].filter((record) => wantedKeys.has(normalizeName(record.name))),
    (record) => normalizeName(record.name),
  )
}

// ------------------------------------------------------------------ writing

export interface CreateOutcome<T> {
  item: T
  id?: string
  error?: string
}

/**
 * Creates one record per item, ten per request. A single invalid row rejects
 * its whole request, so a definitive non-rate-limit 4xx is retried one by one
 * to land the good rows and name the bad one. A network or 5xx failure has an
 * uncertain outcome; those items are marked failed so the user's retry runs a
 * fresh duplicate check before any second attempt.
 */
export async function createAll<T>(
  tableId: string,
  items: T[],
  fieldsOf: (item: T) => Record<string, unknown>,
): Promise<Array<CreateOutcome<T>>> {
  const outcomes: Array<CreateOutcome<T>> = []
  for (let index = 0; index < items.length; index += 10) {
    const chunk = items.slice(index, index + 10)
    try {
      const created = await createRecords(tableId, chunk.map(fieldsOf))
      chunk.forEach((item, itemIndex) => {
        const record = created[itemIndex]
        outcomes.push(
          record ? { item, id: record.id } : { item, error: 'Airtable did not return the created record' },
        )
      })
    } catch (error) {
      const canIsolate =
        error instanceof AirtableError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      if (!canIsolate) {
        const message = error instanceof Error ? error.message : String(error)
        for (const item of chunk) outcomes.push({ item, error: message })
        continue
      }
      for (const item of chunk) {
        try {
          const [created] = await createRecords(tableId, [fieldsOf(item)])
          outcomes.push(
            created ? { item, id: created.id } : { item, error: 'Airtable did not return the created record' },
          )
        } catch (singleError) {
          outcomes.push({
            item,
            error: singleError instanceof Error ? singleError.message : String(singleError),
          })
        }
      }
    }
  }
  return outcomes
}
