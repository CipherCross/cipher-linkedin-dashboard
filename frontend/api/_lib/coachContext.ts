// What the AI coach knows beyond the thread (spec specs/2026-10-20-coach-lead-context.md):
//
//   <lead_profile>     the lead's LinkedIn profile as LH2 scraped it (the agent syncs it)
//   <company>          their company as the Apollo import recorded it in Airtable
//   <company_website>  readable text of that company's website
//   <our_company>      what we sell, to whom, our proof points (Playbook page)
//
// The company and website are server-side caches, refreshed when stale (7 and
// 30 days) on the request that needs them. Every refresh is best-effort: a
// failure leaves the coach with less context, never without a take. The
// harness tells the model these blocks are reference data, never instructions,
// and that facts outside them still go in [brackets].
import { createHash } from 'node:crypto'
import type { ActorContext, DataStore } from './data/contracts.js'
import { DataStoreContractError, DataStoreSchemaError } from './data/contracts.js'
import {
  COACH_CONTEXT_COMMANDS,
  COACH_CONTEXT_OPERATIONS,
  type CompanyContextRow,
  type LeadProfileContextRow,
  type OurCompanyRow,
  type SiteSnapshotRow,
} from './data/operations/coachContext.js'
import { AIRTABLE_IDS, findRecordsByFormula, formulaString, type AirtableRecord } from './airtable.js'
import { SiteFetchError, domainOf, fetchSiteText } from './siteText.js'
import { formatStamp } from './coachCore.js'

const COMPANY_TTL_MS = 7 * 86_400_000
const SITE_TTL_MS = 30 * 86_400_000
const ABOUT_CAP = 1500
const DESCRIPTION_CAP = 1500
const SITE_CAP = 3000
const OUR_COMPANY_CAP = 4000

export interface CoachContext {
  readonly profile: LeadProfileContextRow | null
  readonly company: CompanyContextRow | null
  readonly site: SiteSnapshotRow | null
  readonly ourCompany: OurCompanyRow | null
}

export const EMPTY_CONTEXT: CoachContext = { profile: null, company: null, site: null, ourCompany: null }

function safeLabel(error: unknown): string {
  if (error instanceof DataStoreContractError) return `${error.name}(${error.code})`
  if (error instanceof Error) return error.name
  return 'UnknownError'
}

async function first<TRow>(store: DataStore, actor: ActorContext, operation: string, params?: Record<string, string>) {
  const page = await store.query<TRow>(actor, { operation, params, page: { limit: 1 } })
  return page.items[0] ?? null
}

/** Context is an extra, never a precondition: a read that fails — a database
 *  without step 028, or anything else — leaves that source out of the take. */
async function tolerant<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (!(error instanceof DataStoreSchemaError)) console.error('coach context: a read was skipped:', safeLabel(error))
    return null
  }
}

// ---------------------------------------------------------------------------
// Airtable: the lead's company.
// ---------------------------------------------------------------------------

const asText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(', ') || null
  if (typeof value === 'object') {
    const named = (value as { name?: unknown }).name
    return typeof named === 'string' ? named : null
  }
  const text = String(value).trim()
  return text || null
}

const COMPANY_FIELDS = [
  AIRTABLE_IDS.companies.name, AIRTABLE_IDS.companies.website, AIRTABLE_IDS.companies.industry,
  AIRTABLE_IDS.companies.employees, AIRTABLE_IDS.companies.foundedYear, AIRTABLE_IDS.companies.country,
  AIRTABLE_IDS.companies.keywords, AIRTABLE_IDS.companies.description,
] as const

export interface CompanyFacts {
  readonly company_name: string | null
  readonly website: string | null
  readonly industry: string | null
  readonly employees: string | null
  readonly founded_year: string | null
  readonly country: string | null
  readonly keywords: string | null
  readonly description: string | null
}

function factsOf(record: AirtableRecord): CompanyFacts {
  const f = record.fields
  return {
    company_name: asText(f[AIRTABLE_IDS.companies.name]),
    website: asText(f[AIRTABLE_IDS.companies.website]),
    industry: asText(f[AIRTABLE_IDS.companies.industry]),
    employees: asText(f[AIRTABLE_IDS.companies.employees]),
    founded_year: asText(f[AIRTABLE_IDS.companies.foundedYear]),
    country: asText(f[AIRTABLE_IDS.companies.country]),
    keywords: asText(f[AIRTABLE_IDS.companies.keywords]),
    description: asText(f[AIRTABLE_IDS.companies.description]),
  }
}

