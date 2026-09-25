// Narrow Airtable Web API adapter for the CSV importers. This is deliberately
// not a generic proxy: callers cannot choose a base, table, or field. Stable
// Airtable IDs keep harmless display-name changes from breaking writes, while
// the schema checks in companyImport.ts and contactImport.ts fail closed if a
// field is deleted or retyped.
//
// Writes go to exactly two tables. New companies land in DB for approval, and
// Airtable automations — not this code — copy approved rows into Companies.
// `createRecords` refuses every other table, so no import path can write
// Companies even by mistake.

export const AIRTABLE_IDS = {
  dbTable: 'tblEYOgRDRg0aYfzI',
  companiesTable: 'tblDk8o4Nb4mFAEa8',
  contactsTable: 'tbl87CQnAjpKigu7i',
  db: {
    website: 'fldOtfQ8mk0W0quRi',
    name: 'fldk8Ah5DzqNdC9Lw',
    mailingName: 'flda4VsftBlL1kbvy',
    linkedin: 'fldPbtYqIJ8B2XP4O',
    country: 'fldSpGDwW6tHBCEv7',
    foundedYear: 'fldntEDvhQv7gZKXk',
    employees: 'fldHMWH6nF9SwnJgL',
    industry: 'fld0q8PFtHszKqXIc',
    keywords: 'fldaN1Aj5VIEMf5vo',
    description: 'fldN4Gf1ee5iVG0Xs',
    initialStatus: 'fldvNEA1HtWxMUVGW',
    addedToCompanies: 'fldguxuyDXVp3BqkK',
    addedBy: 'fldd8NOGRQVzR8Zqw',
  },
  companies: {
    name: 'fldxi1YhTYAOPaWSR',
    mailingName: 'fld2lNvsLo7MV6IMt',
    website: 'fldQxdTVpDHxJRETw',
    linkedin: 'fld0JvyDrKHUhoWHF',
    country: 'fldHe49wbgS40WHz5',
    foundedYear: 'fldPOYh7FRnyDwqiI',
    employees: 'fldHDIqyh9WEWkcjX',
    industry: 'fldoSQBNXOcapI0Eq',
    keywords: 'fldeb7TLWVT9cStYH',
    description: 'fldvtC5bj1UAv4d8u',
    approveStatus: 'flddoWKMzEJeWtawn',
    addedBy: 'fld1EGZGzOsuj4qkP',
  },
  contacts: {
    personaLinkedin: 'fldK74NyJu8IyzF3p',
    approveStatus: 'fldvZ9g6nKmVVzcGb',
    fullName: 'fld29jxXQLiJn9XGh',
    firstName: 'fldo5aVpTLrBFAcjG',
    title: 'fldNiybN18Z7uINN7',
    company: 'fldlqGy5MwA3vOlDD',
    addedBy: 'fldXGUenJLKc8MUZU',
  },
} as const

export interface AirtableRecord {
  id: string
  createdTime?: string
  fields: Record<string, unknown>
}

interface AirtableListResponse {
  records?: AirtableRecord[]
  offset?: string
}

interface AirtableCreateResponse {
  records?: AirtableRecord[]
}

export interface AirtableFieldSchema {
  id: string
  name: string
  type: string
  options?: {
    choices?: Array<{ id: string; name: string; color?: string }>
    linkedTableId?: string
  }
}

export interface AirtableTableSchema {
  id: string
  name: string
  fields: AirtableFieldSchema[]
}

interface AirtableSchemaResponse {
  tables?: AirtableTableSchema[]
}

export class AirtableError extends Error {
  status: number
  retryable: boolean

  constructor(message: string, status: number, retryable = false) {
    super(message)
    this.name = 'AirtableError'
    this.status = status
    this.retryable = retryable
  }
}

let nextRequestAt = 0

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function config() {
  const token = process.env.AIRTABLE_TOKEN
  const baseId = process.env.AIRTABLE_BASE_ID
  if (!token || !baseId) {
    throw new AirtableError(
      'Airtable is not configured (AIRTABLE_TOKEN and AIRTABLE_BASE_ID are required)',
      503,
    )
  }
  if (!/^app[a-zA-Z0-9]{14}$/.test(baseId)) {
    throw new AirtableError('AIRTABLE_BASE_ID is invalid', 503)
  }
  return { token, baseId }
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'string') return error
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message
      const type = (error as { type?: unknown }).type
      if (typeof message === 'string') return message
      if (typeof type === 'string') return type
    }
  }
  return `Airtable request failed (${status})`
}

