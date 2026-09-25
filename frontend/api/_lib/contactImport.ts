// Leads upload → Airtable Contacts. Each lead is linked to a Companies record
// that the user confirms by hand; nothing is linked automatically.
//
// Preview groups the leads by company (normalized domain, else company
// LinkedIn, else normalized name) and, per group, either suggests a Companies
// record or says why none can be linked yet:
//   suggested     one linkable Companies record matched (domain → LinkedIn → name)
//   ambiguous     several linkable records matched; the user picks one
//   declined      the company is Rejected in Companies or in DB; leads are skipped
//   pending       a DB row exists and is not Rejected, but the company is not
//                 in Companies yet; leads are held until an SDR approves it
//   not_uploaded  found nowhere; leads are held (manual search still works)
//
// Commit accepts only rows that carry a confirmed Companies record ID, and
// re-verifies it: the record must still exist, must not be Rejected, and the
// lead's own company must not have been declined. It never re-matches.
import { AIRTABLE_IDS, AirtableError, getAirtableSchema, listAllRecords } from './airtable.js'
import {
  CACHE_MS,
  COMPANIES_SCHEMA,
  RECORD_ID,
  asString,
  buildCompanyMaps,
  choicesOf,
  companyLinkedinKey,
  createAll,
  errorResponse,
  findDbByDomains,
  findDbByNames,
  getCompanies,
  importAddedByChoices,
  isCleanPersonLinkedin,
  isRejected,
  json,
  normalizeDomain,
  normalizeLinkedin,
  normalizeName,
  requireFields,
  type CompanyMaps,
  type CompanyRecord,
  type DbRecord,
} from './airtableDirectory.js'

const MAX_ROWS = 500
const CONTACT_CACHE_MS = 60_000
const MAX_TEXT = 1000
const MAX_CANDIDATES = 10

export interface LeadRow {
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
  companyWebsite: string
}

interface ContactRecord {
  id: string
  personaLinkedin: string
}

export type GroupStatus = 'suggested' | 'ambiguous' | 'pending' | 'declined' | 'not_uploaded'
export type MatchMethod = 'domain' | 'linkedin' | 'name'

export interface DbMatch {
  id: string
  name: string
  website: string
  status: string
  addedToCompanies: boolean
}

export interface LeadGroup {
  key: string
  companyName: string
  domain: string
  linkedin: string
  rowNumbers: number[]
  status: GroupStatus
  method?: MatchMethod
  suggestion?: CompanyRecord
  /** Linkable (not Rejected) Companies records the user may choose from. */
  candidates: CompanyRecord[]
  /** Companies records that matched but are Rejected. */
  rejected: CompanyRecord[]
  db: DbMatch[]
  declinedBy?: 'Companies' | 'DB'
  reason: string
}

export interface LeadRowResult {
  rowNumber: number
  status: 'ready' | 'invalid' | 'duplicate' | 'existing'
  reason?: string
  groupKey?: string
  contactIds?: string[]
}

type RowResultStatus = 'created' | 'duplicate' | 'failed'

interface CommitResult {
  rowNumber: number
  status: RowResultStatus
  contactId?: string
  error?: string
}

let schemaCache: { at: number; addedBy: string[] } | null = null
let contactCache: { at: number; records: ContactRecord[] } | null = null