/** `linkedin.com/in/<slug>/` for a lead's profile URL, lower case, or ''. */
export function personLinkedinNeedle(profileUrl: string): string {
  const match = /linkedin\.com\/in\/([^/?#]+)/i.exec(profileUrl)
  if (!match) return ''
  let slug = match[1]
  try { slug = decodeURIComponent(slug) } catch { /* keep as is */ }
  return `linkedin.com/in/${slug.toLowerCase()}/`
}

/** The lead's company: through their Airtable contact, else by an exact,
 *  unambiguous company-name match. Null when neither finds one. */
export async function airtableCompanyFor(profileUrl: string, companyName: string | null): Promise<CompanyFacts | null> {
  const needle = personLinkedinNeedle(profileUrl)
  if (needle) {
    const contacts = await findRecordsByFormula(
      AIRTABLE_IDS.contactsTable,
      `FIND(${formulaString(needle, 300)}, LOWER({${AIRTABLE_IDS.contacts.personaLinkedin}}&"") & "/")`,
      [AIRTABLE_IDS.contacts.company],
    )
    const companyId = contacts
      .map((c) => c.fields[AIRTABLE_IDS.contacts.company])
      .find((link): link is string[] => Array.isArray(link) && typeof link[0] === 'string')?.[0]
    if (companyId && /^rec[a-zA-Z0-9]{14}$/.test(companyId)) {
      const [company] = await findRecordsByFormula(
        AIRTABLE_IDS.companiesTable, `RECORD_ID()=${formulaString(companyId)}`, COMPANY_FIELDS,
      )
      if (company) return factsOf(company)
    }
  }
  const name = companyName?.trim()
  if (name) {
    const matches = await findRecordsByFormula(
      AIRTABLE_IDS.companiesTable,
      `LOWER(TRIM({${AIRTABLE_IDS.companies.name}}&""))=LOWER(${formulaString(name, 200)})`,
      COMPANY_FIELDS,
    )
    if (matches.length === 1) return factsOf(matches[0])
  }
  return null
}

// ---------------------------------------------------------------------------
// Loading, with refresh.
// ---------------------------------------------------------------------------

export interface ContextDeps {
  readonly companyFor?: typeof airtableCompanyFor
  readonly siteText?: typeof fetchSiteText
  readonly now?: () => Date
}

const stale = (at: string | null | undefined, ttl: number, now: Date) =>
  !at || now.getTime() - new Date(at).getTime() > ttl

/** The coach's context for one conversation. `refresh` fills stale caches
 *  (the coach and the modal); without it, only what is cached is read. */
export async function loadCoachContext(
  store: DataStore,
  actor: ActorContext,
  lead: { instance_id: string; profile_url: string; company?: string | null },
  options: { refresh: boolean } & ContextDeps = { refresh: true },
): Promise<CoachContext> {
  const now = options.now?.() ?? new Date()
  const key = { instanceId: lead.instance_id, profileUrl: lead.profile_url }
  const [profile, cachedCompany, ourCompany] = await Promise.all([
    tolerant(() => first<LeadProfileContextRow>(store, actor, COACH_CONTEXT_OPERATIONS.profile, key)),
    tolerant(() => first<CompanyContextRow>(store, actor, COACH_CONTEXT_OPERATIONS.company, key)),
    tolerant(() => first<OurCompanyRow>(store, actor, COACH_CONTEXT_OPERATIONS.ourCompany)),
  ])

  let company = cachedCompany
  if (options.refresh && stale(company?.fetched_at, COMPANY_TTL_MS, now)) {
    try {
      const facts = await (options.companyFor ?? airtableCompanyFor)(
        lead.profile_url, lead.company ?? profile?.current_company ?? null,
      )
      await store.transaction(actor, (tx) => tx.execute({
        operation: COACH_CONTEXT_COMMANDS.upsertCompany,
        params: {
          ...key,
          found: !!facts,
          companyName: facts?.company_name ?? null,
          website: facts?.website ?? null,
          industry: facts?.industry ?? null,
          employees: facts?.employees ?? null,
          foundedYear: facts?.founded_year ?? null,
          country: facts?.country ?? null,
          keywords: facts?.keywords ?? null,
          description: facts?.description ?? null,
        },
      }))
      company = { found: !!facts, ...(facts ?? {
        company_name: null, website: null, industry: null, employees: null,
        founded_year: null, country: null, keywords: null, description: null,
      }), fetched_at: now.toISOString() }
    } catch (error) {
      // Airtable unconfigured or down, or step 028 missing: coach with what we have.
      console.error('coach context: company refresh skipped:', safeLabel(error))
    }
  }

  let site: SiteSnapshotRow | null = null
  const domain = company?.website ? domainOf(company.website) : ''
  if (domain && /^[a-z0-9.-]{1,253}$/.test(domain)) {
    site = await tolerant(() => first<SiteSnapshotRow>(store, actor, COACH_CONTEXT_OPERATIONS.site, { domain }))
    if (options.refresh && stale(site?.fetched_at, SITE_TTL_MS, now)) {
      let fetched: { url: string; title: string | null; body: string | null; thin: boolean; error: string | null }
      try {
        const page = await (options.siteText ?? fetchSiteText)(company!.website!)
        fetched = { url: page.url, title: page.title, body: page.text, thin: page.thin, error: null }
      } catch (error) {
        fetched = {
          url: company!.website!, title: null, body: null, thin: true,
          error: error instanceof SiteFetchError ? error.message : 'The website could not be read',
        }
      }
      try {
        await store.transaction(actor, (tx) => tx.execute({
          operation: COACH_CONTEXT_COMMANDS.upsertSite,
          params: { domain, ...fetched },
        }))
      } catch (error) {
        console.error('coach context: website cache write skipped:', safeLabel(error))
      }
      site = { domain, ...fetched, fetched_at: now.toISOString() }
    }
  }

  return { profile, company, site, ourCompany }
}

// ---------------------------------------------------------------------------
// What the model reads.
// ---------------------------------------------------------------------------

const clip = (text: string | null | undefined, cap: number) => {
  const t = (text ?? '').trim()
  return t.length > cap ? `${t.slice(0, cap)}…` : t
}

const dated = (at: string | null | undefined) => {
  const d = at ? new Date(at) : null
  return d && !Number.isNaN(d.getTime()) ? formatStamp(d).replace(/, \d\d:\d\d$/, '') : 'unknown'
}

interface PositionLike { title?: unknown; company?: unknown; start_year?: unknown; end_year?: unknown; description?: unknown }

function positionLine(p: PositionLike): string {
  const what = [p.title, p.company].filter((x) => typeof x === 'string' && x).join(' at ')
  const years = p.start_year ? ` (${p.start_year}–${p.end_year ?? 'now'})` : ''
  const description = typeof p.description === 'string' && p.description ? ` — ${clip(p.description, 300)}` : ''
  return `${what}${years}${description}`
}

/** The context blocks, in the order the coach reads them. Empty sources are
 *  left out entirely. */
export function renderContextBlocks(ctx: CoachContext): string {
  const blocks: string[] = []
  const p = ctx.profile
  if (p && (p.about || p.location || p.positions.length || p.skills.length || p.current_title)) {
    const lines: string[] = []
    if (p.current_title || p.current_company) lines.push(`Current role: ${[p.current_title, p.current_company].filter(Boolean).join(' at ')}`)
    if (p.location) lines.push(`Location: ${p.location}`)
    const jobs = (p.positions as PositionLike[]).map(positionLine).filter(Boolean)
    if (jobs.length) lines.push(`Positions:\n${jobs.map((j) => `- ${j}`).join('\n')}`)
    if (p.about) lines.push(`About:\n${clip(p.about, ABOUT_CAP)}`)
    if (p.skills.length) lines.push(`Skills: ${p.skills.filter((s) => typeof s === 'string').join(', ')}`)
    blocks.push(`<lead_profile source="LinkedIn profile as Linked Helper scraped it" synced="${dated(p.synced_at)}">\n${lines.join('\n')}\n</lead_profile>`)
  }
  const c = ctx.company
  if (c?.found) {
    const lines = [
      ['Name', c.company_name], ['Website', c.website], ['Industry', c.industry], ['Employees', c.employees],
      ['Founded', c.founded_year], ['Country', c.country], ['Keywords', clip(c.keywords, 500)],
      ['Description', clip(c.description, DESCRIPTION_CAP)],
    ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)
    if (lines.length) blocks.push(`<company source="Apollo data in our CRM" fetched="${dated(c.fetched_at)}">\n${lines.join('\n')}\n</company>`)
  }
  const s = ctx.site
  if (s && !s.thin && s.body) {
    blocks.push(`<company_website url="${s.url.replace(/"/g, '')}" fetched="${dated(s.fetched_at)}">\n${clip(s.body, SITE_CAP)}\n</company_website>`)
  }
  const o = ctx.ourCompany
  if (o?.our_company.trim()) {
    blocks.push(`<our_company${o.our_website ? ` website="${o.our_website.replace(/"/g, '')}"` : ''}>\n${clip(o.our_company, OUR_COMPANY_CAP)}\n</our_company>`)
  }
  return blocks.join('\n\n')
}

/** Changes whenever the context the coach would read changes, so a cached
 *  take made without a profile or a company is regenerated once they arrive. */
export function contextStamp(ctx: CoachContext): string {
  const blocks = renderContextBlocks(ctx)
  return blocks ? createHash('sha256').update(blocks).digest('hex').slice(0, 12) : '0'
}

/** What the conversation modal shows: the same facts, structured. */
export function contextView(ctx: CoachContext) {
  return {
    profile: ctx.profile,
    company: ctx.company?.found ? ctx.company : null,
    company_checked_at: ctx.company?.fetched_at ?? null,
    website: ctx.site ? {
      url: ctx.site.url,
      title: ctx.site.title,
      usable: !ctx.site.thin && !!ctx.site.body,
      error: ctx.site.error,
      fetched_at: ctx.site.fetched_at,
      excerpt: ctx.site.body ? clip(ctx.site.body, 400) : null,
    } : null,
    our_company_configured: !!ctx.ourCompany?.our_company.trim(),
    as_the_coach_sees_it: renderContextBlocks(ctx),
  }
}
