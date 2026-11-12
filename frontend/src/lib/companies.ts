/**
 * The Companies page's client (`#/companies`, ledger step 030): reads through
 * the application read endpoint, and the two writes on `/api/import`.
 *
 * A company here is an **Airtable** company reached through the lead ↔ company
 * link, never LH2's `leads.company` (the person's current employer, shown only
 * as a hint). Every count is per person, and every rate is over invited people.
 */

import { authFetch, authPost } from './api'
import { READ_OPS, readPage, type ApiFetch } from './dashboardReads'
import { AIRTABLE_BASES } from './airtableBases'
import type { CompanyLinkRef } from './types'

export interface FacetOption {
  value: string
  label: string
  count: number
}

/** One company with its funnel over linked people (all counts are people). */
export interface CompanyRow {
  base_key: string
  record_id: string
  name: string | null
  website: string | null
  domain: string | null
  linkedin_url: string | null
  hq_country: string | null
  country_code: string | null
  country_name: string | null
  industry: string | null
  employees: number | null
  ai_niche: string | null
  approve_status: string | null
  leads: number
  invited: number
  connected: number
  accepted_of_invited: number
  first_message: number
  replied: number
  p3: number
  last_activity: string | null
  accounts: number
  /** accepted ÷ invited, 0–1; null with no invites. */
  accept_rate: number | null
}

export interface CompaniesPage {
  items: CompanyRow[]
  total: number
  allTotal: number
  facets: {
    countries: FacetOption[]
    industries: FacetOption[]
    bases: FacetOption[]
    approveStatuses: FacetOption[]
  }
}

export interface CompanyDetail extends CompanyRow {
  founded_year: number | null
  description: string | null
  summary: string | null
  keywords: string | null
  web_app_link: string | null
  airtable_created: string | null
  airtable_modified: string | null
  synced_at: string | null
  /** Invited people whose invite is younger than 21 days. */
  maturing: number
  /** Every Airtable field, by field name. */
  fields: Record<string, unknown>
}

export interface UnlinkedLead {
  instance_id: string
  profile_url: string
  full_name: string | null
  headline: string | null
  /** LH2's current company — a hint, not the company the lead is written to for. */
  company: string | null
  country_code: string | null
  location: string | null
  invited: boolean
  replied: boolean
  last_action_at: string | null
  campaigns: string[]
}

export interface UnlinkedPage {
  items: UnlinkedLead[]
  total: number
  allTotal: number
}

export type CountryAxis = 'lead' | 'company'

export interface CountryFunnelRow {
  /** null is the Unknown row. */
  iso2: string | null
  name: string
  region: string | null
  people: number
  invited: number
  accepted: number
  replied: number
  p3: number
  companies: number
  maturing: number
  accept_rate: number | null
  reply_rate: number | null
  p3_rate: number | null
  maturing_share: number | null
  maturing_flag: boolean
}

export interface CountriesFunnel {
  axis: CountryAxis
  rows: CountryFunnelRow[]
  unresolved: Array<{ value: string; people: number; companies: number }>
  totals: { people: number; invited: number; accepted: number; replied: number; p3: number; maturing: number }
  unlinked_people: number
}

export interface LeadCompanyLink {
  location: string | null
  country_code: string | null
  country_name: string | null
  company_link: CompanyLinkRef | null
}

export const COMPANY_SIZE_OPTIONS = [
  { id: '1-10', label: '1–10' },
  { id: '11-50', label: '11–50' },
  { id: '51-200', label: '51–200' },
  { id: '201-500', label: '201–500' },
  { id: '501-1000', label: '501–1,000' },
  { id: '1001-5000', label: '1,001–5,000' },
  { id: '5000+', label: '5,000+' },
  { id: 'unknown', label: 'Unknown' },
] as const

