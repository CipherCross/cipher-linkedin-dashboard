/**
 * What the AI coach knows about the lead, their company and us (ledger step
 * 028): the LH2 profile the agent delivers, and three server-written caches —
 * the company from Airtable, the company website's text, and "our company" on
 * the playbook row. Every statement is fixed text with bound parameters.
 */

import type { NeonCommandOperation, NeonQueryOperation, NeonRow } from '../neon.js'

export const COACH_CONTEXT_OPERATIONS = {
  profile: 'coachContext.profile',
  company: 'coachContext.company',
  site: 'coachContext.site',
  ourCompany: 'coachContext.ourCompany',
  schemaReports: 'coachContext.schemaReports',
} as const

export const COACH_CONTEXT_COMMANDS = {
  upsertCompany: 'coachContext.upsertCompany',
  upsertSite: 'coachContext.upsertSite',
  saveOurCompany: 'coachContext.saveOurCompany',
} as const

const nullableText = (row: NeonRow, column: string): string | null =>
  row[column] === null || row[column] === undefined ? null : String(row[column])
const jsonArray = (row: NeonRow, column: string): unknown[] =>
  Array.isArray(row[column]) ? (row[column] as unknown[]) : []

export interface ThreadKeyParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly [key: string]: string
}

export interface LeadProfileContextRow {
  readonly about: string | null
  readonly location: string | null
  readonly current_title: string | null
  readonly current_company: string | null
  readonly positions: unknown[]
  readonly skills: unknown[]
  readonly synced_at: string
}

export const profileOperation: NeonQueryOperation<LeadProfileContextRow, ThreadKeyParams> = {
  build: ({ params }) => ({
    text: `SELECT about, location, current_title, current_company, positions, skills, synced_at
             FROM public.lead_profiles
            WHERE instance_id = $1 AND profile_url = $2`,
    values: [params?.instanceId ?? null, params?.profileUrl ?? null],
  }),
  mapRow: (row) => ({
    about: nullableText(row, 'about'),
    location: nullableText(row, 'location'),
    current_title: nullableText(row, 'current_title'),
    current_company: nullableText(row, 'current_company'),
    positions: jsonArray(row, 'positions'),
    skills: jsonArray(row, 'skills'),
    synced_at: String(row.synced_at),
  }),
}

export interface CompanyContextRow {
  readonly found: boolean
  readonly company_name: string | null
  readonly website: string | null
  readonly industry: string | null
  readonly employees: string | null
  readonly founded_year: string | null
  readonly country: string | null
  readonly keywords: string | null
  readonly description: string | null
  readonly fetched_at: string
}

const COMPANY_COLUMNS = ['company_name', 'website', 'industry', 'employees', 'founded_year', 'country', 'keywords', 'description'] as const

export const companyOperation: NeonQueryOperation<CompanyContextRow, ThreadKeyParams> = {
  build: ({ params }) => ({
    text: `SELECT found, ${COMPANY_COLUMNS.join(', ')}, fetched_at
             FROM public.lead_company_context
            WHERE instance_id = $1 AND profile_url = $2`,
    values: [params?.instanceId ?? null, params?.profileUrl ?? null],
  }),
  mapRow: (row) => ({
    found: row.found === true,
    company_name: nullableText(row, 'company_name'),
    website: nullableText(row, 'website'),
    industry: nullableText(row, 'industry'),
    employees: nullableText(row, 'employees'),
    founded_year: nullableText(row, 'founded_year'),
    country: nullableText(row, 'country'),
    keywords: nullableText(row, 'keywords'),
    description: nullableText(row, 'description'),
    fetched_at: String(row.fetched_at),
  }),
}

export interface UpsertCompanyParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly found: boolean
  readonly companyName: string | null
  readonly website: string | null
  readonly industry: string | null
  readonly employees: string | null
  readonly foundedYear: string | null
  readonly country: string | null
  readonly keywords: string | null
  readonly description: string | null
  readonly [key: string]: string | boolean | null
}

export const upsertCompanyOperation: NeonCommandOperation<void, UpsertCompanyParams> = {
  build: ({ params }) => {
    if (!params) throw new Error('coachContext.upsertCompany requires parameters')
    return {
      text: `INSERT INTO public.lead_company_context
                    (instance_id, profile_url, found, ${COMPANY_COLUMNS.join(', ')}, fetched_at)
             VALUES ($1, $2, $3, left($4, 500), left($5, 500), left($6, 500), left($7, 100),
                     left($8, 20), left($9, 200), left($10, 4000), left($11, 8000), now())
             ON CONFLICT (instance_id, profile_url) DO UPDATE SET
               found = EXCLUDED.found, company_name = EXCLUDED.company_name, website = EXCLUDED.website,
               industry = EXCLUDED.industry, employees = EXCLUDED.employees,
               founded_year = EXCLUDED.founded_year, country = EXCLUDED.country,
               keywords = EXCLUDED.keywords, description = EXCLUDED.description, fetched_at = now()`,
      values: [
        params.instanceId, params.profileUrl, params.found, params.companyName, params.website,
        params.industry, params.employees, params.foundedYear, params.country, params.keywords,
        params.description,
      ],
    }
  },
}

