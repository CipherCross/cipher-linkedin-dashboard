import type { ContactImportRow } from './csvImport'

export interface ImportMetadata {
  source: 'apollo'
  mappingVersion: number
  addedBy: string[]
  limits: { maxRows: number; maxFileBytes: number }
}

export interface AirtableCompany {
  id: string
  name: string
  website: string
  linkedin: string
}

export type PreviewStatus = 'ready' | 'duplicate' | 'invalid' | 'company_action'

export interface PreviewRowResult {
  rowNumber: number
  status: PreviewStatus
  reason?: string
  company?: AirtableCompany
  matchMethod?: 'linkedin' | 'domain' | 'name'
  suggestions?: AirtableCompany[]
  contactIds?: string[]
}

export interface PreviewResponse {
  results: PreviewRowResult[]
  counts: Record<string, number>
}

export interface CommitInputRow {
  rowNumber: number
  personLinkedin: string
  firstName: string
  fullName: string
  title: string
  companyId: string
}

export interface CommitRowResult {
  rowNumber: number
  status: 'created' | 'duplicate' | 'failed'
  contactId?: string
  error?: string
}

export interface CommitResponse {
  results: CommitRowResult[]
  counts: { created: number; duplicate: number; failed: number }
}

async function importPost<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let payload: { error?: string } & Partial<T>
  try {
    payload = await response.json()
  } catch {
    throw new Error(`Import service returned HTTP ${response.status}`)
  }
  if (!response.ok) throw new Error(payload.error || `Import service returned HTTP ${response.status}`)
  return payload as T
}

export function fetchImportMetadata(): Promise<ImportMetadata> {
  return importPost<ImportMetadata>({ action: 'contact_metadata' })
}

export function previewContacts(rows: ContactImportRow[]): Promise<PreviewResponse> {
  return importPost<PreviewResponse>({ action: 'contact_preview', rows })
}

export async function searchAirtableCompanies(query: string): Promise<AirtableCompany[]> {
  const response = await importPost<{ companies: AirtableCompany[] }>({
    action: 'company_search',
    query,
  })
  return response.companies
}

export function commitContacts(
  addedBy: string,
  rows: CommitInputRow[],
): Promise<CommitResponse> {
  return importPost<CommitResponse>({ action: 'contact_commit', addedBy, rows })
}
