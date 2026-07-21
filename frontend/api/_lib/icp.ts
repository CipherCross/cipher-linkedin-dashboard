// Shared validation/normalization for the ICP + Hypothesis layer (migration
// 043), used by /api/playbook's icp/hypothesis actions. Mirrors _lib/savedSearch.ts:
// dependency-light pure input validation; the DB write itself lives in playbook.ts
// (service-role db()). Every array/string cap here matches a check() constraint in
// the migration so a payload that would violate the DB constraint fails with a
// readable message instead of a raw Postgres error.

export const ICP_CAPS = {
  NAME: 120,
  URL: 500,
  PROSE: 500,
  FEATURES_NOTE: 2000,
  ARRAY_ITEM: 200,
  PURCHASE_TRIGGERS: 50,
  FEATURES: 50,
  COUNTRIES: 200,
  INDUSTRIES: 100,
  KEYWORDS: 500,
} as const

export const PERSONA_CAPS = {
  KIND: 120,
  AGE_RANGE: 60,
  LOCATION: 300,
  BACKGROUND: 2000,
  PROFILE_STATUS: 500,
  NOTE: 200,
  JOB_TITLES: 100,
  JOB_TITLE_LEN: 200,
} as const

export const INDUSTRY_CAPS = {
  NAME: 200,
  KEYWORDS: 100,
  KEYWORD_LEN: 200,
} as const

export const HYPOTHESIS_CAPS = {
  NAME: 160,
  DESCRIPTION: 2000,
} as const

function normalizeStringArray(
  raw: unknown,
  field: string,
  maxItemLen: number,
  maxItems: number,
): string[] | string {
  if (!Array.isArray(raw)) return `${field} must be an array of strings`
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return `${field} must contain only strings`
    if (item.length > maxItemLen) return `each ${field} entry must be at most ${maxItemLen} characters`
    const trimmed = item.trim()
    if (trimmed) out.push(trimmed)
  }
  if (out.length > maxItems) return `${field} may have at most ${maxItems} entries`
  return out
}

/** Validate one optional string|null field, writing into `out` on success.
 *  Returns an error string on failure, or null on success (including "field
 *  absent, nothing to do"). Unlike a return-the-value helper, this can never
 *  confuse an error message with legitimate field content. */
function applyOptionalText(
  out: Record<string, unknown>,
  src: Record<string, unknown>,
  field: string,
  cap: number,
): string | null {
  const v = src[field]
  if (v === undefined) return null
  if (v === null) {
    out[field] = null
    return null
  }
  if (typeof v !== 'string') return `${field} must be a string or null`
  if (v.length > cap) return `${field} must be at most ${cap} characters`
  out[field] = v
  return null
}

// A plain `interface` has no index signature, so TS won't structurally assign it to
// the `Record<string, unknown>` that playbook.ts's generic saveEntity() dispatches
// on — `& Record<string, unknown>` gives it one without loosening the named fields.
export type NormalizedIcp = Record<string, unknown> & {
  name?: string
  airtable_url?: string | null
  main_product?: string | null
  core_sphere?: string | null
  secondary_sphere?: string | null
  product_stage?: string | null
  monetization?: string | null
  features_note?: string | null
  purchase_triggers?: string[]
  features?: string[]
  company_countries?: string[]
  company_headcount?: string | null
  company_age?: string | null
  apollo_industries?: string[]
  funding?: string | null
  dev_team_availability?: string | null
  dev_team_location?: string | null
  exclude_keywords?: string[]
  archived?: boolean
}

const ICP_TEXT_FIELDS: Array<{ key: keyof NormalizedIcp; cap: number }> = [
  { key: 'airtable_url', cap: ICP_CAPS.URL },
  { key: 'main_product', cap: ICP_CAPS.PROSE },
  { key: 'core_sphere', cap: ICP_CAPS.PROSE },
  { key: 'secondary_sphere', cap: ICP_CAPS.PROSE },
  { key: 'product_stage', cap: ICP_CAPS.PROSE },
  { key: 'monetization', cap: ICP_CAPS.PROSE },
  { key: 'features_note', cap: ICP_CAPS.FEATURES_NOTE },
  { key: 'company_headcount', cap: ICP_CAPS.PROSE },
  { key: 'company_age', cap: ICP_CAPS.PROSE },
  { key: 'funding', cap: ICP_CAPS.PROSE },
  { key: 'dev_team_availability', cap: ICP_CAPS.PROSE },
  { key: 'dev_team_location', cap: ICP_CAPS.PROSE },
]

