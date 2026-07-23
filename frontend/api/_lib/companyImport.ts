import {
  AIRTABLE_IDS,
  AirtableError,
  createRecords,
  getAirtableSchema,
  listAllRecords,
} from './airtable.js'
import {
  buildCompanyMaps,
  isPlausibleAddedBy,
  normalizeDomain,
  normalizeLinkedin,
  normalizeName,
} from './contactImport.js'

const MAX_ROWS = 500
const CACHE_MS = 5 * 60_000

const LIMITS = {
  companyName: 500,
  mailingName: 500,
  employees: 20,
  industry: 500,
  website: 2048,
  linkedin: 2048,
  country: 500,
  keywords: 10_000,
  description: 10_000,
  foundedYear: 20,
} as const

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })

export interface CompanyImportRow {
  rowNumber: number
  companyName: string
  mailingName: string
  employees: string
  industry: string
  website: string
  linkedin: string
  country: string
  keywords: string
  description: string
  foundedYear: string
}

interface CompanyCommitRow extends CompanyImportRow {
  allowNameDuplicate: boolean
}

export interface CompanyRecord {
  id: string
  name: string
  website: string
  linkedin: string
}

interface CommitResult {
  rowNumber: number
  status: 'created' | 'duplicate' | 'failed'
  companyId?: string
  error?: string
}

type CompanyMaps = ReturnType<typeof buildCompanyMaps>

let schemaCache: { at: number; addedBy: string[] } | null = null
let companyCache: { at: number; records: CompanyRecord[] } | null = null

const asString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

function field(record: { fields: Record<string, unknown> }, id: string): string {
  return asString(record.fields[id])
}

