/**
 * The sourcing library: saved searches, the ICP layer and the hypotheses that
 * connect them to campaigns.
 *
 * These six relations are the *inputs* to outreach rather than its results — the
 * filter recipes a sourcer applies by hand, the structured customer profile
 * behind them, and the go-to-market hypothesis a campaign is testing. Nothing
 * here is synced, nothing here is derived, and no funnel number depends on any of
 * it.
 *
 * ## They are one group because they share one behaviour, not one subject
 *
 * `DataContext` fetches all six inside its `Promise.all` and then **excludes
 * their errors** from the aggregate `error` it reports, taking `data ?? []`
 * instead. A database without `saved_searches` (pre-040) or without the ICP
 * tables (pre-043) therefore renders an empty Search Library rather than a failed
 * dashboard. That is the property this module has to preserve through an API, and
 * it is the reason all six are registered together.
 *
 * **What it is preserved as.** Each is marked tolerant on the dispatching
 * endpoint, which converts a `DataStoreSchemaError` — and only that — into a 200
 * carrying `items: []` and `unavailable: true`. Three things about that choice:
 *
 * - **A 500 would have been a regression against today.** These reads run in the
 *   same load as the topline, and `DataContext` surfaces one error banner for the
 *   whole cycle; a failing library read would empty the dashboard over a page
 *   nobody was looking at.
 * - **The tolerance is about a future schema gap, not a current one.** The Neon
 *   baseline contains all six (`postgres/tenant-baseline/v1/001_portable_business_baseline.sql`).
 *   So on this provider the tolerant branch is unreachable in a correct
 *   deployment — which is exactly why it is asserted directly against the driver's
 *   42P01 translation rather than by dropping a table.
 * - **Only a missing relation is tolerated.** A privilege denial, a timeout or a
 *   connection failure still fails the request. Swallowing those would turn "the
 *   library is empty" into an answer the dashboard cannot distinguish from "the
 *   library is unreachable", which is the mistake the `unavailable` marker exists
 *   to avoid.
 *
 * ## Offset, not keyset — and this is the boundary between the two
 *
 * All six count rather than seek. They are bounded by how much a human types: an
 * ICP library holds tens of rows, and `hypothesis_campaigns` is bounded by the
 * campaign count. `OFFSET n` is only pathological when `n` grows, and here it
 * does not. S12 measured offset's first page at 522 ms against keyset's 525 ms on
 * a small read, so paying for a seek predicate on a relation that fits in one
 * page buys nothing and adds a cursor to reason about.
 *
 * Every order below still ends in a unique column, because the driver applies
 * `LIMIT/OFFSET` to all of them and an order that is not total can repeat or skip
 * a row at a page boundary. The Supabase path orders several of these by
 * non-unique columns alone (`platform, name`; `icp_id, sort`) and gets away with
 * it because PostgREST returns the whole small relation in one response. That is
 * not a property this path may assume.
 *
 * ## Array and JSON columns cross as themselves
 *
 * `text[]` columns arrive from `pg` already parsed into a JS array of strings, and
 * `filters jsonb` arrives as an object — the same shapes PostgREST produced, so
 * `SavedSearch.filters` and every `string[]` in `types.ts` are unchanged. Each is
 * NOT NULL with a `'{}'` default in the baseline, so the null branches in the
 * mappers are defensive only.
 */

import type { NeonQueryOperation, NeonRow } from '../neon.js'

export const LIBRARY_OPERATIONS = {
  /** Named, shareable sourcing search recipes. */
  savedSearches: 'searches.saved',
  /** Ideal Customer Profiles, fully structured. */
  icpProfiles: 'icp.profiles',
  /** Buyer personas, per ICP. */
  icpPersonas: 'icp.personas',
  /** Per-sub-industry include-keyword lists, per ICP. */
  icpIndustries: 'icp.industries',
  /** Testable go-to-market hypotheses. */
  hypotheses: 'hypotheses.list',
  /** Which campaign belongs to which hypothesis. */
  hypothesisCampaigns: 'hypotheses.campaigns',
} as const

// ---------------------------------------------------------------------------
// Row shapes, in the browser's own column names.
// ---------------------------------------------------------------------------

export interface SavedSearchRow {
  readonly id: number
  readonly name: string
  readonly platform: string
  readonly description: string | null
  readonly include_keywords: readonly string[]
  readonly exclude_keywords: readonly string[]
  readonly boolean_query: string | null
  readonly filters: Record<string, unknown>
  readonly notes: string | null
  readonly author: string | null
  readonly archived: boolean
  readonly hypothesis_id: number | null
  readonly created_at: string
  readonly updated_at: string
}

