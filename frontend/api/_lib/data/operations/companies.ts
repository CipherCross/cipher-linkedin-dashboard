/**
 * Companies and countries — the reads behind `#/companies`
 * (spec `specs/2026-11-12-companies-and-countries.md` §4, ledger step 030).
 *
 * The company a lead is written to for is the **Airtable** company, reached
 * through `lead_company_links` (contact slug match or a member's manual link),
 * never LH2's `leads.company`, which is the person's current employer and only a
 * hint. Every funnel figure here is per **person** — `(instance_id, profile_url)`
 * with each milestone's earliest value across that person's campaign rows, as
 * the Overview reads count them — because `leads` holds one row per
 * (campaign, profile) and a person in two campaigns is still one person.
 *
 * P3 is the durable conversation milestone the team labels in reply review: a
 * person counts once they have any inbound message with `intent_level = 'p3'`,
 * the same predicate `overview.summary`'s `intent_milestones` reads.
 *
 * Rates are invite-cohort rates (AGENTS.md "Funnel reasoning"): accepted,
 * replied and P3 are counted among invited people and divided by invited
 * people, and a row whose invites are mostly younger than
 * `MATURING_DAYS` is flagged as still maturing — its reply rate will rise.
 *
 * Each read answers one JSON payload in one row, like `leads.searchPage`: the
 * page, its total and its facets come from one scan of the filtered set.
 */

import type { NeonQueryOperation, NeonRow } from '../neon.js'

export const COMPANIES_OPERATIONS = {
  /** One row per Airtable company (linked ones by default) with its funnel. */
  searchPage: 'companies.searchPage',
  /** One company with every Airtable field and its funnel. */
  detail: 'companies.detail',
  /** People with no company link, for manual linking. */
  unlinked: 'companies.unlinked',
  /** One conversation's location, country and company link. */
  leadLink: 'companies.leadLink',
} as const

export const COUNTRIES_OPERATIONS = {
  /** The funnel per lead country or per company HQ country. */
  funnel: 'countries.funnel',
} as const

/** Invites younger than this are still maturing: replies lag invites. */
export const MATURING_DAYS = 21
/** A row is flagged maturing when at least this share of its invites is young. */
export const MATURING_FLAG_SHARE = 0.3

export const COMPANY_SIZE_BUCKETS = [
  '1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+', 'unknown',
] as const

export const COMPANY_SORT_KEYS = [
  'name', 'country', 'employees', 'leads', 'invited', 'accept_rate', 'replied', 'p3',
  'last_activity',
] as const

const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

// ---------------------------------------------------------------------------
// companies.searchPage
// ---------------------------------------------------------------------------

export interface CompaniesSearchPageParams {
  /** `linked` (≥1 linked person, the default) or `all` (every synced company). */
  readonly scope: string
  readonly instanceId: string | null
  readonly query: string | null
  /** ISO alpha-2, or `unknown` for an unresolved HQ. */
  readonly country: string | null
  readonly industry: string | null
  readonly size: string | null
  readonly approveStatus: string | null
  readonly base: string | null
  /** `yes` — at least one linked person replied; `no` — none did. */
  readonly hasReply: string | null
  readonly sort: string
  readonly direction: string
  readonly pageSize: string
  readonly page: string
  readonly [key: string]: string | null
}

export interface CompaniesSearchPageRow {
  readonly items: readonly unknown[]
  readonly total: number
  readonly allTotal: number
  readonly facets: {
    readonly countries: readonly unknown[]
    readonly industries: readonly unknown[]
    readonly bases: readonly unknown[]
    readonly approveStatuses: readonly unknown[]
  }
}

/**
 * The per-company funnel over linked people. `people` is filtered by account
 * before grouping, so with an account selected a company's numbers (and whether
 * it is "linked" at all) are that account's.
 */