async function getImportSchema(force = false): Promise<{ addedBy: string[] }> {
  if (!force && schemaCache && Date.now() - schemaCache.at < CACHE_MS) {
    return { addedBy: schemaCache.addedBy }
  }
  const tables = await getAirtableSchema()
  const companies = tables.find((table) => table.id === AIRTABLE_IDS.companiesTable)
  const contacts = tables.find((table) => table.id === AIRTABLE_IDS.contactsTable)
  const db = tables.find((table) => table.id === AIRTABLE_IDS.dbTable)
  if (!companies || !contacts || !db) {
    throw new AirtableError('Required Airtable Companies, Contacts or DB table is missing', 503)
  }

  requireFields(companies, COMPANIES_SCHEMA)
  requireFields(db, [
    [AIRTABLE_IDS.db.website, 'url'],
    [AIRTABLE_IDS.db.name, 'singleLineText'],
    [AIRTABLE_IDS.db.initialStatus, 'singleSelect'],
    [AIRTABLE_IDS.db.addedToCompanies, 'singleSelect'],
  ])
  requireFields(contacts, [
    [AIRTABLE_IDS.contacts.personaLinkedin, 'url'],
    [AIRTABLE_IDS.contacts.approveStatus, 'singleSelect'],
    [AIRTABLE_IDS.contacts.fullName, 'singleLineText'],
    [AIRTABLE_IDS.contacts.firstName, 'singleLineText'],
    [AIRTABLE_IDS.contacts.title, 'singleLineText'],
    [AIRTABLE_IDS.contacts.company, 'multipleRecordLinks'],
    [AIRTABLE_IDS.contacts.addedBy, 'singleSelect'],
  ])

  const companyLink = contacts.fields.find((item) => item.id === AIRTABLE_IDS.contacts.company)
  if (companyLink?.options?.linkedTableId !== AIRTABLE_IDS.companiesTable) {
    throw new AirtableError('Contacts.Company no longer links to Companies', 503)
  }
  if (!choicesOf(contacts, AIRTABLE_IDS.contacts.approveStatus).includes('New')) {
    throw new AirtableError('Contacts.Approve status is missing the New choice', 503)
  }
  const addedBy = importAddedByChoices(choicesOf(contacts, AIRTABLE_IDS.contacts.addedBy))
  if (!addedBy.length) throw new AirtableError('Contacts.Added by has no available choices', 503)

  schemaCache = { at: Date.now(), addedBy }
  return { addedBy }
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
    personaLinkedin: asString(record.fields[AIRTABLE_IDS.contacts.personaLinkedin]),
  }))
  contactCache = { at: Date.now(), records: contacts }
  return contacts
}

function contactMap(contacts: ContactRecord[]): Map<string, ContactRecord[]> {
  const result = new Map<string, ContactRecord[]>()
  for (const contact of contacts) {
    const key = normalizeLinkedin(contact.personaLinkedin)
    if (!key) continue
    result.set(key, [...(result.get(key) ?? []), contact])
  }
  return result
}

// ----------------------------------------------------------------- grouping

export function groupKeyOf(row: Pick<LeadRow, 'companyName' | 'companyWebsite' | 'companyLinkedin'>): string {
  const domain = normalizeDomain(row.companyWebsite)
  if (domain) return `domain:${domain}`
  const linkedin = companyLinkedinKey(row.companyLinkedin)
  if (linkedin) return `linkedin:${linkedin}`
  const name = normalizeName(row.companyName)
  return name ? `name:${name}` : 'none'
}

export interface GroupDraft {
  key: string
  companyName: string
  domain: string
  linkedin: string
  nameKey: string
  rowNumbers: number[]
}

