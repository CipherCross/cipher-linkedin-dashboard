// Airtable → Neon mirror of every base's Companies and Contacts (ledger step
// 030), then the lead ↔ company links derived from it.
//
// Incremental: each (base, table) keeps a cursor, and a run reads only records
// whose LAST_MODIFIED_TIME() is after it (a few minutes of overlap; the upsert
// is idempotent). The first run, or `full`, reads everything. A run stops at
// its time budget and stores Airtable's continuation offset, so the next call
// resumes where it stopped; an offset Airtable has expired restarts that table
// from its cursor. The cursor only advances when a table is read to the end.
//
// Three callers: a member's "Sync from Airtable" (`/api/import?op=airtable.sync`,
// app_runtime), the daily `/api/classify` cron (app_system, system actor) and
// the CSV importers after a commit. Airtable deletions are not mirrored.

import {
  AIRTABLE_IDS,
  getAirtableSchema,
  isExpiredOffset,
  listRecordsPage,
  airtableConfigured,
  type AirtablePage,
  type AirtableRecord,
  type AirtableTableSchema,
} from './airtable.js'
import { AIRTABLE_BASES, type AirtableBaseId } from '../../src/lib/airtableBases.js'
import type { ActorContext, DataStore } from './data/contracts.js'
import {
  AIRTABLE_MIRROR_COMMANDS,
  AIRTABLE_MIRROR_OPERATIONS,
  type AirtableTableKey,
  type LinkRefreshResult,
  type MirrorCompanyRow,
  type MirrorContactRow,
  type SyncStateRow,
} from './data/operations/airtableMirror.js'

export interface TableRun {
  readonly upserted: number
  readonly done: boolean
  readonly error?: string
}

export interface BaseRun {
  readonly base: AirtableBaseId
  readonly configured: boolean
  readonly companies?: TableRun
  readonly contacts?: TableRun
  readonly error?: string
}

export interface AirtableSyncResult {
  /** Every configured base read to the end, with no error. */
  readonly done: boolean
  readonly bases: readonly BaseRun[]
  readonly links: LinkRefreshResult | null
  readonly links_error?: string
}

export interface AirtableSyncOptions {
  /** Wall-clock budget for the Airtable reads; the link refresh runs after it. */
  readonly budgetMs: number
  readonly bases?: readonly AirtableBaseId[]
  /** Ignore the cursor and read every record again. */
  readonly full?: boolean
}

export interface AirtableSyncDeps {
  readonly store: DataStore
  readonly actor: ActorContext
  readonly now?: () => number
  readonly fetchPage?: typeof listRecordsPage
  readonly fetchSchema?: typeof getAirtableSchema
  readonly configured?: (base: AirtableBaseId) => boolean
}

/** Records changed this close before the cursor are read again. */
const CURSOR_OVERLAP_MS = 5 * 60_000
const MAX_FIELD_TEXT = 20_000
const RECORD_ID = /^rec[A-Za-z0-9]{14}$/

const TABLE_IDS: Record<AirtableTableKey, string> = {
  companies: AIRTABLE_IDS.companiesTable,
  contacts: AIRTABLE_IDS.contactsTable,
}

// Typed columns with no pinned field ID are found by name, first match wins.
const COMPANY_NAMED: Record<'ai_niche' | 'summary' | 'web_app_link', readonly string[]> = {
  ai_niche: ['ai niche', 'niche', 'ai_niche'],
  summary: ['summary', 'company summary', 'ai summary'],
  web_app_link: ['web app link', 'web app', 'app link', 'web/app link'],
}
const CONTACT_NAMED: Record<'readiness' | 'technicality', readonly string[]> = {
  readiness: ['readiness'],
  technicality: ['technicality'],
}

// --- value helpers ----------------------------------------------------------