export interface IcpRow {
  readonly id: number
  readonly name: string
  readonly airtable_url: string | null
  readonly main_product: string | null
  readonly core_sphere: string | null
  readonly secondary_sphere: string | null
  readonly product_stage: string | null
  readonly monetization: string | null
  readonly features_note: string | null
  readonly purchase_triggers: readonly string[]
  readonly features: readonly string[]
  readonly company_countries: readonly string[]
  readonly company_headcount: string | null
  readonly company_age: string | null
  readonly apollo_industries: readonly string[]
  readonly funding: string | null
  readonly dev_team_availability: string | null
  readonly dev_team_location: string | null
  readonly exclude_keywords: readonly string[]
  readonly archived: boolean
  readonly created_at: string
  readonly updated_at: string
}

export interface IcpPersonaRow {
  readonly id: number
  readonly icp_id: number
  readonly kind: string
  readonly job_titles: readonly string[]
  readonly age_range: string | null
  readonly location: string | null
  readonly background: string | null
  readonly profile_status: string | null
  readonly connections_note: string | null
  readonly followers_note: string | null
  readonly sort: number
  readonly created_at: string
  readonly updated_at: string
}

export interface IcpIndustryRow {
  readonly id: number
  readonly icp_id: number
  readonly name: string
  readonly include_keywords: readonly string[]
  readonly created_at: string
  readonly updated_at: string
}

export interface HypothesisRow {
  readonly id: number
  readonly name: string
  readonly icp_id: number | null
  readonly description: string | null
  readonly archived: boolean
  readonly created_at: string
  readonly updated_at: string
}

export interface HypothesisCampaignRow {
  readonly hypothesis_id: number
  readonly campaign_id: string
  readonly created_at: string
}

// ---------------------------------------------------------------------------
// Mapping helpers.
// ---------------------------------------------------------------------------

const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

/** `pg` parses `text[]` for us; this only normalizes the NOT NULL default away. */
const textArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry)) : []

const jsonObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

// ---------------------------------------------------------------------------
// searches.saved
// ---------------------------------------------------------------------------

const SAVED_SEARCHES_SQL = `SELECT s.id::text AS id,
          s.name,
          s.platform,
          s.description,
          s.include_keywords,
          s.exclude_keywords,
          s.boolean_query,
          s.filters,
          s.notes,
          s.author,
          s.archived,
          s.hypothesis_id,
          s.created_at,
          s.updated_at
     FROM public.saved_searches s
    ORDER BY s.platform, s.name, s.id`