const COMPANY_FUNNEL_CTES = `people AS MATERIALIZED (
  SELECT l.instance_id,
         l.profile_url,
         min(l.invited_at) AS invited_at,
         min(l.connected_at) AS connected_at,
         min(l.first_message_at) AS first_message_at,
         min(l.replied_at) AS replied_at,
         max(l.last_action_at) AS last_action_at
    FROM public.leads l
    JOIN public.lead_company_links lk
      ON lk.instance_id = l.instance_id AND lk.profile_url = l.profile_url
   WHERE ($2::text IS NULL OR l.instance_id = $2::text)
   GROUP BY l.instance_id, l.profile_url
), p3_people AS MATERIALIZED (
  SELECT DISTINCT m.instance_id, m.profile_url
    FROM public.messages m
    JOIN people p ON p.instance_id = m.instance_id AND p.profile_url = m.profile_url
   WHERE m.direction = 'in' AND m.intent_level = 'p3'
), stats AS (
  SELECT k.base_key,
         k.company_record_id,
         count(*)::int AS leads,
         count(*) FILTER (WHERE p.invited_at IS NOT NULL)::int AS invited,
         count(*) FILTER (WHERE p.connected_at IS NOT NULL)::int AS connected,
         count(*) FILTER (WHERE p.invited_at IS NOT NULL AND p.connected_at IS NOT NULL)::int AS accepted_of_invited,
         count(*) FILTER (WHERE p.first_message_at IS NOT NULL)::int AS first_message,
         count(*) FILTER (WHERE p.replied_at IS NOT NULL)::int AS replied,
         count(*) FILTER (WHERE x.instance_id IS NOT NULL)::int AS p3,
         max(p.last_action_at) AS last_activity,
         count(DISTINCT p.instance_id)::int AS accounts
    FROM public.lead_company_links k
    JOIN people p ON p.instance_id = k.instance_id AND p.profile_url = k.profile_url
    LEFT JOIN p3_people x ON x.instance_id = k.instance_id AND x.profile_url = k.profile_url
   GROUP BY k.base_key, k.company_record_id
)`