const ICP_ARRAY_FIELDS: Array<{ key: keyof NormalizedIcp; maxItems: number }> = [
  { key: 'purchase_triggers', maxItems: ICP_CAPS.PURCHASE_TRIGGERS },
  { key: 'features', maxItems: ICP_CAPS.FEATURES },
  { key: 'company_countries', maxItems: ICP_CAPS.COUNTRIES },
  { key: 'apollo_industries', maxItems: ICP_CAPS.INDUSTRIES },
  { key: 'exclude_keywords', maxItems: ICP_CAPS.KEYWORDS },
]

/** Validate + normalize an ICP payload. `requireCore` = true on create (name
 *  required), false on a partial-patch update. */
export function validateIcp(input: unknown, requireCore: boolean): NormalizedIcp | string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return 'icp must be an object'
  }
  const src = input as Record<string, unknown>
  const out: Record<string, unknown> = {}

  const name = src.name
  if (name === undefined) {
    if (requireCore) return 'name is required'
  } else {
    if (typeof name !== 'string') return 'name must be a string'
    const trimmed = name.trim()
    if (!trimmed) return 'name must not be empty'
    if (trimmed.length > ICP_CAPS.NAME) return `name must be at most ${ICP_CAPS.NAME} characters`
    out.name = trimmed
  }

  for (const { key, cap } of ICP_TEXT_FIELDS) {
    const err = applyOptionalText(out, src, key, cap)
    if (err) return err
  }

  for (const { key, maxItems } of ICP_ARRAY_FIELDS) {
    const v = src[key]
    if (v === undefined) continue
    const arr = normalizeStringArray(v, key, ICP_CAPS.ARRAY_ITEM, maxItems)
    if (typeof arr === 'string') return arr
    out[key] = arr
  }

  if (src.archived !== undefined) {
    if (typeof src.archived !== 'boolean') return 'archived must be a boolean'
    out.archived = src.archived
  }

  return out as NormalizedIcp
}

export type NormalizedPersona = Record<string, unknown> & {
  icp_id?: number
  kind?: string
  job_titles?: string[]
  age_range?: string | null
  location?: string | null
  background?: string | null
  profile_status?: string | null
  connections_note?: string | null
  followers_note?: string | null
  sort?: number
}

/** Validate + normalize a buyer-persona payload. `requireCore` = true on
 *  create (icp_id + kind required). */
export function validatePersona(input: unknown, requireCore: boolean): NormalizedPersona | string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return 'persona must be an object'
  }
  const src = input as Record<string, unknown>
  const out: Record<string, unknown> = {}

  if (src.icp_id === undefined) {
    if (requireCore) return 'icp_id is required'
  } else {
    if (typeof src.icp_id !== 'number' || !Number.isInteger(src.icp_id) || src.icp_id <= 0) {
      return 'icp_id must be a positive integer'
    }
    out.icp_id = src.icp_id
  }

  if (src.kind === undefined) {
    if (requireCore) return 'kind is required'
  } else {
    if (typeof src.kind !== 'string') return 'kind must be a string'
    const trimmed = src.kind.trim()
    if (!trimmed) return 'kind must not be empty'
    if (trimmed.length > PERSONA_CAPS.KIND) return `kind must be at most ${PERSONA_CAPS.KIND} characters`
    out.kind = trimmed
  }

  if (src.job_titles !== undefined) {
    const arr = normalizeStringArray(
      src.job_titles, 'job_titles', PERSONA_CAPS.JOB_TITLE_LEN, PERSONA_CAPS.JOB_TITLES,
    )
    if (typeof arr === 'string') return arr
    out.job_titles = arr
  }

  for (const { key, cap } of [
    { key: 'age_range', cap: PERSONA_CAPS.AGE_RANGE },
    { key: 'location', cap: PERSONA_CAPS.LOCATION },
    { key: 'background', cap: PERSONA_CAPS.BACKGROUND },
    { key: 'profile_status', cap: PERSONA_CAPS.PROFILE_STATUS },
    { key: 'connections_note', cap: PERSONA_CAPS.NOTE },
    { key: 'followers_note', cap: PERSONA_CAPS.NOTE },
  ]) {
    const err = applyOptionalText(out, src, key, cap)
    if (err) return err
  }

  if (src.sort !== undefined) {
    if (typeof src.sort !== 'number' || !Number.isInteger(src.sort)) return 'sort must be an integer'
    out.sort = src.sort
  }

  return out as NormalizedPersona
}

