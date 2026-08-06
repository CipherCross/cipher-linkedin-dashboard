/**
 * The coaching surface's one dashboard read: every account's rolled-up digest.
 *
 * `coaching_digest` is written by `/api/coach` (`AI_WRITE_OPERATIONS.coachDigestUpsert`)
 * and read by exactly one panel — the collapsible per-account digest on the Leads
 * Explorer. It holds one row per notebook, so it is neither a funnel relation nor
 * a paged one in any meaningful sense: the whole relation is four rows on this
 * team and the primary key `instance_id` makes the order total. Offset, like the
 * library reads, and for the same reason `library.ts` sets out — `OFFSET n` is
 * only pathological when `n` grows.
 *
 * ## Not tolerant, unlike the library
 *
 * The six library relations are marked `tolerateMissingRelation` because a
 * database predating migration 040 or 043 genuinely might not have them. This one
 * is in the portable baseline's first artifact
 * (`postgres/tenant-baseline/v1/001_portable_business_baseline.sql:113`), so it
 * cannot be "not yet migrated" on a database that answered any other read — and
 * the panel that renders it has its own error state, which is the same argument
 * that keeps `leads.notes` and `messages.thread` intolerant. An absent relation
 * here means a broken deployment and says so.
 *
 * ## `patterns` crosses as itself
 *
 * `jsonb` NOT NULL with a `'[]'` default, which `pg` parses into a JS array before
 * this module sees it — the same shape PostgREST produced, so `CoachingPattern[]`
 * in `types.ts` is unchanged. The non-array branch in the mapper is defensive
 * only; the column's default and NOT NULL make it unreachable.
 *
 * The playbook — the coach's *other* relation and the Playbook page's whole
 * content — is deliberately **not** here. It already has an operation:
 * `AI_WRITE_OPERATIONS.coachPlaybook` reads the same singleton for `/api/coach`,
 * and the read slice allowlists that name rather than spelling a second one. See
 * the note above `coachPlaybookOperation` in `aiWrites.ts`.
 */

import type { NeonQueryOperation, NeonRow } from '../neon.js'

export const COACHING_OPERATIONS = {
  /** Every account's rolled-up self-correction digest, one row per notebook. */
  digests: 'coaching.digests',
} as const

export interface CoachingDigestRow {
  readonly instance_id: string
  readonly summary: string | null
  readonly patterns: readonly unknown[]
  readonly computed_at: string | null
  readonly model: string | null
}

/** `instance_id` is the primary key, so this order is total. */
const COACHING_DIGESTS_SQL = `SELECT d.instance_id,
          d.summary,
          d.patterns,
          d.computed_at,
          d.model
     FROM public.coaching_digest d
    ORDER BY d.instance_id`

export const coachingDigestsOperation: NeonQueryOperation<CoachingDigestRow> = {
  build: () => ({ text: COACHING_DIGESTS_SQL }),
  mapRow: (row: NeonRow): CoachingDigestRow => ({
    instance_id: String(row.instance_id),
    summary: row.summary === null || row.summary === undefined ? null : String(row.summary),
    patterns: Array.isArray(row.patterns) ? row.patterns : [],
    computed_at:
      row.computed_at === null || row.computed_at === undefined
        ? null
        : String(row.computed_at),
    model: row.model === null || row.model === undefined ? null : String(row.model),
  }),
}