const COMPANIES_SEARCH_PAGE_SQL = `WITH ${COMPANY_FUNNEL_CTES}, scoped AS (
  SELECT c.base_key,
         c.record_id,
         c.name,
         c.website,
         c.domain,
         c.linkedin_url,
         c.hq_country,
         c.country_code::text AS country_code,
         co.name AS country_name,
         c.industry,
         c.employees,
         c.ai_niche,
         c.approve_status,
         coalesce(s.leads, 0) AS leads,
         coalesce(s.invited, 0) AS invited,
         coalesce(s.connected, 0) AS connected,
         coalesce(s.accepted_of_invited, 0) AS accepted_of_invited,
         coalesce(s.first_message, 0) AS first_message,
         coalesce(s.replied, 0) AS replied,
         coalesce(s.p3, 0) AS p3,
         s.last_activity,
         coalesce(s.accounts, 0) AS accounts,
         CASE WHEN coalesce(s.invited, 0) > 0
              THEN round(s.accepted_of_invited::numeric / s.invited, 4) END AS accept_rate
    FROM public.airtable_companies c
    LEFT JOIN stats s ON s.base_key = c.base_key AND s.company_record_id = c.record_id
    LEFT JOIN public.countries co ON co.iso2 = c.country_code
   WHERE $1::text = 'all' OR coalesce(s.leads, 0) > 0
), filtered AS (
  SELECT s.*
    FROM scoped s
   WHERE ($3::text IS NULL
          OR lower(concat_ws(' ', s.name, s.domain, s.website)) LIKE '%' || lower($3::text) || '%')
     AND (
       $4::text IS NULL
       OR ($4::text = 'unknown' AND s.country_code IS NULL)
       OR s.country_code = $4::text
     )
     AND ($5::text IS NULL OR s.industry = $5::text)
     AND (
       $6::text IS NULL
       OR ($6::text = 'unknown' AND s.employees IS NULL)
       OR ($6::text = '1-10' AND s.employees BETWEEN 1 AND 10)
       OR ($6::text = '11-50' AND s.employees BETWEEN 11 AND 50)
       OR ($6::text = '51-200' AND s.employees BETWEEN 51 AND 200)
       OR ($6::text = '201-500' AND s.employees BETWEEN 201 AND 500)
       OR ($6::text = '501-1000' AND s.employees BETWEEN 501 AND 1000)
       OR ($6::text = '1001-5000' AND s.employees BETWEEN 1001 AND 5000)
       OR ($6::text = '5000+' AND s.employees > 5000)
     )
     AND ($7::text IS NULL OR s.approve_status = $7::text)
     AND ($8::text IS NULL OR s.base_key = $8::text)
     AND (
       $9::text IS NULL
       OR ($9::text = 'yes' AND s.replied > 0)
       OR ($9::text = 'no' AND s.replied = 0)
     )
), ordered AS (
  SELECT f.*,
         row_number() OVER (ORDER BY
           CASE WHEN $10::text = 'name' AND $11::text = 'asc' THEN lower(f.name) END ASC NULLS LAST,
           CASE WHEN $10::text = 'name' AND $11::text = 'desc' THEN lower(f.name) END DESC NULLS LAST,
           CASE WHEN $10::text = 'country' AND $11::text = 'asc' THEN f.country_name END ASC NULLS LAST,
           CASE WHEN $10::text = 'country' AND $11::text = 'desc' THEN f.country_name END DESC NULLS LAST,
           CASE WHEN $10::text = 'employees' AND $11::text = 'asc' THEN f.employees END ASC NULLS LAST,
           CASE WHEN $10::text = 'employees' AND $11::text = 'desc' THEN f.employees END DESC NULLS LAST,
           CASE WHEN $10::text = 'leads' AND $11::text = 'asc' THEN f.leads END ASC NULLS LAST,
           CASE WHEN $10::text = 'leads' AND $11::text = 'desc' THEN f.leads END DESC NULLS LAST,
           CASE WHEN $10::text = 'invited' AND $11::text = 'asc' THEN f.invited END ASC NULLS LAST,
           CASE WHEN $10::text = 'invited' AND $11::text = 'desc' THEN f.invited END DESC NULLS LAST,
           CASE WHEN $10::text = 'accept_rate' AND $11::text = 'asc' THEN f.accept_rate END ASC NULLS LAST,
           CASE WHEN $10::text = 'accept_rate' AND $11::text = 'desc' THEN f.accept_rate END DESC NULLS LAST,
           CASE WHEN $10::text = 'replied' AND $11::text = 'asc' THEN f.replied END ASC NULLS LAST,
           CASE WHEN $10::text = 'replied' AND $11::text = 'desc' THEN f.replied END DESC NULLS LAST,
           CASE WHEN $10::text = 'p3' AND $11::text = 'asc' THEN f.p3 END ASC NULLS LAST,
           CASE WHEN $10::text = 'p3' AND $11::text = 'desc' THEN f.p3 END DESC NULLS LAST,
           CASE WHEN $10::text = 'last_activity' AND $11::text = 'asc' THEN f.last_activity END ASC NULLS LAST,
           CASE WHEN $10::text = 'last_activity' AND $11::text = 'desc' THEN f.last_activity END DESC NULLS LAST,
           lower(f.name) ASC NULLS LAST,
           f.base_key ASC,
           f.record_id ASC
         ) AS page_order
    FROM filtered f
), paged AS (
  SELECT *
    FROM ordered
   WHERE page_order > ($13::int * $12::int)
     AND page_order <= (($13::int + 1) * $12::int)
   ORDER BY page_order
)
SELECT jsonb_build_object(
  'items', coalesce((
    SELECT jsonb_agg(to_jsonb(p) - 'page_order' ORDER BY p.page_order) FROM paged p
  ), '[]'::jsonb),
  'total', (SELECT count(*)::int FROM filtered),
  'allTotal', (SELECT count(*)::int FROM scoped),
  'facets', jsonb_build_object(
    'countries', coalesce((
      SELECT jsonb_agg(jsonb_build_object('value', g.value, 'label', g.label, 'count', g.cnt)
                       ORDER BY g.cnt DESC, g.label)
        FROM (SELECT coalesce(s.country_code, 'unknown') AS value,
                     coalesce(max(s.country_name), 'Unknown') AS label,
                     count(*)::int AS cnt
                FROM scoped s
               GROUP BY coalesce(s.country_code, 'unknown')) g
    ), '[]'::jsonb),
    'industries', coalesce((
      SELECT jsonb_agg(jsonb_build_object('value', g.value, 'label', g.value, 'count', g.cnt)
                       ORDER BY g.cnt DESC, g.value)
        FROM (SELECT s.industry AS value, count(*)::int AS cnt
                FROM scoped s
               WHERE s.industry IS NOT NULL AND btrim(s.industry) <> ''
               GROUP BY s.industry
               ORDER BY count(*) DESC, s.industry
               LIMIT 200) g
    ), '[]'::jsonb),
    'bases', coalesce((
      SELECT jsonb_agg(jsonb_build_object('value', g.value, 'label', g.value, 'count', g.cnt)
                       ORDER BY g.value)
        FROM (SELECT s.base_key AS value, count(*)::int AS cnt
                FROM scoped s GROUP BY s.base_key) g
    ), '[]'::jsonb),
    'approveStatuses', coalesce((
      SELECT jsonb_agg(jsonb_build_object('value', g.value, 'label', g.value, 'count', g.cnt)
                       ORDER BY g.cnt DESC, g.value)
        FROM (SELECT s.approve_status AS value, count(*)::int AS cnt
                FROM scoped s
               WHERE s.approve_status IS NOT NULL AND btrim(s.approve_status) <> ''
               GROUP BY s.approve_status) g
    ), '[]'::jsonb)
  )
) AS payload`

