// Narrow Airtable Web API adapter for the Apollo Contact and Company importers. This is
// deliberately not a generic proxy: callers cannot choose a base, table, or
// field. Stable Airtable IDs keep harmless display-name changes from breaking
// writes, while schema validation in contactImport.ts fails closed if a field is
// deleted or retyped.

export const AIRTABLE_IDS = {
  companiesTable: 'tblDk8o4Nb4mFAEa8',
  contactsTable: 'tbl87CQnAjpKigu7i',
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

interface AirtableRecord {
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

export async function createRecords(
  tableId: string,
  fields: Array<Record<string, unknown>>,
): Promise<AirtableRecord[]> {
  if (fields.length === 0 || fields.length > 10) {
    throw new AirtableError('Airtable create batch must contain 1–10 records', 500)
  }
  const { baseId } = config()
  const params = new URLSearchParams({ returnFieldsByFieldId: 'true' })
  const response = await airtableFetch<AirtableCreateResponse>(
    `/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?${params}`,
    {
      method: 'POST',
      body: JSON.stringify({
        typecast: false,
        records: fields.map((recordFields) => ({ fields: recordFields })),
      }),
    },
  )
  return response.records ?? []
}