async function getImportSchema(force = false): Promise<{ addedBy: string[] }> {
  if (!force && schemaCache && Date.now() - schemaCache.at < CACHE_MS) {
    return { addedBy: schemaCache.addedBy }
  }
  const tables = await getAirtableSchema()
  const companies = tables.find((table) => table.id === AIRTABLE_IDS.companiesTable)
  if (!companies) throw new AirtableError('Required Airtable Companies table is missing', 503)

  const expected = [
    [AIRTABLE_IDS.companies.name, 'singleLineText'],
    [AIRTABLE_IDS.companies.mailingName, 'singleLineText'],
    [AIRTABLE_IDS.companies.website, 'url'],
    [AIRTABLE_IDS.companies.linkedin, 'url'],
    [AIRTABLE_IDS.companies.country, 'singleLineText'],
    [AIRTABLE_IDS.companies.foundedYear, 'number'],
    [AIRTABLE_IDS.companies.employees, 'number'],
    [AIRTABLE_IDS.companies.industry, 'singleLineText'],
    [AIRTABLE_IDS.companies.keywords, 'multilineText'],
    [AIRTABLE_IDS.companies.description, 'richText'],
    [AIRTABLE_IDS.companies.approveStatus, 'singleSelect'],
    [AIRTABLE_IDS.companies.addedBy, 'singleSelect'],
  ] as const
  for (const [fieldId, type] of expected) {
    const schemaField = companies.fields.find((item) => item.id === fieldId)
    if (!schemaField || schemaField.type !== type) {
      throw new AirtableError(
        `Airtable schema mismatch for ${companies.name}.${fieldId}; expected ${type}`,
        503,
      )
    }
  }

  const approve = companies.fields.find(
    (item) => item.id === AIRTABLE_IDS.companies.approveStatus,
  )
  if (!(approve?.options?.choices ?? []).some((choice) => choice.name === 'New')) {
    throw new AirtableError('Companies.Approve Status is missing the New choice', 503)
  }
  const added = companies.fields.find((item) => item.id === AIRTABLE_IDS.companies.addedBy)
  const addedBy = (added?.options?.choices ?? [])
    .map((choice) => choice.name.trim())
    .filter(isPlausibleAddedBy)
  if (!addedBy.length) {
    throw new AirtableError('Companies.Added by has no available choices', 503)
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

function uniqueCompanies(groups: Array<CompanyRecord[] | undefined>): CompanyRecord[] {
  const found = new Map<string, CompanyRecord>()
  for (const group of groups) {
    for (const company of group ?? []) found.set(company.id, company)
  }
  return [...found.values()].slice(0, 20)
}

function optionalInteger(value: string, label: string, min: number, max: number): number | null {
  if (!value.trim()) return null
  if (!/^\d+$/.test(value.trim())) throw new Error(`${label} must be a whole number`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`)
  }
  return parsed
}

function validateRow(row: CompanyImportRow): string | null {
  if (!row.companyName.trim()) return 'Company name is required'
  if (row.website && !normalizeDomain(row.website)) return 'Website URL is invalid'
  const linkedin = row.linkedin ? normalizeLinkedin(row.linkedin) : ''
  if (row.linkedin && !/^linkedin\.com\/company\/[^/]+/.test(linkedin)) {
    return 'A public LinkedIn /company/ URL is required'
  }
  try {
    optionalInteger(row.employees, 'Employees', 0, 10_000_000)
    optionalInteger(row.foundedYear, 'Founded year', 1700, new Date().getUTCFullYear() + 1)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return null
}

function validRow(value: unknown): value is CompanyImportRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<CompanyImportRow>
  if (
    typeof row.rowNumber !== 'number' ||
    !Number.isInteger(row.rowNumber) ||
    row.rowNumber <= 1
  ) {
    return false
  }
  return (Object.keys(LIMITS) as Array<keyof typeof LIMITS>).every(
    (key) => typeof row[key] === 'string' && row[key]!.length <= LIMITS[key],
  )
}

function canonicalWebsite(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  url.protocol = 'https:'
  return url.toString()
}

function canonicalLinkedin(value: string): string {
  const normalized = normalizeLinkedin(value)
  return normalized ? `https://www.${normalized}/` : ''
}

export function classifyCompanyRow(row: CompanyImportRow, maps: CompanyMaps) {
  const linkedinKey = normalizeLinkedin(row.linkedin)
  const domainKey = normalizeDomain(row.website)
  const nameKey = normalizeName(row.companyName)
  const linkedinMatches = linkedinKey ? maps.linkedin.get(linkedinKey) ?? [] : []
  const domainMatches = domainKey ? maps.domain.get(domainKey) ?? [] : []
  const nameMatches = nameKey ? maps.name.get(nameKey) ?? [] : []
  const suggestions = uniqueCompanies([linkedinMatches, domainMatches, nameMatches])

  if (linkedinMatches.length > 1 || domainMatches.length > 1) {
    return {
      status: 'company_action' as const,
      reason: 'ambiguous',
      suggestions,
      canCreate: false,
    }
  }

  const stable = new Map<string, { company: CompanyRecord; method: 'linkedin' | 'domain' }>()
  if (linkedinMatches.length === 1) {
    stable.set(linkedinMatches[0].id, { company: linkedinMatches[0], method: 'linkedin' })
  }
  if (domainMatches.length === 1) {
    stable.set(domainMatches[0].id, { company: domainMatches[0], method: 'domain' })
  }
  if (stable.size > 1) {
    return {
      status: 'company_action' as const,
      reason: 'conflict',
      suggestions,
      canCreate: false,
    }
  }
  if (stable.size === 1) {
    const match = [...stable.values()][0]
    return {
      status: 'duplicate' as const,
      reason: 'Company already exists in Airtable',
      company: match.company,
      matchMethod: match.method,
      suggestions,
      canCreate: false,
    }
  }

  if (nameMatches.length) {
    return {
      status: 'company_action' as const,
      reason: 'name_match',
      suggestions,
      canCreate: true,
    }
  }
  return { status: 'ready' as const, canCreate: true }
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
  if (!payload.rows.every(validRow)) {
    return json({ error: 'one or more Company preview rows are invalid' }, 400)
  }

  await getImportSchema()
  const companies = await getCompanies()
  const maps = buildCompanyMaps(companies)
  const seenLinkedin = new Set<string>()
  const seenDomain = new Set<string>()

  const results = (payload.rows as CompanyImportRow[]).map((row) => {
    const validation = validateRow(row)
    if (validation) {
      return { rowNumber: row.rowNumber, status: 'invalid' as const, reason: validation }
    }
    const linkedinKey = normalizeLinkedin(row.linkedin)
    const domainKey = normalizeDomain(row.website)
    if (
      (linkedinKey && seenLinkedin.has(linkedinKey)) ||
      (domainKey && seenDomain.has(domainKey))
    ) {
      return {
        rowNumber: row.rowNumber,
        status: 'duplicate' as const,
        reason: 'Duplicate company in this CSV',
      }
    }
    if (linkedinKey) seenLinkedin.add(linkedinKey)
    if (domainKey) seenDomain.add(domainKey)
    return { rowNumber: row.rowNumber, ...classifyCompanyRow(row, maps) }
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

function validCommitRow(value: unknown): value is CompanyCommitRow {
  return validRow(value) && typeof (value as Partial<CompanyCommitRow>).allowNameDuplicate === 'boolean'
}

function companyFields(row: CompanyCommitRow, addedBy: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    [AIRTABLE_IDS.companies.name]: row.companyName.trim(),
    [AIRTABLE_IDS.companies.approveStatus]: 'New',
    [AIRTABLE_IDS.companies.addedBy]: addedBy,
  }
  const strings = [
    [AIRTABLE_IDS.companies.mailingName, row.mailingName],
    [AIRTABLE_IDS.companies.website, row.website ? canonicalWebsite(row.website) : ''],
    [AIRTABLE_IDS.companies.linkedin, canonicalLinkedin(row.linkedin)],
    [AIRTABLE_IDS.companies.country, row.country],
    [AIRTABLE_IDS.companies.industry, row.industry],
    [AIRTABLE_IDS.companies.keywords, row.keywords],
    [AIRTABLE_IDS.companies.description, row.description],
  ] as const
  for (const [fieldId, value] of strings) {
    if (value.trim()) fields[fieldId] = value.trim()
  }
  const employees = optionalInteger(row.employees, 'Employees', 0, 10_000_000)
  const foundedYear = optionalInteger(
    row.foundedYear,
    'Founded year',
    1700,
    new Date().getUTCFullYear() + 1,
  )
  if (employees !== null) fields[AIRTABLE_IDS.companies.employees] = employees
  if (foundedYear !== null) fields[AIRTABLE_IDS.companies.foundedYear] = foundedYear
  return fields
}

function addCompanyToMaps(company: CompanyRecord, maps: CompanyMaps) {
  const keys = [
    [maps.linkedin, normalizeLinkedin(company.linkedin)],
    [maps.domain, normalizeDomain(company.website)],
    [maps.name, normalizeName(company.name)],
  ] as const
  for (const [map, key] of keys) {
    if (!key) continue
    map.set(key, [...(map.get(key) ?? []), company])
  }
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
    return json({ error: 'one or more Company commit rows are invalid' }, 400)
  }

  const schema = await getImportSchema(true)
  if (!schema.addedBy.includes(addedBy)) {
    return json({ error: 'Added by must be one of the current Airtable choices' }, 400)
  }

  const maps = buildCompanyMaps(await getCompanies(true))
  const results: CommitResult[] = []
  const valid: Array<{ row: CompanyCommitRow; fields: Record<string, unknown> }> = []
  const seenLinkedin = new Set<string>()
  const seenDomain = new Set<string>()

  for (const row of payload.rows as CompanyCommitRow[]) {
    const validation = validateRow(row)
    if (validation) {
      results.push({ rowNumber: row.rowNumber, status: 'failed', error: validation })
      continue
    }
    const linkedinKey = normalizeLinkedin(row.linkedin)
    const domainKey = normalizeDomain(row.website)
    if (
      (linkedinKey && seenLinkedin.has(linkedinKey)) ||
      (domainKey && seenDomain.has(domainKey))
    ) {
      results.push({
        rowNumber: row.rowNumber,
        status: 'duplicate',
        error: 'Duplicate company in this commit',
      })
      continue
    }
    if (linkedinKey) seenLinkedin.add(linkedinKey)
    if (domainKey) seenDomain.add(domainKey)

    const classification = classifyCompanyRow(row, maps)
    if (classification.status === 'duplicate') {
      results.push({
        rowNumber: row.rowNumber,
        status: 'duplicate',
        companyId: classification.company.id,
        error: classification.reason,
      })
      continue
    }
    if (
      classification.status === 'company_action' &&
      (classification.reason !== 'name_match' || !row.allowNameDuplicate)
    ) {
      results.push({
        rowNumber: row.rowNumber,
        status: 'duplicate',
        companyId: classification.suggestions[0]?.id,
        error:
          classification.reason === 'name_match'
            ? 'A Company with this name now exists in Airtable'
            : 'Company identifiers now match conflicting or ambiguous Airtable records',
      })
      continue
    }
    valid.push({ row, fields: companyFields(row, addedBy) })
  }

  for (let index = 0; index < valid.length; index += 10) {
    const chunk = valid.slice(index, index + 10)
    try {
      const created = await createRecords(
        AIRTABLE_IDS.companiesTable,
        chunk.map((item) => item.fields),
      )
      chunk.forEach((item, itemIndex) => {
        const record = created[itemIndex]
        if (!record) {
          results.push({
            rowNumber: item.row.rowNumber,
            status: 'failed',
            error: 'Airtable did not return the created record',
          })
          return
        }
        results.push({
          rowNumber: item.row.rowNumber,
          status: 'created',
          companyId: record.id,
        })
        addCompanyToMaps(
          {
            id: record.id,
            name: item.row.companyName,
            website: item.row.website,
            linkedin: item.row.linkedin,
          },
          maps,
        )
      })
    } catch (error) {
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
          const [created] = await createRecords(AIRTABLE_IDS.companiesTable, [item.fields])
          if (!created) throw new Error('Airtable did not return the created record')
          results.push({
            rowNumber: item.row.rowNumber,
            status: 'created',
            companyId: created.id,
          })
          addCompanyToMaps(
            {
              id: created.id,
              name: item.row.companyName,
              website: item.row.website,
              linkedin: item.row.linkedin,
            },
            maps,
          )
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

  companyCache = null
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
    if (error instanceof AirtableError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502
      return json({ error: error.message, retryable: error.retryable }, status)
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
}