export interface SiteSnapshotRow {
  readonly domain: string
  readonly url: string
  readonly title: string | null
  readonly body: string | null
  readonly thin: boolean
  readonly error: string | null
  readonly fetched_at: string
}

export interface DomainParams {
  readonly domain: string
  readonly [key: string]: string
}

export const siteOperation: NeonQueryOperation<SiteSnapshotRow, DomainParams> = {
  build: ({ params }) => ({
    text: `SELECT domain, url, title, body, thin, error, fetched_at
             FROM public.company_site_snapshots WHERE domain = $1`,
    values: [params?.domain ?? null],
  }),
  mapRow: (row) => ({
    domain: String(row.domain),
    url: String(row.url),
    title: nullableText(row, 'title'),
    body: nullableText(row, 'body'),
    thin: row.thin === true,
    error: nullableText(row, 'error'),
    fetched_at: String(row.fetched_at),
  }),
}

export interface UpsertSiteParams {
  readonly domain: string
  readonly url: string
  readonly title: string | null
  readonly body: string | null
  readonly thin: boolean
  readonly error: string | null
  readonly [key: string]: string | boolean | null
}

export const upsertSiteOperation: NeonCommandOperation<void, UpsertSiteParams> = {
  build: ({ params }) => {
    if (!params) throw new Error('coachContext.upsertSite requires parameters')
    return {
      text: `INSERT INTO public.company_site_snapshots (domain, url, title, body, thin, error, fetched_at)
             VALUES ($1, left($2, 1000), left($3, 500), left($4, 20000), $5, left($6, 500), now())
             ON CONFLICT (domain) DO UPDATE SET
               url = EXCLUDED.url, title = EXCLUDED.title, body = EXCLUDED.body,
               thin = EXCLUDED.thin, error = EXCLUDED.error, fetched_at = now()`,
      values: [params.domain, params.url, params.title, params.body, params.thin, params.error],
    }
  },
}

export interface OurCompanyRow {
  readonly our_company: string
  readonly our_website: string | null
  readonly updated_at: string | null
}

/** The playbook singleton's "our company" half. No row yet answers nothing. */
const mapOurCompany = (row: NeonRow): OurCompanyRow => ({
  our_company: String(row.our_company ?? ''),
  our_website: nullableText(row, 'our_website'),
  updated_at: nullableText(row, 'updated_at'),
})

export const ourCompanyOperation: NeonQueryOperation<OurCompanyRow> = {
  build: () => ({
    text: `SELECT our_company, our_website, updated_at FROM public.playbook WHERE id = true`,
  }),
  mapRow: mapOurCompany,
}

export interface SaveOurCompanyParams {
  readonly ourCompany: string
  readonly ourWebsite: string | null
  readonly [key: string]: string | null
}

/** Writes only the two "our company" columns; the playbook text is untouched. */
export const saveOurCompanyOperation: NeonCommandOperation<OurCompanyRow | null, SaveOurCompanyParams> = {
  build: ({ params }) => {
    if (!params) throw new Error('coachContext.saveOurCompany requires parameters')
    return {
      text: `INSERT INTO public.playbook (id, our_company, our_website, updated_at)
             VALUES (true, $1, $2, now())
             ON CONFLICT (id) DO UPDATE SET
               our_company = EXCLUDED.our_company, our_website = EXCLUDED.our_website, updated_at = now()
             RETURNING our_company, our_website, updated_at`,
      values: [params.ourCompany, params.ourWebsite],
    }
  },
  mapResult: (rows) => {
    const row = rows[0]
    return row ? mapOurCompany(row) : null
  },
}

export interface SchemaReportRow {
  readonly instance_id: string
  readonly person_tables: Record<string, string[]>
  readonly reported_at: string
}

/** Each notebook's LH2 person tables and columns (names only). */
export const schemaReportsOperation: NeonQueryOperation<SchemaReportRow> = {
  build: () => ({
    text: `SELECT instance_id, person_tables, reported_at FROM public.lh2_schema_reports ORDER BY instance_id`,
  }),
  mapRow: (row) => ({
    instance_id: String(row.instance_id),
    person_tables: row.person_tables && typeof row.person_tables === 'object'
      ? (row.person_tables as Record<string, string[]>) : {},
    reported_at: String(row.reported_at),
  }),
}
