// Companies upload → Airtable DB. New companies are created in DB with
// `Initial status = New` for SDRs to approve there; Airtable automations copy
// approved rows into Companies. Nothing here reads DB in full, and nothing
// writes Companies — `createRecords` refuses that table outright.
//
// The dedupe key is the normalized domain. A domain already in DB (any status)
// or in Companies, or repeated earlier in the same file, is skipped and
// reported with where it was found. A name-only match is a warning: the row is
// still created unless the user unticks it.
import { DOMAIN_ISSUE_LABEL, parseDomain } from '../../src/lib/domain.js'
import { AIRTABLE_IDS, AirtableError, getAirtableSchema } from './airtable.js'
import {
  CACHE_MS,
  COMPANIES_SCHEMA,
  asString,
  buildCompanyMaps,
  canonicalCompanyLinkedin,
  choicesOf,
  createAll,
  errorResponse,
  findDbByDomains,
  findDbByNames,
  getCompanies,
  importAddedByChoices,
  json,
  normalizeName,
  requireFields,
  type CompanyMaps,
  type CompanyRecord,
  type DbRecord,
} from './airtableDirectory.js'

const MAX_ROWS = 500

const LIMITS = {
  companyName: 500,
  website: 2048,
  linkedin: 2048,
  country: 500,
  employees: 20,
  foundedYear: 20,
  industry: 500,
  keywords: 10_000,
  description: 10_000,
} as const

export interface CompanyImportRow {
  rowNumber: number
  companyName: string
  website: string
  linkedin: string
  country: string
  employees: string
  foundedYear: string
  industry: string
  keywords: string
  description: string
}

/** Where an identical domain (or, for a warning, an identical name) already is. */
export interface CompanyLocation {
  table: 'DB' | 'Companies' | 'File'
  id?: string
  rowNumber?: number
  name: string
  website: string
  /** DB `Initial status` or Companies `Approve Status`; blank when unset. */
  status: string
}

export type CompanyPreviewStatus = 'ready' | 'name_match' | 'duplicate' | 'invalid'

export interface CompanyPreviewResult {
  rowNumber: number
  status: CompanyPreviewStatus
  domain: string
  reason?: string
  matches?: CompanyLocation[]
}

interface CommitResult {
  rowNumber: number
  status: 'created' | 'duplicate' | 'failed'
  domain: string
  recordId?: string
  error?: string
  matches?: CompanyLocation[]
}

let schemaCache: { at: number; addedBy: string[] } | null = null

async function getImportSchema(force = false): Promise<{ addedBy: string[] }> {
  if (!force && schemaCache && Date.now() - schemaCache.at < CACHE_MS) {
    return { addedBy: schemaCache.addedBy }
  }
  const tables = await getAirtableSchema()
  const db = tables.find((table) => table.id === AIRTABLE_IDS.dbTable)
  const companies = tables.find((table) => table.id === AIRTABLE_IDS.companiesTable)
  if (!db || !companies) {
    throw new AirtableError('Required Airtable DB or Companies table is missing', 503)
  }

  requireFields(db, [
    [AIRTABLE_IDS.db.website, 'url'],
    [AIRTABLE_IDS.db.name, 'singleLineText'],
    [AIRTABLE_IDS.db.linkedin, 'url'],
    [AIRTABLE_IDS.db.country, 'singleLineText'],
    [AIRTABLE_IDS.db.foundedYear, 'number'],
    [AIRTABLE_IDS.db.employees, 'number'],
    [AIRTABLE_IDS.db.industry, 'singleLineText'],
    [AIRTABLE_IDS.db.keywords, 'multilineText'],
    [AIRTABLE_IDS.db.description, 'multilineText'],
    [AIRTABLE_IDS.db.initialStatus, 'singleSelect'],
    [AIRTABLE_IDS.db.addedToCompanies, 'singleSelect'],
    [AIRTABLE_IDS.db.addedBy, 'singleSelect'],
  ])
  requireFields(companies, COMPANIES_SCHEMA)

  if (!choicesOf(db, AIRTABLE_IDS.db.initialStatus).includes('New')) {
    throw new AirtableError('DB.Initial status is missing the New choice', 503)
  }
  const addedBy = importAddedByChoices(choicesOf(db, AIRTABLE_IDS.db.addedBy))
  if (!addedBy.length) throw new AirtableError('DB.Added by has no available choices', 503)

  schemaCache = { at: Date.now(), addedBy }
  return { addedBy }
}