export type NormalizedIndustry = Record<string, unknown> & {
  icp_id?: number
  name?: string
  include_keywords?: string[]
}

/** Validate + normalize a per-industry keyword-refinement payload. `requireCore`
 *  = true on create (icp_id + name required). */
export function validateIndustry(input: unknown, requireCore: boolean): NormalizedIndustry | string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return 'industry must be an object'
  }
  const src = input as Record<string, unknown>
  const out: Record<string, unknown> = {}

  if (src.icp_id === undefined) {
    if (requireCore) return 'icp_id is required'
  } else {
    if (typeof src.icp_id !== 'number' || !Number.isInteger(src.icp_id) || src.icp_id <= 0) {
      return 'icp_id must be a positive integer'
    }
    out.icp_id = src.icp_id
  }

  if (src.name === undefined) {
    if (requireCore) return 'name is required'
  } else {
    if (typeof src.name !== 'string') return 'name must be a string'
    const trimmed = src.name.trim()
    if (!trimmed) return 'name must not be empty'
    if (trimmed.length > INDUSTRY_CAPS.NAME) return `name must be at most ${INDUSTRY_CAPS.NAME} characters`
    out.name = trimmed
  }

  if (src.include_keywords !== undefined) {
    const arr = normalizeStringArray(
      src.include_keywords, 'include_keywords', INDUSTRY_CAPS.KEYWORD_LEN, INDUSTRY_CAPS.KEYWORDS,
    )
    if (typeof arr === 'string') return arr
    out.include_keywords = arr
  }

  return out as NormalizedIndustry
}

export type NormalizedHypothesis = Record<string, unknown> & {
  name?: string
  icp_id?: number | null
  description?: string | null
  archived?: boolean
}

/** Validate + normalize a hypothesis payload. `requireCore` = true on create
 *  (name required); icp_id may be null (unassigned) on either path. */
export function validateHypothesis(input: unknown, requireCore: boolean): NormalizedHypothesis | string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return 'hypothesis must be an object'
  }
  const src = input as Record<string, unknown>
  const out: Record<string, unknown> = {}

  if (src.name === undefined) {
    if (requireCore) return 'name is required'
  } else {
    if (typeof src.name !== 'string') return 'name must be a string'
    const trimmed = src.name.trim()
    if (!trimmed) return 'name must not be empty'
    if (trimmed.length > HYPOTHESIS_CAPS.NAME) return `name must be at most ${HYPOTHESIS_CAPS.NAME} characters`
    out.name = trimmed
  }

  if (src.icp_id !== undefined) {
    if (src.icp_id !== null && (typeof src.icp_id !== 'number' || !Number.isInteger(src.icp_id) || src.icp_id <= 0)) {
      return 'icp_id must be a positive integer or null'
    }
    out.icp_id = src.icp_id
  }

  const err = applyOptionalText(out, src, 'description', HYPOTHESIS_CAPS.DESCRIPTION)
  if (err) return err

  if (src.archived !== undefined) {
    if (typeof src.archived !== 'boolean') return 'archived must be a boolean'
    out.archived = src.archived
  }

  return out as NormalizedHypothesis
}

/** Validate the campaign_id list for set_hypothesis_campaigns: a flat array of
 *  non-empty strings, deduplicated, capped generously (a hypothesis spanning
 *  hundreds of campaigns would be unusual but not invalid). Existence against
 *  the real `campaigns` table is checked by the caller (needs a DB round-trip). */
export function validateCampaignIds(raw: unknown): string[] | string {
  if (!Array.isArray(raw)) return 'campaign_ids must be an array of strings'
  const out = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) return 'campaign_ids must contain only non-empty strings'
    out.add(item.trim())
  }
  if (out.size > 500) return 'campaign_ids may have at most 500 entries'
  return [...out]
}