const EMPTY_FACETS = { countries: [], industries: [], bases: [], approveStatuses: [] }

export const companiesSearchPageOperation: NeonQueryOperation<
  CompaniesSearchPageRow,
  CompaniesSearchPageParams
> = {
  build: ({ params }) => ({
    text: COMPANIES_SEARCH_PAGE_SQL,
    values: [
      params?.scope ?? 'linked',
      params?.instanceId ?? null,
      params?.query ?? null,
      params?.country ?? null,
      params?.industry ?? null,
      params?.size ?? null,
      params?.approveStatus ?? null,
      params?.base ?? null,
      params?.hasReply ?? null,
      params?.sort ?? 'leads',
      params?.direction ?? 'desc',
      params?.pageSize ?? '50',
      params?.page ?? '0',
    ],
  }),
  mapRow: (row: NeonRow): CompaniesSearchPageRow => {
    const payload = row.payload as CompaniesSearchPageRow | undefined
    return payload ?? { items: [], total: 0, allTotal: 0, facets: EMPTY_FACETS }
  },
}

// ---------------------------------------------------------------------------
// companies.detail
// ---------------------------------------------------------------------------

export interface CompanyDetailParams {
  readonly base: string
  readonly recordId: string
  readonly [key: string]: string | null
}

/**
 * The company row with `fields` (every Airtable field by name) and its funnel
 * over every linked person, all accounts. No row when the company is not synced.
 */