async function airtableFetch<T>(
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  const { token } = config()

  // Airtable permits five requests/second/base. A 225 ms gap stays below that
  // ceiling even when one warm serverless process handles concurrent actions.
  const now = Date.now()
  const wait = Math.max(0, nextRequestAt - now)
  nextRequestAt = Math.max(now, nextRequestAt) + 225
  if (wait) await delay(wait)

  const response = await fetch(`https://api.airtable.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Preserve the status-based error below when Airtable returns non-JSON.
  }

  if (response.ok) return body as T

  if (response.status === 429 && attempt < 2) {
    await delay(30_000)
    return airtableFetch<T>(path, init, attempt + 1)
  }
  if (response.status >= 500 && attempt < 2) {
    await delay(1_000 * 2 ** attempt)
    return airtableFetch<T>(path, init, attempt + 1)
  }

  throw new AirtableError(
    errorMessage(body, response.status),
    response.status,
    response.status === 429 || response.status >= 500,
  )
}

export async function getAirtableSchema(): Promise<AirtableTableSchema[]> {
  const { baseId } = config()
  const response = await airtableFetch<AirtableSchemaResponse>(
    `/v0/meta/bases/${encodeURIComponent(baseId)}/tables`,
  )
  return response.tables ?? []
}

export async function listAllRecords(
  tableId: string,
  fieldIds: readonly string[],
): Promise<AirtableRecord[]> {
  const { baseId } = config()
  const records: AirtableRecord[] = []
  let offset: string | undefined

  do {
    const params = new URLSearchParams({
      pageSize: '100',
      returnFieldsByFieldId: 'true',
    })
    for (const fieldId of fieldIds) params.append('fields[]', fieldId)
    if (offset) params.set('offset', offset)

    const response = await airtableFetch<AirtableListResponse>(
      `/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?${params}`,
    )
    records.push(...(response.records ?? []))
    offset = response.offset
  } while (offset)

  return records
}

/**
 * Records matching `formula`, read through the POST `listRecords` endpoint so a
 * long formula is not bounded by the URL length. Callers build the formula from
 * values they have already constrained or escaped (see `formulaString`).
 */
export async function findRecordsByFormula(
  tableId: string,
  formula: string,
  fieldIds: readonly string[],
): Promise<AirtableRecord[]> {
  const { baseId } = config()
  const records: AirtableRecord[] = []
  let offset: string | undefined

  do {
    const response = await airtableFetch<AirtableListResponse>(
      `/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/listRecords`,
      {
        method: 'POST',
        body: JSON.stringify({
          filterByFormula: formula,
          pageSize: 100,
          returnFieldsByFieldId: true,
          fields: fieldIds,
          ...(offset ? { offset } : {}),
        }),
      },
    )
    records.push(...(response.records ?? []))
    offset = response.offset
  } while (offset)

  return records
}

/**
 * A formula string literal. Backslashes and double quotes are escaped, control
 * characters become spaces, and the value is capped so one cell cannot inflate
 * a formula past what a request carries.
 */
export function formulaString(value: string, maxLength = 200): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, maxLength)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
  return `"${cleaned}"`
}

/** The only tables an importer may create records in. Companies is not one. */
export const WRITABLE_TABLES: ReadonlySet<string> = new Set([
  AIRTABLE_IDS.dbTable,
  AIRTABLE_IDS.contactsTable,
])

export async function createRecords(
  tableId: string,
  fields: Array<Record<string, unknown>>,
): Promise<AirtableRecord[]> {
  if (!WRITABLE_TABLES.has(tableId)) {
    throw new AirtableError('Importers may only create records in DB or Contacts', 500)
  }
  if (fields.length === 0 || fields.length > 10) {
    throw new AirtableError('Airtable create batch must contain 1–10 records', 500)
  }
  const { baseId } = config()
  const params = new URLSearchParams({ returnFieldsByFieldId: 'true' })
  const response = await airtableFetch<AirtableCreateResponse>(
    `/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?${params}`,
    {
      method: 'POST',
      // Never typecast: the live select fields are already polluted by past
      // typecast imports. Every select value written is checked against the
      // schema's current choices first.
      body: JSON.stringify({
        typecast: false,
        records: fields.map((recordFields) => ({ fields: recordFields })),
      }),
    },
  )
  return response.records ?? []
}