export const savedSearchesOperation: NeonQueryOperation<SavedSearchRow> = {
  build: () => ({ text: SAVED_SEARCHES_SQL }),
  mapRow: (row: NeonRow): SavedSearchRow => ({
    id: Number(row.id),
    name: String(row.name),
    platform: String(row.platform),
    description: nullableText(row.description),
    include_keywords: textArray(row.include_keywords),
    exclude_keywords: textArray(row.exclude_keywords),
    boolean_query: nullableText(row.boolean_query),
    filters: jsonObject(row.filters),
    notes: nullableText(row.notes),
    author: nullableText(row.author),
    archived: row.archived === true,
    hypothesis_id: nullableNumber(row.hypothesis_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }),
}

// ---------------------------------------------------------------------------
// icp.profiles
// ---------------------------------------------------------------------------

const ICPS_SQL = `SELECT i.id::text AS id,
          i.name,
          i.airtable_url,
          i.main_product,
          i.core_sphere,
          i.secondary_sphere,
          i.product_stage,
          i.monetization,
          i.features_note,
          i.purchase_triggers,
          i.features,
          i.company_countries,
          i.company_headcount,
          i.company_age,
          i.apollo_industries,
          i.funding,
          i.dev_team_availability,
          i.dev_team_location,
          i.exclude_keywords,
          i.archived,
          i.created_at,
          i.updated_at
     FROM public.icps i
    ORDER BY i.name, i.id`

export const icpProfilesOperation: NeonQueryOperation<IcpRow> = {
  build: () => ({ text: ICPS_SQL }),
  mapRow: (row: NeonRow): IcpRow => ({
    id: Number(row.id),
    name: String(row.name),
    airtable_url: nullableText(row.airtable_url),
    main_product: nullableText(row.main_product),
    core_sphere: nullableText(row.core_sphere),
    secondary_sphere: nullableText(row.secondary_sphere),
    product_stage: nullableText(row.product_stage),
    monetization: nullableText(row.monetization),
    features_note: nullableText(row.features_note),
    purchase_triggers: textArray(row.purchase_triggers),
    features: textArray(row.features),
    company_countries: textArray(row.company_countries),
    company_headcount: nullableText(row.company_headcount),
    company_age: nullableText(row.company_age),
    apollo_industries: textArray(row.apollo_industries),
    funding: nullableText(row.funding),
    dev_team_availability: nullableText(row.dev_team_availability),
    dev_team_location: nullableText(row.dev_team_location),
    exclude_keywords: textArray(row.exclude_keywords),
    archived: row.archived === true,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }),
}

// ---------------------------------------------------------------------------
// icp.personas
// ---------------------------------------------------------------------------

const ICP_PERSONAS_SQL = `SELECT p.id::text AS id,
          p.icp_id::text AS icp_id,
          p.kind,
          p.job_titles,
          p.age_range,
          p.location,
          p.background,
          p.profile_status,
          p.connections_note,
          p.followers_note,
          p.sort,
          p.created_at,
          p.updated_at
     FROM public.icp_personas p
    ORDER BY p.icp_id, p.sort, p.id`

export const icpPersonasOperation: NeonQueryOperation<IcpPersonaRow> = {
  build: () => ({ text: ICP_PERSONAS_SQL }),
  mapRow: (row: NeonRow): IcpPersonaRow => ({
    id: Number(row.id),
    icp_id: Number(row.icp_id),
    kind: String(row.kind),
    job_titles: textArray(row.job_titles),
    age_range: nullableText(row.age_range),
    location: nullableText(row.location),
    background: nullableText(row.background),
    profile_status: nullableText(row.profile_status),
    connections_note: nullableText(row.connections_note),
    followers_note: nullableText(row.followers_note),
    // `integer`, which `pg` already returns as a number.
    sort: Number(row.sort),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }),
}

// ---------------------------------------------------------------------------
// icp.industries
// ---------------------------------------------------------------------------

const ICP_INDUSTRIES_SQL = `SELECT n.id::text AS id,
          n.icp_id::text AS icp_id,
          n.name,
          n.include_keywords,
          n.created_at,
          n.updated_at
     FROM public.icp_industries n
    ORDER BY n.icp_id, n.name, n.id`

export const icpIndustriesOperation: NeonQueryOperation<IcpIndustryRow> = {
  build: () => ({ text: ICP_INDUSTRIES_SQL }),
  mapRow: (row: NeonRow): IcpIndustryRow => ({
    id: Number(row.id),
    icp_id: Number(row.icp_id),
    name: String(row.name),
    include_keywords: textArray(row.include_keywords),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }),
}

// ---------------------------------------------------------------------------
// hypotheses.list
// ---------------------------------------------------------------------------

const HYPOTHESES_SQL = `SELECT h.id::text AS id,
          h.name,
          h.icp_id::text AS icp_id,
          h.description,
          h.archived,
          h.created_at,
          h.updated_at
     FROM public.hypotheses h
    ORDER BY h.name, h.id`

export const hypothesesOperation: NeonQueryOperation<HypothesisRow> = {
  build: () => ({ text: HYPOTHESES_SQL }),
  mapRow: (row: NeonRow): HypothesisRow => ({
    id: Number(row.id),
    name: String(row.name),
    icp_id: nullableNumber(row.icp_id),
    description: nullableText(row.description),
    archived: row.archived === true,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }),
}

// ---------------------------------------------------------------------------
// hypotheses.campaigns
// ---------------------------------------------------------------------------

/**
 * `(hypothesis_id, campaign_id)` is the primary key, so this order is total. The
 * Supabase path supplies no order at all here — harmless for one unpaged
 * response, and not something a paging read may inherit.
 */
const HYPOTHESIS_CAMPAIGNS_SQL = `SELECT c.hypothesis_id::text AS hypothesis_id,
          c.campaign_id,
          c.created_at
     FROM public.hypothesis_campaigns c
    ORDER BY c.hypothesis_id, c.campaign_id`

export const hypothesisCampaignsOperation: NeonQueryOperation<HypothesisCampaignRow> =
  {
    build: () => ({ text: HYPOTHESIS_CAMPAIGNS_SQL }),
    mapRow: (row: NeonRow): HypothesisCampaignRow => ({
      hypothesis_id: Number(row.hypothesis_id),
      campaign_id: String(row.campaign_id),
      created_at: String(row.created_at),
    }),
  }