const COMPANY_DETAIL_SQL = `WITH people AS MATERIALIZED (
  SELECT l.instance_id,
         l.profile_url,
         min(l.invited_at) AS invited_at,
         min(l.connected_at) AS connected_at,
         min(l.first_message_at) AS first_message_at,
         min(l.replied_at) AS replied_at,
         max(l.last_action_at) AS last_action_at
    FROM public.lead_company_links k
    JOIN public.leads l
      ON l.instance_id = k.instance_id AND l.profile_url = k.profile_url
   WHERE k.base_key = $1::text AND k.company_record_id = $2::text
   GROUP BY l.instance_id, l.profile_url
), p3_people AS (
  SELECT DISTINCT m.instance_id, m.profile_url
    FROM public.messages m
    JOIN people p ON p.instance_id = m.instance_id AND p.profile_url = m.profile_url
   WHERE m.direction = 'in' AND m.intent_level = 'p3'
), kpis AS (
  SELECT count(*)::int AS leads,
         count(*) FILTER (WHERE p.invited_at IS NOT NULL)::int AS invited,
         count(*) FILTER (WHERE p.connected_at IS NOT NULL)::int AS connected,
         count(*) FILTER (WHERE p.invited_at IS NOT NULL AND p.connected_at IS NOT NULL)::int AS accepted_of_invited,
         count(*) FILTER (WHERE p.first_message_at IS NOT NULL)::int AS first_message,
         count(*) FILTER (WHERE p.replied_at IS NOT NULL)::int AS replied,
         count(*) FILTER (WHERE x.instance_id IS NOT NULL)::int AS p3,
         count(*) FILTER (WHERE p.invited_at > now() - interval '${MATURING_DAYS} days')::int AS maturing,
         max(p.last_action_at) AS last_activity,
         count(DISTINCT p.instance_id)::int AS accounts
    FROM people p
    LEFT JOIN p3_people x ON x.instance_id = p.instance_id AND x.profile_url = p.profile_url
)
SELECT (to_jsonb(c) - 'country_code')
         || jsonb_build_object(
              'country_code', c.country_code::text,
              'country_name', co.name,
              'accept_rate', CASE WHEN k.invited > 0 THEN round(k.accepted_of_invited::numeric / k.invited, 4) END
            )
         || to_jsonb(k) AS payload
  FROM public.airtable_companies c
  CROSS JOIN kpis k
  LEFT JOIN public.countries co ON co.iso2 = c.country_code
 WHERE c.base_key = $1::text AND c.record_id = $2::text
 ORDER BY c.base_key, c.record_id`

export const companyDetailOperation: NeonQueryOperation<unknown, CompanyDetailParams> = {
  build: ({ params }) => ({
    text: COMPANY_DETAIL_SQL,
    values: [params?.base ?? null, params?.recordId ?? null],
  }),
  mapRow: (row: NeonRow): unknown => row.payload ?? null,
}

// ---------------------------------------------------------------------------
// companies.unlinked
// ---------------------------------------------------------------------------

export interface CompaniesUnlinkedParams {
  readonly instanceId: string | null
  readonly query: string | null
  /** `invited` — has an invite; `replied` — has a reply. */
  readonly reach: string | null
  readonly pageSize: string
  readonly page: string
  readonly [key: string]: string | null
}

export interface CompaniesUnlinkedRow {
  readonly items: readonly unknown[]
  readonly total: number
  readonly allTotal: number
}

/**
 * People with no `lead_company_links` row. `company` is LH2's current company —
 * shown as a hint for the person linking, never as the company itself. Replied
 * people first, then invited ones, then by latest activity.
 */
const COMPANIES_UNLINKED_SQL = `WITH unlinked AS MATERIALIZED (
  SELECT l.instance_id,
         l.profile_url,
         max(l.full_name) AS full_name,
         max(l.headline) AS headline,
         max(l.company) AS company,
         max(l.country_code)::text AS country_code,
         max(l.location) AS location,
         min(l.invited_at) AS invited_at,
         min(l.replied_at) AS replied_at,
         max(l.last_action_at) AS last_action_at,
         array_agg(DISTINCT coalesce(cp.name, l.campaign_id)) AS campaigns
    FROM public.leads l
    LEFT JOIN public.campaigns cp ON cp.id = l.campaign_id
   WHERE ($1::text IS NULL OR l.instance_id = $1::text)
     AND NOT EXISTS (
       SELECT 1
         FROM public.lead_company_links k
        WHERE k.instance_id = l.instance_id AND k.profile_url = l.profile_url
     )
   GROUP BY l.instance_id, l.profile_url
), filtered AS (
  SELECT u.*
    FROM unlinked u
   WHERE ($2::text IS NULL
          OR lower(concat_ws(' ', u.full_name, u.headline, u.company, u.location)) LIKE '%' || lower($2::text) || '%')
     AND (
       $3::text IS NULL
       OR ($3::text = 'invited' AND u.invited_at IS NOT NULL)
       OR ($3::text = 'replied' AND u.replied_at IS NOT NULL)
     )
), ordered AS (
  SELECT f.*,
         row_number() OVER (ORDER BY
           (f.replied_at IS NOT NULL) DESC,
           (f.invited_at IS NOT NULL) DESC,
           f.last_action_at DESC NULLS LAST,
           f.instance_id ASC,
           f.profile_url ASC
         ) AS page_order
    FROM filtered f
), paged AS (
  SELECT *
    FROM ordered
   WHERE page_order > ($5::int * $4::int)
     AND page_order <= (($5::int + 1) * $4::int)
   ORDER BY page_order
)
SELECT jsonb_build_object(
  'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'instance_id', p.instance_id,
      'profile_url', p.profile_url,
      'full_name', p.full_name,
      'headline', p.headline,
      'company', p.company,
      'country_code', p.country_code,
      'location', p.location,
      'invited', p.invited_at IS NOT NULL,
      'replied', p.replied_at IS NOT NULL,
      'last_action_at', p.last_action_at,
      'campaigns', to_jsonb(p.campaigns)
    ) ORDER BY p.page_order)
      FROM paged p
  ), '[]'::jsonb),
  'total', (SELECT count(*)::int FROM filtered),
  'allTotal', (SELECT count(*)::int FROM unlinked)
) AS payload`

