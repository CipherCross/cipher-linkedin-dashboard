// Team stats for the CSV import page (`import_stats`): how many DB, Companies
// and Contacts records each "Added by" person created in a period, split by the
// record's current status. Read-only — it never writes Airtable or Neon.
//
// A record's day is its creation time (UTC). DB is ≈22k rows and is never read
// in full: each table is queried with a formula that keeps only records created
// around the period and drops Old ones, and only the Added by and status fields
// come back. The formula over-matches by a day either side on purpose, so a
// time-zone reading of DATETIME_PARSE cannot lose a record at the edge; the
// exact comparison happens here, on `createdTime`, as the DB domain lookup in
// airtableDirectory.ts does.
//
// The answer is compact daily buckets (table × day × Added by × group × count);
// the browser builds columns, totals, weeks and the All bases sum from them.
import { MAX_TEAM_STATS_DAYS, isDay, rangeDayCount, shiftDay } from '../../src/lib/teamStats.js'
import type {
  StatusGroup,
  TeamStatsBucket,
  TeamStatsTable,
  TeamStatsTableInfo,
} from '../../src/lib/teamStats.js'
import {
  AIRTABLE_IDS,
  AirtableError,
  AirtablePageLimitError,
  airtableConfigured,
  findRecordsByFormula,
  getAirtableSchema,
  type AirtableBaseId,
  type AirtableRecord,
  type AirtableTableSchema,
} from './airtable.js'
import {
  CACHE_MS,
  baseOf,
  choicesOf,
  errorResponse,
  importAddedByChoices,
  isRejected,
  json,
} from './airtableDirectory.js'

/**
 * Which status values count as what, matched trimmed and case-insensitively.
 * Anything not listed — New, Manual review, blank, a value added in Airtable
 * later — counts as New. Excluded values (old companies and leads) are dropped
 * in the Airtable formula and never counted, not even in All. Companies and
 * Contacts spell their statuses Approved / Rejected, DB spells them Approve /
 * Reject, so both spellings are here.
 */
export const STATUS_GROUPS = {
  approve: ['Approve', 'Approved', 'Manual approve'],
  reject: ['Reject'],
  excluded: ['Old'],
} as const

const normalized = (values: readonly string[]) => new Set(values.map((value) => value.trim().toLowerCase()))
const APPROVE = normalized(STATUS_GROUPS.approve)
const REJECT = normalized(STATUS_GROUPS.reject)
const EXCLUDED = normalized(STATUS_GROUPS.excluded)

/** The group a status counts in, or `null` for an excluded one. */
export function statusGroup(status: string): StatusGroup | null {
  const key = status.trim().toLowerCase()
  if (EXCLUDED.has(key)) return null
  if (APPROVE.has(key)) return 'approve'
  if (REJECT.has(key) || isRejected(status)) return 'reject'
  return 'new'
}

const TABLES: Record<TeamStatsTable, { id: string; label: string; status: string; addedBy: string }> = {
  db: {
    id: AIRTABLE_IDS.dbTable,
    label: 'DB',
    status: AIRTABLE_IDS.db.initialStatus,
    addedBy: AIRTABLE_IDS.db.addedBy,
  },
  companies: {
    id: AIRTABLE_IDS.companiesTable,
    label: 'Companies',
    status: AIRTABLE_IDS.companies.approveStatus,
    addedBy: AIRTABLE_IDS.companies.addedBy,
  },
  contacts: {
    id: AIRTABLE_IDS.contactsTable,
    label: 'Contacts',
    status: AIRTABLE_IDS.contacts.approveStatus,
    addedBy: AIRTABLE_IDS.contacts.addedBy,
  },
}

const TABLE_KEYS = Object.keys(TABLES) as TeamStatsTable[]

/**
 * Pages one table may read in one request: 5,000 records. Three tables at the
 * adapter's 225 ms gap is ≈34 s at most, inside the 60 s function budget.
 */
export const MAX_PAGES_PER_TABLE = 50

// ------------------------------------------------------------------ schema

const schemaCache = new Map<AirtableBaseId, { at: number; tables: Record<TeamStatsTable, TeamStatsTableInfo> }>()

function tableInfo(tables: AirtableTableSchema[], key: TeamStatsTable): TeamStatsTableInfo {
  const spec = TABLES[key]
  const table = tables.find((item) => item.id === spec.id)
  if (!table) throw new AirtableError(`Required Airtable ${spec.label} table is missing`, 503)
  for (const fieldId of [spec.status, spec.addedBy]) {
    if (!table.fields.some((field) => field.id === fieldId)) {
      throw new AirtableError(`Airtable schema mismatch for ${table.name}.${fieldId}; the field is missing`, 503)
    }
  }
  return {
    people: importAddedByChoices(choicesOf(table, spec.addedBy)),
    statuses: choicesOf(table, spec.status).map((name) => ({ name, group: statusGroup(name) ?? 'excluded' })),
  }
}