function validRow(value: unknown): value is CompanyImportRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<CompanyImportRow>
  if (typeof row.rowNumber !== 'number' || !Number.isInteger(row.rowNumber) || row.rowNumber <= 1) {
    return false
  }
  return (Object.keys(LIMITS) as Array<keyof typeof LIMITS>).every(
    (key) => typeof row[key] === 'string' && row[key]!.length <= LIMITS[key],
  )
}

function rowsOrError(payload: Record<string, unknown>): CompanyImportRow[] | Response {
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    return json({ error: 'rows (non-empty array) is required' }, 400)
  }
  if (payload.rows.length > MAX_ROWS) {
    return json({ error: `too many rows (max ${MAX_ROWS})` }, 400)
  }
  if (!payload.rows.every(validRow)) {
    return json({ error: 'one or more Company rows are invalid' }, 400)
  }
  return payload.rows as CompanyImportRow[]
}

/** A whole number in range, or `null` — out-of-range values are left blank, not refused. */
function optionalInteger(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

function rowIssue(row: CompanyImportRow): string | null {
  if (!row.companyName.trim()) return 'Company name is required'
  const { issue } = parseDomain(row.website)
  return issue ? DOMAIN_ISSUE_LABEL[issue] : null
}

const fromDb = (record: DbRecord): CompanyLocation => ({
  table: 'DB',
  id: record.id,
  name: record.name,
  website: record.website,
  status: record.status,
})

const fromCompanies = (record: CompanyRecord): CompanyLocation => ({
  table: 'Companies',
  id: record.id,
  name: record.name,
  website: record.website,
  status: record.approveStatus,
})

interface Directory {
  maps: CompanyMaps
  dbByDomain: Map<string, DbRecord[]>
  dbByName?: Map<string, DbRecord[]>
}

/** Existing homes of this domain in DB and Companies, DB first. */
function domainMatches(domain: string, directory: Directory): CompanyLocation[] {
  return [
    ...(directory.dbByDomain.get(domain) ?? []).map(fromDb),
    ...(directory.maps.domain.get(domain) ?? []).map(fromCompanies),
  ]
}

function nameMatches(name: string, directory: Directory): CompanyLocation[] {
  const key = normalizeName(name)
  if (!key) return []
  return [
    ...(directory.dbByName?.get(key) ?? []).map(fromDb),
    ...(directory.maps.name.get(key) ?? []).map(fromCompanies),
  ]
}

/**
 * The classification both preview and commit apply, in order: invalid row,
 * repeat of an earlier row in the same upload, domain already in DB or
 * Companies, name-only match (a warning), new.
 */
export function classifyCompanyRows(
  rows: CompanyImportRow[],
  directory: Directory,
): CompanyPreviewResult[] {
  const firstRowByDomain = new Map<string, CompanyImportRow>()
  return rows.map((row) => {
    const issue = rowIssue(row)
    const domain = parseDomain(row.website).domain
    if (issue) return { rowNumber: row.rowNumber, status: 'invalid', domain, reason: issue }

    const earlier = firstRowByDomain.get(domain)
    if (earlier) {
      return {
        rowNumber: row.rowNumber,
        status: 'duplicate',
        domain,
        reason: `Repeats row ${earlier.rowNumber} of this file`,
        matches: [{
          table: 'File',
          rowNumber: earlier.rowNumber,
          name: earlier.companyName,
          website: earlier.website,
          status: '',
        }],
      }
    }
    firstRowByDomain.set(domain, row)

    const existing = domainMatches(domain, directory)
    if (existing.length) {
      return {
        rowNumber: row.rowNumber,
        status: 'duplicate',
        domain,
        reason: 'This domain is already in Airtable',
        matches: existing,
      }
    }
    const byName = nameMatches(row.companyName, directory)
    if (byName.length) {
      return {
        rowNumber: row.rowNumber,
        status: 'name_match',
        domain,
        reason: 'A company with the same name but a different domain is already in Airtable',
        matches: byName,
      }
    }
    return { rowNumber: row.rowNumber, status: 'ready', domain }
  })
}

export function dbFields(row: CompanyImportRow, addedBy: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    [AIRTABLE_IDS.db.website]: parseDomain(row.website).domain,
    [AIRTABLE_IDS.db.name]: row.companyName.trim(),
    [AIRTABLE_IDS.db.initialStatus]: 'New',
    [AIRTABLE_IDS.db.addedBy]: addedBy,
  }
  const strings = [
    [AIRTABLE_IDS.db.linkedin, canonicalCompanyLinkedin(row.linkedin)],
    [AIRTABLE_IDS.db.country, row.country],
    [AIRTABLE_IDS.db.industry, row.industry],
    [AIRTABLE_IDS.db.keywords, row.keywords],
    [AIRTABLE_IDS.db.description, row.description],
  ] as const
  for (const [fieldId, value] of strings) {
    if (value.trim()) fields[fieldId] = value.trim()
  }
  const employees = optionalInteger(row.employees, 0, 10_000_000)
  const foundedYear = optionalInteger(row.foundedYear, 1700, new Date().getUTCFullYear() + 1)
  if (employees !== null) fields[AIRTABLE_IDS.db.employees] = employees
  if (foundedYear !== null) fields[AIRTABLE_IDS.db.foundedYear] = foundedYear
  return fields
}

