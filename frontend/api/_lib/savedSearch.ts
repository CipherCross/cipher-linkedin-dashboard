// Shared validation/normalization for saved_searches (Search Library), used by
// BOTH the write endpoint (/api/playbook save_search / delete_search) and the AI
// tool (_lib/tools.ts save_search) so the two write paths enforce identical caps
// and can't drift.
//
// Deliberately dependency-light (no supabase / ai / zod imports) so playbook.ts
// stays light — this module is pure input validation. The DB write itself lives in
// each caller (both use service-role db()), kept intentionally identical.

export const SEARCH_CAPS = {
  NAME: 120,
  PLATFORM: 60,
  DESCRIPTION: 2000,
  NOTES: 2000,
  KEYWORDS_PER_ARRAY: 50,
  KEYWORD_LEN: 120,
  BOOLEAN_QUERY: 5000,
  FILTER_KEYS: 40,
  FILTER_BYTES: 20_000,
  AUTHOR: 100,
} as const

export type FilterValue = string | number | boolean | string[]

/** The clean, ready-to-write payload. Only keys that were PROVIDED appear, so the
 *  same shape drives both a full insert and a partial-patch update. */
export interface NormalizedSearch {
  name?: string
  platform?: string
  description?: string | null
  include_keywords?: string[]
  exclude_keywords?: string[]
  boolean_query?: string | null
  filters?: Record<string, FilterValue>
  notes?: string | null
  author?: string | null
  archived?: boolean
}

// Fields that accept undefined (skip), null (clear to NULL), or a length-capped string.
const TEXT_FIELDS: Array<{ key: 'description' | 'boolean_query' | 'notes' | 'author'; cap: number }> = [
  { key: 'description', cap: SEARCH_CAPS.DESCRIPTION },
  { key: 'boolean_query', cap: SEARCH_CAPS.BOOLEAN_QUERY },
  { key: 'notes', cap: SEARCH_CAPS.NOTES },
  { key: 'author', cap: SEARCH_CAPS.AUTHOR },
]

const KEYWORD_FIELDS: Array<'include_keywords' | 'exclude_keywords'> = [
  'include_keywords',
  'exclude_keywords',
]

function normalizeKeywords(raw: unknown, field: string): string[] | string {
  if (!Array.isArray(raw)) return `${field} must be an array of strings`
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return `${field} must contain only strings`
    if (item.length > SEARCH_CAPS.KEYWORD_LEN) {
      return `each ${field} entry must be at most ${SEARCH_CAPS.KEYWORD_LEN} characters`
    }
    const trimmed = item.trim()
    if (trimmed) out.push(trimmed)
  }
  if (out.length > SEARCH_CAPS.KEYWORDS_PER_ARRAY) {
    return `${field} may have at most ${SEARCH_CAPS.KEYWORDS_PER_ARRAY} entries`
  }
  return out
}

function normalizeFilters(raw: unknown): Record<string, FilterValue> | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'filters must be a flat object'
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > SEARCH_CAPS.FILTER_KEYS) {
    return `filters may have at most ${SEARCH_CAPS.FILTER_KEYS} keys`
  }
  const out: Record<string, FilterValue> = {}
  for (const [k, v] of entries) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      if (typeof v === 'number' && !Number.isFinite(v)) {
        return `filters['${k}'] must be a finite number`
      }
      out[k] = v
    } else if (Array.isArray(v)) {
      if (!v.every((x) => typeof x === 'string')) {
        return `filters['${k}'] array must contain only strings`
      }
      out[k] = v as string[]
    } else {
      return `filters['${k}'] must be a string, number, boolean, or string array`
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length
  if (bytes > SEARCH_CAPS.FILTER_BYTES) {
    return `filters is too large (${bytes} bytes; max ${SEARCH_CAPS.FILTER_BYTES})`
  }
  return out
}

/**
 * Validate + normalize a saved-search payload.
 *
 * @param input      the raw search object (its `id`, if any, is ignored here — the
 *                   caller handles insert-vs-update routing).
 * @param requireCore true for a create (name + platform must be present & valid),
 *                    false for a partial-patch update (only provided fields change).
 * @returns the clean {@link NormalizedSearch} on success, or a human-readable error
 *          string on failure. (typeof result === 'string'  ->  validation failed.)
 */
export function validateSearch(
  input: unknown,
  requireCore: boolean
): NormalizedSearch | string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return 'search must be an object'
  }
  const src = input as Record<string, unknown>
  // Accumulate untyped, then cast once — every value written here has already been
  // validated to the type NormalizedSearch declares for that key.
  const out: Record<string, unknown> = {}

  // name / platform — required on create, optional (but validated) on update.
  for (const { key, cap } of [
    { key: 'name' as const, cap: SEARCH_CAPS.NAME },
    { key: 'platform' as const, cap: SEARCH_CAPS.PLATFORM },
  ]) {
    const v = src[key]
    if (v === undefined) {
      if (requireCore) return `${key} is required`
      continue
    }
    if (typeof v !== 'string') return `${key} must be a string`
    const trimmed = v.trim()
    if (!trimmed) return `${key} must not be empty`
    if (trimmed.length > cap) return `${key} must be at most ${cap} characters`
    out[key] = trimmed
  }

  // Optional text fields: undefined skips, null clears, string is length-capped.
  for (const { key, cap } of TEXT_FIELDS) {
    const v = src[key]
    if (v === undefined) continue
    if (v === null) {
      out[key] = null
      continue
    }
    if (typeof v !== 'string') return `${key} must be a string or null`
    if (v.length > cap) return `${key} must be at most ${cap} characters`
    out[key] = v
  }

  // Keyword arrays.
  for (const key of KEYWORD_FIELDS) {
    const v = src[key]
    if (v === undefined) continue
    const kw = normalizeKeywords(v, key)
    if (typeof kw === 'string') return kw
    out[key] = kw
  }

  // filters (flat object).
  if (src.filters !== undefined) {
    const f = normalizeFilters(src.filters)
    if (typeof f === 'string') return f
    out.filters = f
  }

  // archived flag.
  if (src.archived !== undefined) {
    if (typeof src.archived !== 'boolean') return 'archived must be a boolean'
    out.archived = src.archived
  }

  return out as NormalizedSearch
}