export function groupRows(rows: LeadRow[]): GroupDraft[] {
  const groups = new Map<string, GroupDraft>()
  for (const row of rows) {
    const key = groupKeyOf(row)
    const group = groups.get(key) ?? {
      key,
      companyName: '',
      domain: normalizeDomain(row.companyWebsite),
      linkedin: '',
      nameKey: '',
      rowNumbers: [],
    }
    group.rowNumbers.push(row.rowNumber)
    if (!group.companyName && row.companyName.trim()) {
      group.companyName = row.companyName.trim()
      group.nameKey = normalizeName(row.companyName)
    }
    if (!group.linkedin) group.linkedin = companyLinkedinKey(row.companyLinkedin)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function unique(records: CompanyRecord[]): CompanyRecord[] {
  return [...new Map(records.map((record) => [record.id, record])).values()]
}

const linkable = (records: CompanyRecord[]) => records.filter((record) => !isRejected(record.approveStatus))
const rejectedOnly = (records: CompanyRecord[]) => records.filter((record) => isRejected(record.approveStatus))

/** A same-name record whose stored domain or LinkedIn says it is a different company. */
function stableConflict(record: CompanyRecord, group: GroupDraft): boolean {
  const storedDomain = normalizeDomain(record.website)
  const storedLinkedin = companyLinkedinKey(record.linkedin)
  return (
    (!!group.domain && !!storedDomain && storedDomain !== group.domain) ||
    (!!group.linkedin && !!storedLinkedin && storedLinkedin !== group.linkedin)
  )
}

const dbMatch = (record: DbRecord): DbMatch => ({
  id: record.id,
  name: record.name,
  website: record.website,
  status: record.status,
  addedToCompanies: record.addedToCompanies,
})

function base(group: GroupDraft) {
  return {
    key: group.key,
    companyName: group.companyName,
    domain: group.domain,
    linkedin: group.linkedin,
    rowNumbers: group.rowNumbers,
  }
}

/**
 * The Companies half of the classification: a suggestion, an ambiguity, a
 * decline, or `null` when Companies cannot decide and DB must be consulted.
 * A name match never declines — a same-named Rejected record is not proof it
 * is the same company.
 */
export function companiesVerdict(group: GroupDraft, maps: CompanyMaps): LeadGroup | null {
  const byDomain = group.domain ? maps.domain.get(group.domain) ?? [] : []
  const byLinkedin = group.linkedin ? maps.linkedin.get(group.linkedin) ?? [] : []
  const byName = group.nameKey ? maps.name.get(group.nameKey) ?? [] : []
  const candidates = unique(linkable([...byDomain, ...byLinkedin, ...byName])).slice(0, MAX_CANDIDATES)

  const stable: Array<[MatchMethod, CompanyRecord[]]> = [['domain', byDomain], ['linkedin', byLinkedin]]
  for (const [method, matches] of stable) {
    if (!matches.length) continue
    const open = linkable(matches)
    if (open.length === 1) {
      return {
        ...base(group),
        status: 'suggested',
        method,
        suggestion: open[0],
        candidates,
        rejected: rejectedOnly(matches),
        db: [],
        reason: method === 'domain' ? 'One Companies record has this domain' : 'One Companies record has this LinkedIn page',
      }
    }
    if (open.length > 1) {
      return {
        ...base(group),
        status: 'ambiguous',
        method,
        candidates: unique([...open, ...candidates]).slice(0, MAX_CANDIDATES),
        rejected: rejectedOnly(matches),
        db: [],
        reason: `${open.length} Companies records share this ${method === 'domain' ? 'domain' : 'LinkedIn page'}; choose one`,
      }
    }
    return {
      ...base(group),
      status: 'declined',
      declinedBy: 'Companies',
      candidates: [],
      rejected: matches,
      db: [],
      reason: 'This company is Rejected in Companies',
    }
  }

  const names = linkable(byName).filter((record) => !stableConflict(record, group))
  if (names.length === 1) {
    return {
      ...base(group),
      status: 'suggested',
      method: 'name',
      suggestion: names[0],
      candidates,
      rejected: [],
      db: [],
      reason: 'One Companies record has this exact name',
    }
  }
  if (names.length > 1) {
    return {
      ...base(group),
      status: 'ambiguous',
      method: 'name',
      candidates: unique([...names, ...candidates]).slice(0, MAX_CANDIDATES),
      rejected: [],
      db: [],
      reason: `${names.length} Companies records have this name; choose one`,
    }
  }
  return null
}

/** The DB half, for a group Companies could not decide. */
export function dbVerdict(
  group: GroupDraft,
  maps: CompanyMaps,
  db: { byDomain: Map<string, DbRecord[]>; byName: Map<string, DbRecord[]> },
): LeadGroup {
  const byName = group.nameKey ? maps.name.get(group.nameKey) ?? [] : []
  const candidates = unique(linkable(byName)).slice(0, MAX_CANDIDATES)
  const rows = group.domain
    ? db.byDomain.get(group.domain) ?? []
    : group.nameKey
      ? db.byName.get(group.nameKey) ?? []
      : []
  const open = rows.filter((record) => !isRejected(record.status))
  if (open.length) {
    const transferred = open.some((record) => record.addedToCompanies)
    return {
      ...base(group),
      status: 'pending',
      candidates,
      rejected: [],
      db: open.map(dbMatch),
      reason: transferred
        ? 'DB marks this company as added to Companies, but no Companies record matches it; find it with Change'
        : 'Waiting for approval in DB',
    }
  }
  if (rows.length) {
    return {
      ...base(group),
      status: 'declined',
      declinedBy: 'DB',
      candidates: [],
      rejected: [],
      db: rows.map(dbMatch),
      reason: 'This company is Rejected in DB',
    }
  }
  return {
    ...base(group),
    status: 'not_uploaded',
    candidates,
    rejected: [],
    db: [],
    reason: 'This company is in neither DB nor Companies; upload it in the Companies tab first',
  }
}

function needsDbLookup(groups: GroupDraft[], maps: CompanyMaps) {
  const undecided = groups.filter((group) => !companiesVerdict(group, maps))
  return {
    domains: undecided.map((group) => group.domain).filter(Boolean),
    names: undecided.filter((group) => !group.domain).map((group) => group.companyName).filter(Boolean),
  }
}

export function classifyGroups(
  groups: GroupDraft[],
  maps: CompanyMaps,
  db: { byDomain: Map<string, DbRecord[]>; byName: Map<string, DbRecord[]> },
): LeadGroup[] {
  return groups.map((group) => companiesVerdict(group, maps) ?? dbVerdict(group, maps, db))
}

// ------------------------------------------------------------------ actions

const isText = (value: unknown) => typeof value === 'string' && value.length <= MAX_TEXT

function validPreviewRow(value: unknown): value is LeadRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<LeadRow>
  return (
    typeof row.rowNumber === 'number' &&
    Number.isInteger(row.rowNumber) &&
    row.rowNumber > 1 &&
    [
      row.personLinkedin,
      row.firstName,
      row.lastName,
      row.fullName,
      row.title,
      row.companyName,
      row.companyWebsite,
      row.companyLinkedin,
    ].every(isText)
  )
}

function validCommitRow(value: unknown): value is CommitRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<CommitRow>
  return (
    typeof row.rowNumber === 'number' &&
    Number.isInteger(row.rowNumber) &&
    row.rowNumber > 1 &&
    [row.personLinkedin, row.firstName, row.fullName, row.title, row.companyWebsite].every(isText) &&
    typeof row.companyId === 'string' &&
    RECORD_ID.test(row.companyId)
  )
}