/** An Airtable cell as display text: lists joined, objects by their name/value. */
export function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map(cellText).filter((part): part is string => Boolean(part))
    return parts.length ? parts.join(', ') : null
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    for (const key of ['name', 'value', 'label', 'text', 'url', 'email']) {
      if (typeof object[key] === 'string' && (object[key] as string).trim()) {
        return (object[key] as string).trim()
      }
    }
  }
  return null
}

/** The first integer in a cell ("1,200" → 1200, "51-200" → 51), else null. */
export function cellInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  const text = cellText(value)
  if (!text) return null
  const match = text.replace(/[,\s](?=\d{3}\b)/g, '').match(/\d+/)
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isSafeInteger(parsed) && parsed <= 2_000_000_000 ? parsed : null
}

/** "https://www.Acme.com/about" → "acme.com". */
export function websiteDomain(website: string | null): string | null {
  if (!website) return null
  const host = website.trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#\s]/)[0]
  return host && /^[a-z0-9.-]{1,253}$/.test(host) && host.includes('.') ? host : null
}

function firstRecordId(value: unknown): string | null {
  const list = Array.isArray(value) ? value : [value]
  for (const item of list) {
    if (typeof item === 'string' && RECORD_ID.test(item)) return item
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
      && RECORD_ID.test((item as { id: string }).id)) return (item as { id: string }).id
  }
  return null
}

function foundedYear(value: unknown): number | null {
  const year = cellInt(value)
  return year !== null && year >= 1600 && year <= 2100 ? year : null
}

/** The record's fields with any single string capped, so one cell cannot bloat the row. */
function cappedFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === 'string' && value.length > MAX_FIELD_TEXT
      ? value.slice(0, MAX_FIELD_TEXT)
      : value
  }
  return out
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** Field names of one table: pinned IDs → names, plus a lower-case name index. */
export interface FieldNames {
  readonly byId: ReadonlyMap<string, string>
  readonly byLowerName: ReadonlyMap<string, string>
}

export function fieldNames(table: AirtableTableSchema | undefined): FieldNames {
  const byId = new Map<string, string>()
  const byLowerName = new Map<string, string>()
  for (const field of table?.fields ?? []) {
    byId.set(field.id, field.name)
    byLowerName.set(field.name.trim().toLowerCase(), field.name)
  }
  return { byId, byLowerName }
}

function pick(record: AirtableRecord, names: FieldNames, id: string): unknown {
  const name = names.byId.get(id)
  return name === undefined ? undefined : record.fields[name]
}

function pickNamed(record: AirtableRecord, names: FieldNames, candidates: readonly string[]): unknown {
  for (const candidate of candidates) {
    const name = names.byLowerName.get(candidate)
    if (name !== undefined) return record.fields[name]
  }
  return undefined
}

// The list API carries no modification time. A "Last modified" field, when
// the table has one, gives it; otherwise the creation time stands in, which
// still picks the newer contact when a person is in two bases.
const LAST_MODIFIED_NAMES = ['last modified', 'last modified time', 'last modified at', 'modified']

function lastModified(record: AirtableRecord, names: FieldNames): string | null {
  return iso(pickNamed(record, names, LAST_MODIFIED_NAMES)) ?? iso(record.createdTime)
}

export function companyRow(record: AirtableRecord, names: FieldNames): MirrorCompanyRow {
  const ids = AIRTABLE_IDS.companies
  const website = cellText(pick(record, names, ids.website))
  return {
    record_id: record.id,
    name: cellText(pick(record, names, ids.name)),
    website,
    domain: websiteDomain(website),
    linkedin_url: cellText(pick(record, names, ids.linkedin)),
    hq_country: cellText(pick(record, names, ids.country)),
    industry: cellText(pick(record, names, ids.industry)),
    employees: cellInt(pick(record, names, ids.employees)),
    founded_year: foundedYear(pick(record, names, ids.foundedYear)),
    ai_niche: cellText(pickNamed(record, names, COMPANY_NAMED.ai_niche)),
    approve_status: cellText(pick(record, names, ids.approveStatus)),
    description: cellText(pick(record, names, ids.description)),
    summary: cellText(pickNamed(record, names, COMPANY_NAMED.summary)),
    keywords: cellText(pick(record, names, ids.keywords)),
    web_app_link: cellText(pickNamed(record, names, COMPANY_NAMED.web_app_link)),
    airtable_created: iso(record.createdTime),
    airtable_modified: lastModified(record, names),
    fields: cappedFields(record.fields),
  }
}