export interface CompaniesQuery {
  scope?: 'linked' | 'all'
  inst?: string
  q?: string
  country?: string
  industry?: string
  size?: string
  approve?: string
  base?: string
  reply?: string
  sort?: string
  dir?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

const filterValue = (value: string | undefined): string | null =>
  !value || value === 'all' ? null : value

function onlyRow<T>(operation: string, items: readonly T[]): T {
  const row = items[0]
  if (!row) throw new Error(`${operation}: response contained no page`)
  return row
}

export async function fetchCompaniesPage(
  query: CompaniesQuery,
  fetchImpl: ApiFetch = authFetch,
  signal?: AbortSignal,
): Promise<CompaniesPage> {
  const page = await readPage<CompaniesPage>(READ_OPS.companiesSearchPage, {
    scope: query.scope ?? 'linked',
    instance_id: filterValue(query.inst),
    q: query.q?.trim() || null,
    country: filterValue(query.country),
    industry: filterValue(query.industry),
    size: filterValue(query.size),
    approve: filterValue(query.approve),
    base: filterValue(query.base),
    reply: filterValue(query.reply),
    sort: query.sort ?? null,
    dir: query.dir ?? null,
    page: query.page ?? 0,
    page_size: query.pageSize ?? 50,
    limit: 1,
  }, fetchImpl, signal)
  return onlyRow(READ_OPS.companiesSearchPage, page.items)
}

export async function fetchCompanyDetail(
  base: string,
  recordId: string,
  fetchImpl: ApiFetch = authFetch,
): Promise<CompanyDetail | null> {
  const page = await readPage<CompanyDetail>(
    READ_OPS.companyDetail,
    { base, record_id: recordId, limit: 1 },
    fetchImpl,
  )
  return page.items[0] ?? null
}

export async function fetchUnlinkedLeads(
  query: { inst?: string; q?: string; reach?: string; page?: number; pageSize?: number },
  fetchImpl: ApiFetch = authFetch,
): Promise<UnlinkedPage> {
  const page = await readPage<UnlinkedPage>(READ_OPS.companiesUnlinked, {
    instance_id: filterValue(query.inst),
    q: query.q?.trim() || null,
    reach: filterValue(query.reach),
    page: query.page ?? 0,
    page_size: query.pageSize ?? 50,
    limit: 1,
  }, fetchImpl)
  return onlyRow(READ_OPS.companiesUnlinked, page.items)
}

export async function fetchCountriesFunnel(
  query: { axis?: CountryAxis; inst?: string; camp?: string; from?: string; to?: string },
  fetchImpl: ApiFetch = authFetch,
): Promise<CountriesFunnel> {
  const page = await readPage<CountriesFunnel>(READ_OPS.countriesFunnel, {
    axis: query.axis ?? 'lead',
    instance_id: filterValue(query.inst),
    camp: filterValue(query.camp),
    invited_from: query.from || null,
    invited_to: query.to || null,
    limit: 1,
  }, fetchImpl)
  return onlyRow(READ_OPS.countriesFunnel, page.items)
}

/** One conversation's location, country and company link; null when the lead
 *  has no row (a conversation with no lead behind it). */
export async function fetchLeadCompanyLink(
  instanceId: string,
  profileUrl: string,
  fetchImpl: ApiFetch = authFetch,
): Promise<LeadCompanyLink | null> {
  const page = await readPage<LeadCompanyLink>(
    READ_OPS.leadCompanyLink,
    { instance_id: instanceId, profile_url: profileUrl, limit: 1 },
    fetchImpl,
  )
  return page.items[0] ?? null
}

// ---------------------------------------------------------------------------
// Writes, on /api/import
// ---------------------------------------------------------------------------

/** Mirrors `AirtableSyncResult` in api/_lib/airtableSync.ts. */
export interface AirtableSyncRound {
  done: boolean
  bases: Array<{
    base: string
    configured: boolean
    companies?: { upserted: number; done: boolean; error?: string }
    contacts?: { upserted: number; done: boolean; error?: string }
    error?: string
  }>
  links: { leads: number; matched: number; changed: number; linked: number } | null
  links_error?: string
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await authPost(url, body)
  const j = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !j) throw new Error(j?.error || `HTTP ${res.status}`)
  return j
}