function rowIssue(row: { personLinkedin: string; firstName: string; fullName: string; title: string }): string | null {
  if (!isCleanPersonLinkedin(row.personLinkedin)) return 'A clean public LinkedIn /in/ URL is required'
  if (!row.firstName.trim() || !row.fullName.trim() || !row.title.trim()) {
    return 'First name, full name, and title are required'
  }
  return null
}

async function metadata() {
  const schema = await getImportSchema()
  return json({
    ok: true,
    target: 'contacts',
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
  const rows = payload.rows as LeadRow[]

  await getImportSchema()
  // Re-check after an approval must see the new Companies record, so the
  // caller can bypass the cache.
  const [companies, contacts] = await Promise.all([
    getCompanies(payload.forceCompanies === true),
    getContacts(payload.forceCompanies === true),
  ])
  const existing = contactMap(contacts)
  const seen = new Set<string>()

  const ready: LeadRow[] = []
  const rowResults: LeadRowResult[] = rows.map((row) => {
    const issue = rowIssue(row)
    if (issue) return { rowNumber: row.rowNumber, status: 'invalid', reason: issue }
    const personKey = normalizeLinkedin(row.personLinkedin)
    if (seen.has(personKey)) {
      return { rowNumber: row.rowNumber, status: 'duplicate', reason: 'Duplicate person in this file' }
    }
    seen.add(personKey)
    const found = existing.get(personKey) ?? []
    if (found.length) {
      return {
        rowNumber: row.rowNumber,
        status: 'existing',
        reason: 'Contact already exists in Airtable',
        contactIds: found.map((contact) => contact.id),
      }
    }
    ready.push(row)
    return { rowNumber: row.rowNumber, status: 'ready', groupKey: groupKeyOf(row) }
  })

  const maps = buildCompanyMaps(companies)
  const drafts = groupRows(ready)
  const lookup = needsDbLookup(drafts, maps)
  const [byDomain, byName] = await Promise.all([
    findDbByDomains(lookup.domains),
    findDbByNames(lookup.names),
  ])
  const groups = classifyGroups(drafts, maps, { byDomain, byName })

  return json({
    ok: true,
    rows: rowResults,
    groups,
    counts: groups.reduce<Record<string, number>>((counts, group) => {
      counts[group.status] = (counts[group.status] ?? 0) + group.rowNumbers.length
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
  const qLinkedin = companyLinkedinKey(query) || normalizeLinkedin(query)
  const directId = RECORD_ID.test(query) ? query : ''
  const matches = companies
    .filter((company) => {
      if (directId) return company.id === directId
      return (
        (!!qName && normalizeName(company.name).includes(qName)) ||
        (!!qDomain && normalizeDomain(company.website).includes(qDomain)) ||
        (!!qLinkedin && companyLinkedinKey(company.linkedin).includes(qLinkedin))
      )
    })
    .slice(0, 20)
  return json({ ok: true, companies: matches })
}

/**
 * Why a confirmed link must not be written, or `null`. The chosen record must
 * exist and not be Rejected; and when it is not the record the lead's own
 * domain points at, that domain must not be declined in Companies or DB.
 */
export function commitRefusal(
  row: CommitRow,
  company: CompanyRecord | undefined,
  maps: CompanyMaps,
  dbByDomain: Map<string, DbRecord[]>,
): string | null {
  if (!company) return 'The confirmed Company no longer exists in Airtable'
  if (isRejected(company.approveStatus)) return 'The confirmed Company is Rejected in Companies'
  const leadDomain = normalizeDomain(row.companyWebsite)
  if (!leadDomain || normalizeDomain(company.website) === leadDomain) return null
  const sameDomain = maps.domain.get(leadDomain) ?? []
  if (sameDomain.length) {
    return linkable(sameDomain).length ? null : 'This lead’s company is Rejected in Companies'
  }
  const dbRows = dbByDomain.get(leadDomain) ?? []
  if (dbRows.length && dbRows.every((record) => isRejected(record.status))) {
    return 'This lead’s company is Rejected in DB'
  }
  return null
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
  const rows = payload.rows as CommitRow[]

  const schema = await getImportSchema(true)
  if (!schema.addedBy.includes(addedBy)) {
    return json({ error: 'Added by must be one of the current Contacts choices' }, 400)
  }

  // Fresh identity reads: preview caches make the UI fast, but they are never
  // the final authority for a write.
  const [companies, contacts] = await Promise.all([getCompanies(true), getContacts(true)])
  const byId = new Map(companies.map((company) => [company.id, company]))
  const maps = buildCompanyMaps(companies)
  const dbDomains = rows
    .map((row) => normalizeDomain(row.companyWebsite))
    .filter((domain) => domain && !maps.domain.has(domain))
  const dbByDomain = await findDbByDomains(dbDomains)
  const existing = contactMap(contacts)

  const results: CommitResult[] = []
  const creatable: CommitRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const issue = rowIssue(row)
    if (issue) {
      results.push({ rowNumber: row.rowNumber, status: 'failed', error: issue })
      continue
    }
    const refusal = commitRefusal(row, byId.get(row.companyId), maps, dbByDomain)
    if (refusal) {
      results.push({ rowNumber: row.rowNumber, status: 'failed', error: refusal })
      continue
    }
    const personKey = normalizeLinkedin(row.personLinkedin)
    if (seen.has(personKey)) {
      results.push({ rowNumber: row.rowNumber, status: 'duplicate', error: 'Duplicate person in this commit' })
      continue
    }
    seen.add(personKey)
    const found = existing.get(personKey) ?? []
    if (found.length) {
      results.push({
        rowNumber: row.rowNumber,
        status: 'duplicate',
        contactId: found[0].id,
        error: 'Contact already exists in Airtable',
      })
      continue
    }
    creatable.push(row)
  }

  const outcomes = await createAll(AIRTABLE_IDS.contactsTable, creatable, (row) => ({
    [AIRTABLE_IDS.contacts.personaLinkedin]: `https://www.${normalizeLinkedin(row.personLinkedin)}/`,
    [AIRTABLE_IDS.contacts.fullName]: row.fullName.trim(),
    [AIRTABLE_IDS.contacts.firstName]: row.firstName.trim(),
    [AIRTABLE_IDS.contacts.title]: row.title.trim(),
    [AIRTABLE_IDS.contacts.company]: [row.companyId],
    [AIRTABLE_IDS.contacts.addedBy]: addedBy,
    [AIRTABLE_IDS.contacts.approveStatus]: 'New',
  }))
  for (const outcome of outcomes) {
    results.push(
      outcome.id
        ? { rowNumber: outcome.item.rowNumber, status: 'created', contactId: outcome.id }
        : { rowNumber: outcome.item.rowNumber, status: 'failed', error: outcome.error },
    )
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
    return errorResponse(error)
  }
}