export function contactRow(record: AirtableRecord, names: FieldNames): MirrorContactRow {
  const ids = AIRTABLE_IDS.contacts
  return {
    record_id: record.id,
    persona_url: cellText(pick(record, names, ids.personaLinkedin)),
    full_name: cellText(pick(record, names, ids.fullName)),
    title: cellText(pick(record, names, ids.title)),
    company_record_id: firstRecordId(pick(record, names, ids.company)),
    approve_status: cellText(pick(record, names, ids.approveStatus)),
    readiness: cellText(pickNamed(record, names, CONTACT_NAMED.readiness)),
    technicality: cellText(pickNamed(record, names, CONTACT_NAMED.technicality)),
    airtable_created: iso(record.createdTime),
    airtable_modified: lastModified(record, names),
    fields: cappedFields(record.fields),
  }
}

/** The incremental filter: records modified after the cursor, minus the overlap. */
export function modifiedSinceFormula(cursor: string | null): string | undefined {
  if (!cursor) return undefined
  const time = Date.parse(cursor)
  if (Number.isNaN(time)) return undefined
  const since = new Date(time - CURSOR_OVERLAP_MS).toISOString()
  return `IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE("${since}"))`
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500)
  return 'UnknownError'
}

// --- the run ------------------------------------------------------------------

async function readState(deps: AirtableSyncDeps, base: AirtableBaseId, table: AirtableTableKey) {
  const page = await deps.store.query<SyncStateRow>(deps.actor, {
    operation: AIRTABLE_MIRROR_OPERATIONS.syncState,
    params: { baseKey: base, tableKey: table },
    page: { limit: 1 },
  })
  return page.items[0] ?? null
}

async function saveState(
  deps: AirtableSyncDeps,
  base: AirtableBaseId,
  table: AirtableTableKey,
  state: {
    cursor: string | null
    runStartedAt: string | null
    pendingOffset: string | null
    lastError: string | null
    rowsUpserted: number
  },
) {
  await deps.store.transaction(deps.actor, (transaction) =>
    transaction.execute<void>({
      operation: AIRTABLE_MIRROR_COMMANDS.saveSyncState,
      params: { baseKey: base, tableKey: table, ...state },
    }),
  )
}