async function getStatsSchema(base: AirtableBaseId, force: boolean) {
  const cached = schemaCache.get(base)
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.tables
  const schema = await getAirtableSchema(base)
  const tables = {
    db: tableInfo(schema, 'db'),
    companies: tableInfo(schema, 'companies'),
    contacts: tableInfo(schema, 'contacts'),
  }
  schemaCache.set(base, { at: Date.now(), tables })
  return tables
}

// ----------------------------------------------------------------- records

const midnight = (day: string) => `${day}T00:00:00.000Z`

/**
 * Records created from the day before `from` to the end of the day after `to`,
 * except excluded statuses. `from`/`to` are validated `YYYY-MM-DD` strings and
 * the excluded names are constants, so nothing here needs escaping.
 */
export function statsFormula(statusFieldId: string, from: string, to: string): string {
  const excluded = [...EXCLUDED].map((name) => `LOWER(TRIM({${statusFieldId}}&"")) != "${name}"`)
  return `AND(${[
    `IS_AFTER(CREATED_TIME(), DATETIME_PARSE("${midnight(shiftDay(from, -1))}"))`,
    `IS_BEFORE(CREATED_TIME(), DATETIME_PARSE("${midnight(shiftDay(to, 2))}"))`,
    ...excluded,
  ].join(', ')})`
}

/** A select read back by field ID: a string, `{ name }`, or a list of either. */
function selectValue(value: unknown): string {
  if (Array.isArray(value)) return selectValue(value[0])
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
    return (value as { name: string }).name.trim()
  }
  return ''
}

const bucketCache = new Map<string, { at: number; buckets: TeamStatsBucket[] }>()

export function resetImportStatsCache() {
  schemaCache.clear()
  bucketCache.clear()
}

async function tableBuckets(
  base: AirtableBaseId,
  key: TeamStatsTable,
  from: string,
  to: string,
  force: boolean,
): Promise<TeamStatsBucket[]> {
  const cacheKey = `${base}|${key}|${from}|${to}`
  const cached = bucketCache.get(cacheKey)
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.buckets

  const spec = TABLES[key]
  let records: AirtableRecord[]
  try {
    records = await findRecordsByFormula(
      base,
      spec.id,
      statsFormula(spec.status, from, to),
      [spec.addedBy, spec.status],
      { maxPages: MAX_PAGES_PER_TABLE },
    )
  } catch (error) {
    if (error instanceof AirtablePageLimitError) {
      throw new AirtableError(
        `${spec.label} has more than ${(error.maxPages * 100).toLocaleString('en-US')} records created in this period. Pick a shorter period.`,
        422,
      )
    }
    throw error
  }

  const start = Date.parse(midnight(from))
  const end = Date.parse(midnight(shiftDay(to, 1)))
  const counts = new Map<string, TeamStatsBucket>()
  for (const record of records) {
    const created = Date.parse(record.createdTime ?? '')
    if (!Number.isFinite(created) || created < start || created >= end) continue
    const group = statusGroup(selectValue(record.fields[spec.status]))
    if (!group) continue
    const day = new Date(created).toISOString().slice(0, 10)
    const addedBy = selectValue(record.fields[spec.addedBy])
    const id = `${day}|${addedBy}|${group}`
    const bucket = counts.get(id) ?? { table: key, day, addedBy, group, count: 0 }
    bucket.count++
    counts.set(id, bucket)
  }
  const buckets = [...counts.values()].sort((a, b) =>
    a.day.localeCompare(b.day) || a.addedBy.localeCompare(b.addedBy) || a.group.localeCompare(b.group))
  bucketCache.set(cacheKey, { at: Date.now(), buckets })
  return buckets
}

// ----------------------------------------------------------------- handler

function rangeOrError(payload: Record<string, unknown>): { from: string; to: string } | Response {
  const { from, to } = payload
  if (!isDay(from) || !isDay(to)) {
    return json({ error: 'from and to must be dates in YYYY-MM-DD form' }, 400)
  }
  if (from > to) return json({ error: 'from must not be after to' }, 400)
  if (rangeDayCount(from, to) > MAX_TEAM_STATS_DAYS) {
    return json({ error: `The period is longer than ${MAX_TEAM_STATS_DAYS} days. Pick a shorter period.` }, 400)
  }
  return { from, to }
}

export async function handleImportStats(payload: Record<string, unknown>): Promise<Response> {
  const base = baseOf(payload)
  if (base instanceof Response) return base
  const range = rangeOrError(payload)
  if (range instanceof Response) return range
  const { from, to } = range
  if (!airtableConfigured(base)) return json({ ok: true, base, configured: false, from, to })

  const force = payload.force === true
  try {
    const tables = await getStatsSchema(base, force)
    const buckets = (await Promise.all(TABLE_KEYS.map((key) => tableBuckets(base, key, from, to, force)))).flat()
    return json({ ok: true, base, configured: true, from, to, fetchedAt: new Date().toISOString(), tables, buckets })
  } catch (error) {
    return errorResponse(error)
  }
}