function uploadDomains(rows: CompanyImportRow[]): string[] {
  return rows.map((row) => parseDomain(row.website).domain).filter(Boolean)
}

async function metadata() {
  const schema = await getImportSchema()
  return json({
    ok: true,
    target: 'db',
    addedBy: schema.addedBy,
    limits: { maxRows: MAX_ROWS, maxFileBytes: 5_000_000 },
  })
}

async function preview(payload: Record<string, unknown>) {
  const rows = rowsOrError(payload)
  if (rows instanceof Response) return rows

  await getImportSchema()
  const [companies, dbByDomain, dbByName] = await Promise.all([
    getCompanies(),
    findDbByDomains(uploadDomains(rows)),
    findDbByNames(rows.map((row) => row.companyName)),
  ])
  const results = classifyCompanyRows(rows, {
    maps: buildCompanyMaps(companies),
    dbByDomain,
    dbByName,
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

async function commit(payload: Record<string, unknown>) {
  const addedBy = asString(payload.addedBy)
  const rows = rowsOrError(payload)
  if (rows instanceof Response) return rows

  const schema = await getImportSchema(true)
  if (!schema.addedBy.includes(addedBy)) {
    return json({ error: 'Added by must be one of the current DB choices' }, 400)
  }

  // DB has no uniqueness constraint, so the duplicate check is re-run against
  // fresh reads immediately before creating. Preview results are never trusted.
  const [companies, dbByDomain] = await Promise.all([
    getCompanies(true),
    findDbByDomains(uploadDomains(rows)),
  ])
  const classified = classifyCompanyRows(rows, { maps: buildCompanyMaps(companies), dbByDomain })

  const results: CommitResult[] = []
  const creatable: CompanyImportRow[] = []
  classified.forEach((result, index) => {
    if (result.status === 'invalid') {
      results.push({ rowNumber: result.rowNumber, status: 'failed', domain: result.domain, error: result.reason })
    } else if (result.status === 'duplicate') {
      results.push({
        rowNumber: result.rowNumber,
        status: 'duplicate',
        domain: result.domain,
        error: result.reason,
        matches: result.matches,
      })
    } else {
      creatable.push(rows[index])
    }
  })

  const outcomes = await createAll(AIRTABLE_IDS.dbTable, creatable, (row) => dbFields(row, addedBy))
  for (const outcome of outcomes) {
    const domain = parseDomain(outcome.item.website).domain
    results.push(
      outcome.id
        ? { rowNumber: outcome.item.rowNumber, status: 'created', domain, recordId: outcome.id }
        : { rowNumber: outcome.item.rowNumber, status: 'failed', domain, error: outcome.error },
    )
  }

  results.sort((a, b) => a.rowNumber - b.rowNumber)
  const counts = results.reduce(
    (summary, result) => {
      summary[result.status]++
      return summary
    },
    { created: 0, duplicate: 0, failed: 0 },
  )
  return json({ ok: true, results, counts })
}

export async function handleCompanyImport(
  action: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  try {
    if (action === 'company_metadata') return await metadata()
    if (action === 'company_preview') return await preview(payload)
    if (action === 'company_commit') return await commit(payload)
    return json({ error: 'unknown Company import action' }, 400)
  } catch (error) {
    return errorResponse(error)
  }
}