async function syncTable(
  deps: AirtableSyncDeps,
  base: AirtableBaseId,
  table: AirtableTableKey,
  names: FieldNames,
  deadline: number,
  full: boolean,
): Promise<TableRun> {
  const now = deps.now ?? Date.now
  const fetchPage = deps.fetchPage ?? listRecordsPage
  const state = await readState(deps, base, table)
  // A stored offset always wins: it belongs to the query (and so the cursor)
  // it was read under, which is what the state still holds. A full run clears
  // the cursor, so an interrupted full run resumes as a full run.
  const resuming = Boolean(state?.pending_offset && state.run_started_at)
  const cursor = resuming || !full ? (state?.cursor ?? null) : null
  const runStartedAt = resuming ? state!.run_started_at! : new Date(now()).toISOString()
  const formula = modifiedSinceFormula(cursor)
  let offset: string | null = resuming ? state!.pending_offset : null
  let restarted = false
  let upserted = 0

  try {
    for (;;) {
      if (now() >= deadline) {
        // Out of time. Keep the offset only if a page of this run was read,
        // or the run resumed one; otherwise the next call starts afresh.
        await saveState(deps, base, table, {
          cursor,
          runStartedAt: offset ? runStartedAt : null,
          pendingOffset: offset,
          lastError: null,
          rowsUpserted: upserted,
        })
        return { upserted, done: false }
      }

      let page: AirtablePage
      try {
        page = await fetchPage(base, TABLE_IDS[table], { formula, offset })
      } catch (error) {
        if (offset && !restarted && isExpiredOffset(error)) {
          // Airtable forgot the continuation: read this table again from the
          // cursor. Idempotent upserts make the repeated pages harmless.
          offset = null
          restarted = true
          continue
        }
        throw error
      }

      if (page.records.length > 0) {
        const rows = page.records.map((record) =>
          table === 'companies' ? companyRow(record, names) : contactRow(record, names))
        const written = await deps.store.transaction(deps.actor, (transaction) =>
          transaction.execute<number>({
            operation: table === 'companies'
              ? AIRTABLE_MIRROR_COMMANDS.upsertCompanies
              : AIRTABLE_MIRROR_COMMANDS.upsertContacts,
            params: { baseKey: base, rows: JSON.stringify(rows) },
          }),
        )
        upserted += written
      }
      offset = page.offset
      if (!offset) break
    }
  } catch (error) {
    const message = errorText(error)
    await saveState(deps, base, table, {
      cursor,
      runStartedAt: null,
      pendingOffset: null,
      lastError: message,
      rowsUpserted: upserted,
    }).catch(() => undefined)
    return { upserted, done: false, error: message }
  }

  await saveState(deps, base, table, {
    cursor: runStartedAt,
    runStartedAt: null,
    pendingOffset: null,
    lastError: null,
    rowsUpserted: upserted,
  })
  return { upserted, done: true }
}

/** Re-derives every slug link. Best effort: an error is reported, not thrown. */
export async function refreshLeadCompanyLinks(
  deps: Pick<AirtableSyncDeps, 'store' | 'actor'>,
): Promise<LinkRefreshResult> {
  return deps.store.transaction(deps.actor, (transaction) =>
    transaction.execute<LinkRefreshResult>({
      operation: AIRTABLE_MIRROR_COMMANDS.refreshLinks,
    }),
  )
}

export async function syncAirtable(
  deps: AirtableSyncDeps,
  options: AirtableSyncOptions,
): Promise<AirtableSyncResult> {
  const now = deps.now ?? Date.now
  const deadline = now() + options.budgetMs
  const configured = deps.configured ?? airtableConfigured
  const fetchSchema = deps.fetchSchema ?? getAirtableSchema
  const wanted = options.bases ?? AIRTABLE_BASES.map((base) => base.id)
  const bases: BaseRun[] = []
  let done = true

  for (const base of wanted) {
    if (!configured(base)) {
      bases.push({ base, configured: false })
      continue
    }
    if (now() >= deadline) {
      bases.push({ base, configured: true, error: 'not reached within the time budget' })
      done = false
      continue
    }
    let schema: AirtableTableSchema[]
    try {
      schema = await fetchSchema(base)
    } catch (error) {
      bases.push({ base, configured: true, error: errorText(error) })
      done = false
      continue
    }
    const tableNames = (key: AirtableTableKey) =>
      fieldNames(schema.find((table) => table.id === TABLE_IDS[key]))
    // Companies first: a contact links only to a mirrored company.
    const companies = await syncTable(deps, base, 'companies', tableNames('companies'), deadline, options.full === true)
    const contacts = companies.error
      ? { upserted: 0, done: false }
      : await syncTable(deps, base, 'contacts', tableNames('contacts'), deadline, options.full === true)
    if (!companies.done || !contacts.done) done = false
    bases.push({ base, configured: true, companies, contacts })
  }

  // No base configured: nothing was read, and the links stay as they are.
  if (bases.every((run) => !run.configured)) return { done: true, bases, links: null }

  let links: LinkRefreshResult | null = null
  let linksError: string | undefined
  try {
    links = await refreshLeadCompanyLinks(deps)
  } catch (error) {
    linksError = errorText(error)
    done = false
  }

  return { done, bases, links, ...(linksError ? { links_error: linksError } : {}) }
}