export const companiesUnlinkedOperation: NeonQueryOperation<
  CompaniesUnlinkedRow,
  CompaniesUnlinkedParams
> = {
  build: ({ params }) => ({
    text: COMPANIES_UNLINKED_SQL,
    values: [
      params?.instanceId ?? null,
      params?.query ?? null,
      params?.reach ?? null,
      params?.pageSize ?? '50',
      params?.page ?? '0',
    ],
  }),
  mapRow: (row: NeonRow): CompaniesUnlinkedRow => {
    const payload = row.payload as CompaniesUnlinkedRow | undefined
    return payload ?? { items: [], total: 0, allTotal: 0 }
  },
}

// ---------------------------------------------------------------------------
// companies.leadLink
// ---------------------------------------------------------------------------

export interface LeadCompanyLinkParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly [key: string]: string | null
}

export interface LeadCompanyLinkRow {
  readonly location: string | null
  readonly country_code: string | null
  readonly country_name: string | null
  readonly company_link: {
    readonly base_key: string
    readonly record_id: string
    readonly name: string | null
    readonly method: string
  } | null
}

/**
 * What the conversation workspace shows about where a lead is and which company
 * they are written to for. Scoped by instance as well as profile: the same person
 * reached from two accounts is two conversations (AGENTS.md).
 */
const LEAD_COMPANY_LINK_SQL = `WITH person AS (
  SELECT max(l.location) AS location,
         max(l.country_code)::text AS country_code
    FROM public.leads l
   WHERE l.instance_id = $1::text AND l.profile_url = $2::text
), link AS (
  SELECT k.base_key, k.company_record_id, k.method, c.name
    FROM public.lead_company_links k
    JOIN public.airtable_companies c
      ON c.base_key = k.base_key AND c.record_id = k.company_record_id
   WHERE k.instance_id = $1::text AND k.profile_url = $2::text
)
SELECT pe.location,
       pe.country_code,
       co.name AS country_name,
       lk.base_key,
       lk.company_record_id,
       lk.name AS company_name,
       lk.method
  FROM person pe
  LEFT JOIN link lk ON true
  LEFT JOIN public.countries co ON co.iso2 = pe.country_code
 ORDER BY lk.base_key NULLS LAST`

export const leadCompanyLinkOperation: NeonQueryOperation<
  LeadCompanyLinkRow,
  LeadCompanyLinkParams
> = {
  build: ({ params }) => ({
    text: LEAD_COMPANY_LINK_SQL,
    values: [params?.instanceId ?? null, params?.profileUrl ?? null],
  }),
  mapRow: (row: NeonRow): LeadCompanyLinkRow => ({
    location: nullableText(row.location),
    country_code: nullableText(row.country_code),
    country_name: nullableText(row.country_name),
    company_link: row.base_key == null || row.company_record_id == null
      ? null
      : {
          base_key: String(row.base_key),
          record_id: String(row.company_record_id),
          name: nullableText(row.company_name),
          method: String(row.method),
        },
  }),
}

