import type { CompanyImportRow, LeadImportRow } from './csvImport'
import { authFetch } from './api'
import type { AirtableBaseId } from './airtableBases'

// Every call names the Airtable base it reads and writes; the server never
// mixes bases inside one request.

export interface ImportMetadata {
  target: 'db' | 'contacts'
  base: AirtableBaseId
  addedBy: string[]
  limits: { maxRows: number; maxFileBytes: number }
}

export interface AirtableCompany {
  id: string
  name: string
  website: string
  linkedin: string
  /** Companies `Approve Status`. A Rejected record can never be linked. */
  approveStatus: string
}

// --------------------------------------------------------- Companies → DB

export interface CompanyLocation {
  table: 'DB' | 'Companies' | 'File'
  id?: string
  rowNumber?: number
  name: string
  website: string
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

export interface CompanyPreviewResponse {
  results: CompanyPreviewResult[]
  counts: Record<string, number>
}

export interface CompanyCommitResult {
  rowNumber: number
  status: 'created' | 'duplicate' | 'failed'
  domain: string
  recordId?: string
  error?: string
  matches?: CompanyLocation[]
}

export interface CompanyCommitResponse {
  results: CompanyCommitResult[]
  counts: { created: number; duplicate: number; failed: number }
}

// ----------------------------------------------------- Leads → Contacts

export type LeadGroupStatus = 'suggested' | 'ambiguous' | 'pending' | 'declined' | 'not_uploaded'

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
  status: LeadGroupStatus
  method?: 'domain' | 'linkedin' | 'name'
  suggestion?: AirtableCompany
  candidates: AirtableCompany[]
  rejected: AirtableCompany[]
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
  /** Companies records named in the lead's headline, other than its CSV company. */
  headlineMatches?: AirtableCompany[]
}

export interface LeadPreviewResponse {
  rows: LeadRowResult[]
  groups: LeadGroup[]
  counts: Record<string, number>
}

export interface ContactCommitRow {
  rowNumber: number
  personLinkedin: string
  firstName: string
  fullName: string
  title: string
  companyId: string
  companyWebsite: string
}

export interface ContactCommitResult {
  rowNumber: number
  status: 'created' | 'duplicate' | 'failed'
  contactId?: string
  error?: string
}

export interface ContactCommitResponse {
  results: ContactCommitResult[]
  counts: { created: number; duplicate: number; failed: number }
}

const MAX_IMPORT_BODY_BYTES = 3_800_000

async function importPost<T>(body: Record<string, unknown>): Promise<T> {
  const serialized = JSON.stringify(body)
  if (new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_BODY_BYTES) {
    throw new Error('This import is too large to send safely. Split the CSV into smaller files and try again.')
  }
  const response = await authFetch('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: serialized,
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

export function fetchCompanyImportMetadata(base: AirtableBaseId): Promise<ImportMetadata> {
  return importPost<ImportMetadata>({ action: 'company_metadata', base })
}

export function previewCompanies(
  base: AirtableBaseId,
  rows: CompanyImportRow[],
): Promise<CompanyPreviewResponse> {
  return importPost<CompanyPreviewResponse>({ action: 'company_preview', base, rows })
}

export function commitCompanies(
  base: AirtableBaseId,
  addedBy: string,
  rows: CompanyImportRow[],
): Promise<CompanyCommitResponse> {
  return importPost<CompanyCommitResponse>({ action: 'company_commit', base, addedBy, rows })
}

export function fetchContactImportMetadata(base: AirtableBaseId): Promise<ImportMetadata> {
  return importPost<ImportMetadata>({ action: 'contact_metadata', base })
}

export function previewLeads(
  base: AirtableBaseId,
  rows: LeadImportRow[],
  options: { forceCompanies?: boolean } = {},
): Promise<LeadPreviewResponse> {
  return importPost<LeadPreviewResponse>({
    action: 'contact_preview',
    base,
    rows,
    forceCompanies: options.forceCompanies === true,
  })
}

export async function searchAirtableCompanies(
  base: AirtableBaseId,
  query: string,
): Promise<AirtableCompany[]> {
  const response = await importPost<{ companies: AirtableCompany[] }>({
    action: 'company_search',
    base,
    query,
  })
  return response.companies
}

export function commitContacts(
  base: AirtableBaseId,
  addedBy: string,
  rows: ContactCommitRow[],
): Promise<ContactCommitResponse> {
  return importPost<ContactCommitResponse>({ action: 'contact_commit', base, addedBy, rows })
}