/** One resumable round of the Airtable → Neon sync. Repeat while `done` is false. */
export function syncAirtableRound(): Promise<AirtableSyncRound> {
  return postJson<AirtableSyncRound>('/api/import?op=airtable.sync', {})
}

/** At most this many rounds per click; the next click resumes where it stopped. */
export const MAX_SYNC_ROUNDS = 10

export interface AirtableSyncSummary {
  rounds: number
  done: boolean
  companies: number
  contacts: number
  links: AirtableSyncRound['links'] | null
  errors: string[]
}

/** Run rounds until the sync says it is done (or `MAX_SYNC_ROUNDS`). */
export async function runAirtableSync(
  onRound?: (round: number, result: AirtableSyncRound) => void,
  sync: () => Promise<AirtableSyncRound> = syncAirtableRound,
): Promise<AirtableSyncSummary> {
  const summary: AirtableSyncSummary = {
    rounds: 0, done: false, companies: 0, contacts: 0, links: null, errors: [],
  }
  while (summary.rounds < MAX_SYNC_ROUNDS) {
    const result = await sync()
    summary.rounds += 1
    let failed = false
    for (const base of result.bases ?? []) {
      summary.companies += base.companies?.upserted ?? 0
      summary.contacts += base.contacts?.upserted ?? 0
      for (const error of [base.error, base.companies?.error, base.contacts?.error]) {
        if (!error) continue
        failed = true
        if (!summary.errors.includes(`${base.base}: ${error}`)) summary.errors.push(`${base.base}: ${error}`)
      }
    }
    if (result.links_error) {
      failed = true
      summary.errors.push(`links: ${result.links_error}`)
    }
    summary.links = result.links ?? summary.links
    onRound?.(summary.rounds, result)
    if (result.done !== false) {
      summary.done = true
      break
    }
    // An Airtable or database error does not clear by asking again at once;
    // only an unfinished (time-budgeted) round is worth repeating.
    if (failed) break
  }
  return summary
}

/** Link a lead to an Airtable company by hand; `recordId` null clears a manual link. */
export function linkLeadToCompany(input: {
  instance_id: string
  profile_url: string
  base_key: string
  record_id: string | null
}): Promise<{ ok: true; link: { base_key: string; record_id: string; method: string } | null }> {
  return postJson('/api/import?op=company.link', input)
}

/** The base's display name (`Web 2 Mob`), or its key when unknown. */
export function baseLabel(id: string): string {
  return AIRTABLE_BASES.find((base) => base.id === id)?.label ?? id
}

/** `#/companies/<base>/<record>` for a link. */
export function companyHref(link: { base_key: string; record_id: string }): string {
  return `/companies/${encodeURIComponent(link.base_key)}/${encodeURIComponent(link.record_id)}`
}

let regionNames: Intl.DisplayNames | null | undefined
/** English country name for an ISO alpha-2 code, without a round trip. */
export function countryName(code: string | null | undefined): string | null {
  if (!code) return null
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
    } catch {
      regionNames = null
    }
  }
  try {
    return regionNames?.of(code.toUpperCase()) ?? code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}

/** "Lisbon, Portugal · PT"-style line: the raw location, then the resolved code when it adds something. */
export function locationLine(location: string | null | undefined, code: string | null | undefined): string | null {
  const name = countryName(code)
  if (location && name) {
    return location.toLowerCase().includes(name.toLowerCase()) ? location : `${location} · ${name}`
  }
  return location || name || null
}

export function percent(value: number | null | undefined): string {
  if (value == null) return '—'
  return `${(value * 100).toFixed(value >= 0.1 || value === 0 ? 0 : 1)}%`
}