// ---------------------------------------------------------------------------
// countries.funnel
// ---------------------------------------------------------------------------

export interface CountriesFunnelParams {
  /** `lead` — the person's own location; `company` — the linked company's HQ. */
  readonly axis: string
  readonly instanceId: string | null
  readonly campaignId: string | null
  /** Invite cohort bounds: half-open UTC instants. */
  readonly invitedFrom: string | null
  readonly invitedTo: string | null
  readonly [key: string]: string | null
}

export interface CountriesFunnelRow {
  readonly axis: string
  readonly rows: readonly unknown[]
  readonly unresolved: readonly unknown[]
  readonly totals: Readonly<Record<string, number>>
  readonly unlinked_people: number
}

/**
 * One row per country plus an `Unknown` row (`iso2` null). On the company axis
 * only people linked to a company are placed — `Unknown` there means a linked
 * company whose HQ did not resolve — and `unlinked_people` says how many people
 * of the cohort the axis cannot place at all.
 *
 * With an invite period, the cohort is the people invited in it; without one it
 * is every person, and `people` also counts those never invited. Accepted,
 * replied and P3 are always counted among invited people, so each rate is the
 * share of an invite cohort.
 */
const COUNTRIES_FUNNEL_SQL = `WITH people AS MATERIALIZED (
  SELECT l.instance_id,
         l.profile_url,
         min(l.invited_at) AS invited_at,
         min(l.connected_at) AS connected_at,
         min(l.replied_at) AS replied_at,
         max(l.country_code)::text AS country_code,
         max(l.location) AS location
    FROM public.leads l
   WHERE ($2::text IS NULL OR l.instance_id = $2::text)
     AND ($3::text IS NULL OR l.campaign_id = $3::text)
   GROUP BY l.instance_id, l.profile_url
), cohort AS MATERIALIZED (
  SELECT p.*
    FROM people p
   WHERE ($4::timestamptz IS NULL OR p.invited_at >= $4::timestamptz)
     AND ($5::timestamptz IS NULL OR p.invited_at < $5::timestamptz)
), p3_people AS MATERIALIZED (
  SELECT DISTINCT m.instance_id, m.profile_url
    FROM public.messages m
    JOIN cohort c ON c.instance_id = m.instance_id AND c.profile_url = m.profile_url
   WHERE m.direction = 'in' AND m.intent_level = 'p3'
), placed AS MATERIALIZED (
  SELECT c.instance_id,
         c.profile_url,
         c.invited_at,
         c.connected_at,
         c.replied_at,
         (x.instance_id IS NOT NULL) AS is_p3,
         k.base_key,
         k.company_record_id,
         CASE WHEN $1::text = 'company' THEN ac.country_code::text ELSE c.country_code END AS country_code,
         CASE WHEN $1::text = 'company' THEN ac.hq_country ELSE c.location END AS raw_place
    FROM cohort c
    LEFT JOIN public.lead_company_links k
      ON k.instance_id = c.instance_id AND k.profile_url = c.profile_url
    LEFT JOIN public.airtable_companies ac
      ON ac.base_key = k.base_key AND ac.record_id = k.company_record_id
    LEFT JOIN p3_people x
      ON x.instance_id = c.instance_id AND x.profile_url = c.profile_url
   WHERE $1::text = 'lead' OR k.instance_id IS NOT NULL
), grouped AS (
  SELECT g.country_code,
         count(*)::int AS people,
         count(*) FILTER (WHERE g.invited_at IS NOT NULL)::int AS invited,
         count(*) FILTER (WHERE g.invited_at IS NOT NULL AND g.connected_at IS NOT NULL)::int AS accepted,
         count(*) FILTER (WHERE g.invited_at IS NOT NULL AND g.replied_at IS NOT NULL)::int AS replied,
         count(*) FILTER (WHERE g.invited_at IS NOT NULL AND g.is_p3)::int AS p3,
         count(DISTINCT g.base_key || ':' || g.company_record_id)::int AS companies,
         count(*) FILTER (WHERE g.invited_at > now() - interval '${MATURING_DAYS} days')::int AS maturing
    FROM placed g
   GROUP BY g.country_code
), shaped AS (
  SELECT g.country_code AS iso2,
         coalesce(co.name, CASE WHEN g.country_code IS NULL THEN 'Unknown' ELSE g.country_code END) AS name,
         co.region,
         g.people,
         g.invited,
         g.accepted,
         g.replied,
         g.p3,
         g.companies,
         g.maturing,
         CASE WHEN g.invited > 0 THEN round(g.accepted::numeric / g.invited, 4) END AS accept_rate,
         CASE WHEN g.invited > 0 THEN round(g.replied::numeric / g.invited, 4) END AS reply_rate,
         CASE WHEN g.invited > 0 THEN round(g.p3::numeric / g.invited, 4) END AS p3_rate,
         CASE WHEN g.invited > 0 THEN round(g.maturing::numeric / g.invited, 4) END AS maturing_share,
         -- CASE, not AND: PostgreSQL does not promise to short-circuit a division.
         CASE WHEN g.invited > 0 THEN g.maturing::numeric / g.invited >= ${MATURING_FLAG_SHARE} ELSE false END AS maturing_flag
    FROM grouped g
    LEFT JOIN public.countries co ON co.iso2 = g.country_code
), unresolved AS (
  SELECT u.raw_place AS value,
         count(*)::int AS people,
         count(DISTINCT u.base_key || ':' || u.company_record_id)::int AS companies
    FROM placed u
   WHERE u.country_code IS NULL AND u.raw_place IS NOT NULL AND btrim(u.raw_place) <> ''
   GROUP BY u.raw_place
   ORDER BY count(*) DESC, u.raw_place
   LIMIT 20
)
SELECT jsonb_build_object(
  'axis', $1::text,
  'rows', coalesce((
    SELECT jsonb_agg(to_jsonb(s) ORDER BY (s.iso2 IS NULL), s.invited DESC, s.people DESC, s.name)
      FROM shaped s
  ), '[]'::jsonb),
  'unresolved', coalesce((
    SELECT jsonb_agg(to_jsonb(u) ORDER BY u.people DESC, u.value) FROM unresolved u
  ), '[]'::jsonb),
  'totals', (
    SELECT jsonb_build_object(
      'people', count(*)::int,
      'invited', count(*) FILTER (WHERE t.invited_at IS NOT NULL)::int,
      'accepted', count(*) FILTER (WHERE t.invited_at IS NOT NULL AND t.connected_at IS NOT NULL)::int,
      'replied', count(*) FILTER (WHERE t.invited_at IS NOT NULL AND t.replied_at IS NOT NULL)::int,
      'p3', count(*) FILTER (WHERE t.invited_at IS NOT NULL AND t.is_p3)::int,
      'maturing', count(*) FILTER (WHERE t.invited_at > now() - interval '${MATURING_DAYS} days')::int
    ) FROM placed t
  ),
  'unlinked_people', (
    SELECT count(*)::int
      FROM cohort c
     WHERE NOT EXISTS (
       SELECT 1 FROM public.lead_company_links k
        WHERE k.instance_id = c.instance_id AND k.profile_url = c.profile_url
     )
  )
) AS payload`

export const countriesFunnelOperation: NeonQueryOperation<
  CountriesFunnelRow,
  CountriesFunnelParams
> = {
  build: ({ params }) => ({
    text: COUNTRIES_FUNNEL_SQL,
    values: [
      params?.axis ?? 'lead',
      params?.instanceId ?? null,
      params?.campaignId ?? null,
      params?.invitedFrom ?? null,
      params?.invitedTo ?? null,
    ],
  }),
  mapRow: (row: NeonRow): CountriesFunnelRow => {
    const payload = row.payload as CountriesFunnelRow | undefined
    return payload ?? { axis: 'lead', rows: [], unresolved: [], totals: {}, unlinked_people: 0 }
  },
}
