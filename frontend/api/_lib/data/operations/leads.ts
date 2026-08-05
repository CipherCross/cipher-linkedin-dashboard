/**
 * `leads.directory` — every lead the team has reached, with its milestone
 * timestamps and its manual pipeline overlay.
 *
 * This is the largest read on the dashboard path and the one every metric
 * ultimately rests on: `frontend/src/lib/leads.ts` recomputes the whole funnel
 * from these rows (`rangeTotals`, `rangedCampaigns`, `stageOf`, `riskOf`) for the
 * date ranges and subsets the SQL views cannot express. So the rows have to arrive
 * shaped exactly as the browser already expects them, and completely.
 *
 * ## The column ladder does not survive, and that is a decision
 *
 * The Supabase path walks a four-rung retry ladder
 * (`DataContext.tsx:59`, `LEAD_COLUMN_LADDER`): ask for the widest column list,
 * and on PostgREST's SQLSTATE 42703 drop to a narrower rung. It exists because
 * that schema drifted — migrations 041/042/048 were applied out of band, so a
 * deployed frontend could be ahead of the database, and degrading beat a dead
 * dashboard during the window.
 *
 * **It is deliberately not reproduced here, and it is not offered as an operation
 * parameter either.** Three reasons, in the order that decided it:
 *
 * 1. **There is no drift window to survive.** The Neon schema is applied through
 *    the portable migration ledger, whose steps carry pinned digests, and the
 *    baseline already contains every column of the widest rung — including the
 *    demographics-v2 set (`postgres/tenant-baseline/v1/001_portable_business_baseline.sql:324`).
 *    A missing column here is not a migration in flight; it is a broken
 *    deployment.
 * 2. **Silent degradation is worse than failure on this particular read.** A
 *    narrower rung returns leads whose `pipeline_stage` is absent, and `stageOf`
 *    reads an absent stage as an un-staged lead. The dashboard would not break —
 *    it would report a *different funnel*, confidently. That trade was worth
 *    making against a dead page during a known migration window; it is not worth
 *    making to paper over a deployment error. So a missing column raises, the
 *    request 500s, and somebody fixes the deployment.
 * 3. **A caller-chosen column list is SQL crossing the contract boundary.** A
 *    parameter naming columns is a projection expressed by the caller, which is
 *    exactly what the operation registry exists to prevent. Making the ladder a
 *    parameter would have kept the letter of "handlers submit names, never SQL"
 *    while giving it up in substance.
 *
 * ## `assigned_to` is read and deliberately not resolved
 *
 * The column crosses this boundary as the integer it is. Nothing here joins it to
 * `team_members`, and no roster is served beside it, because the two id spaces
 * name different people: source id 1 is the real admin, target id 1 is the
 * immutable S06 fixture "Active One" (`docs/implementation-handoffs/N-B2.md`). A
 * join would mislabel every owner chip without failing anything. The pairing
 * invariant that follows — `leads` and `team_members` must move together, with the
 * source→target map applied — is recorded in the handoff and asserted in
 * `frontend/tests/dashboardSlice.test.ts`.
 */

import type {
  NeonKeysetValue,
  NeonQueryOperation,
  NeonRow,
} from '../neon.js'

export const LEADS_OPERATIONS = {
  /** Every lead, with milestones, pipeline overlay and demographics. */
  directory: 'leads.directory',
  /** The free-text notes an operator pinned to one lead, newest first. */
  notes: 'leads.notes',
} as const

/**
 * One lead, in the browser's own column names.
 *
 * Mirrors `Lead` in `frontend/src/lib/types.ts` — where the demographics fields
 * are declared optional precisely because the Supabase ladder could omit them.
 * They are non-optional-but-nullable here: this path always selects them, so
 * `null` means "not inferred" rather than "not asked for", which is a strictly
 * better signal. Assignability to `Lead` is asserted in the live suite.
 */
export interface LeadRow {
  readonly id: string
  readonly instance_id: string
  readonly campaign_id: string
  readonly profile_url: string
  readonly full_name: string | null
  readonly headline: string | null
  readonly company: string | null
  readonly added_at: string | null
  readonly invited_at: string | null
  readonly connected_at: string | null
  readonly first_message_at: string | null
  readonly replied_at: string | null
  readonly last_action_at: string | null
  readonly pipeline_stage: string | null
  readonly pipeline_substatus: string | null
  readonly lost_reason: string | null
  readonly pipeline_stage_changed_at: string | null
  /** A `team_members.id` in the *source* id space. Never resolved here. */
  readonly assigned_to: number | null
  readonly education_start_year: number | null
  readonly first_job_start_year: number | null
  readonly birth_year_min: number | null
  readonly birth_year_max: number | null
  readonly age_inferred_at: string | null
  readonly age_method_version: string | null
  readonly age_source: string | null
  readonly gender: string | null
  readonly gender_confidence: number | null
  readonly gender_inferred_at: string | null
  readonly gender_model_version: string | null
  readonly demo_inferred_at: string | null
  readonly demo_model: string | null
  readonly photo_path: string | null
  readonly photo_synced_at: string | null
}

export interface LeadsDirectoryParams {
  /**
   * Delta-refresh watermark: return only leads whose `updated_at` moved at or
   * after this instant. `null` fetches everything.
   *
   * **Why a parameter rather than the request's `range`.** For every other
   * operation in this slice `range` means "the window the rows belong to" —
   * `daily_activity.day`, `messages.sent_at`. `updated_at` is not that; it is a
   * replication watermark that has nothing to do with when anything happened, and
   * a lead invited in January reappears in a delta because somebody re-staged it
   * today. Overloading `range` to sometimes mean one and sometimes the other is
   * how a caller ends up filtering the wrong column. `leads.directory` therefore
   * ignores `range` entirely and takes this explicitly.
   *
   * Its correctness rests on the same 2-minute overlap the Supabase path uses
   * (`REFRESH_OVERLAP_MS`); nothing about that changes here.
   */
  readonly updatedSince: string | null
  readonly [key: string]: string | null
}

/**
 * `ORDER BY id` — the primary key, so the order is total and a keyset walk can
 * neither skip nor repeat.
 *
 * The Supabase path orders by `id` too, so a paged walk returns the same rows in
 * the same sequence on both providers, which is what keeps the client recompute
 * comparable between them.
 *
 * `id` is a `uuid`; PostgreSQL orders it byte-wise and consistently, and `>` on
 * uuid is the same total order the index provides. The cursor carries it as text.
 */
const LEADS_SQL = `SELECT l.id::text AS id,
          l.instance_id,
          l.campaign_id,
          l.profile_url,
          l.full_name,
          l.headline,
          l.company,
          l.added_at,
          l.invited_at,
          l.connected_at,
          l.first_message_at,
          l.replied_at,
          l.last_action_at,
          l.pipeline_stage,
          l.pipeline_substatus,
          l.lost_reason,
          l.pipeline_stage_changed_at,
          l.assigned_to,
          l.education_start_year,
          l.first_job_start_year,
          l.birth_year_min,
          l.birth_year_max,
          l.age_inferred_at,
          l.age_method_version,
          l.age_source,
          l.gender,
          l.gender_confidence,
          l.gender_inferred_at,
          l.gender_model_version,
          l.demo_inferred_at,
          l.demo_model,
          l.photo_path,
          l.photo_synced_at
     FROM public.leads l
    WHERE ($1::timestamptz IS NULL OR l.updated_at >= $1::timestamptz)
      AND ($2::uuid IS NULL OR l.id > $2::uuid)
    ORDER BY l.id`

const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

export const leadsDirectoryOperation: NeonQueryOperation<
  LeadRow,
  LeadsDirectoryParams
> = {
  // Keyset rather than offset, unlike the aggregate slices. This is a base table
  // whose live row count is tens of thousands across four notebooks, and `OFFSET
  // n` makes PostgreSQL walk and discard n rows on every page — so a full walk is
  // quadratic in the number of pages. The sort key is the primary key, so seeking
  // uses `leads_pkey` directly.
  keyset: { columns: ['id'] },
  build: ({ params, after }) => ({
    text: LEADS_SQL,
    values: [
      params?.updatedSince ?? null,
      // `after` is the previous page's last `id`. The declared arity is 1, and
      // the driver refuses a cursor of any other width before this runs.
      (after?.[0] as NeonKeysetValue | undefined) ?? null,
    ],
  }),
  mapRow: (row: NeonRow): LeadRow => ({
    id: String(row.id),
    instance_id: String(row.instance_id),
    campaign_id: String(row.campaign_id),
    profile_url: String(row.profile_url),
    full_name: nullableText(row.full_name),
    headline: nullableText(row.headline),
    company: nullableText(row.company),
    added_at: nullableText(row.added_at),
    invited_at: nullableText(row.invited_at),
    connected_at: nullableText(row.connected_at),
    first_message_at: nullableText(row.first_message_at),
    replied_at: nullableText(row.replied_at),
    last_action_at: nullableText(row.last_action_at),
    pipeline_stage: nullableText(row.pipeline_stage),
    pipeline_substatus: nullableText(row.pipeline_substatus),
    lost_reason: nullableText(row.lost_reason),
    pipeline_stage_changed_at: nullableText(row.pipeline_stage_changed_at),
    // `bigint`: `pg` hands it over as a string so a value wider than a JS number
    // cannot silently lose precision. The browser's `Lead.assigned_to` has always
    // been a number — PostgREST coerced it — so the coercion happens here.
    assigned_to: nullableNumber(row.assigned_to),
    education_start_year: nullableNumber(row.education_start_year),
    first_job_start_year: nullableNumber(row.first_job_start_year),
    birth_year_min: nullableNumber(row.birth_year_min),
    birth_year_max: nullableNumber(row.birth_year_max),
    age_inferred_at: nullableText(row.age_inferred_at),
    age_method_version: nullableText(row.age_method_version),
    age_source: nullableText(row.age_source),
    gender: nullableText(row.gender),
    gender_confidence: nullableNumber(row.gender_confidence),
    gender_inferred_at: nullableText(row.gender_inferred_at),
    gender_model_version: nullableText(row.gender_model_version),
    demo_inferred_at: nullableText(row.demo_inferred_at),
    demo_model: nullableText(row.demo_model),
    photo_path: nullableText(row.photo_path),
    photo_synced_at: nullableText(row.photo_synced_at),
  }),
}

// ---------------------------------------------------------------------------
// leads.notes — LeadNotesPanel's own read
// ---------------------------------------------------------------------------

/**
 * `LeadNotesPanel.tsx:43`'s read: one lead's notes, newest first, fetched on
 * first expand rather than with the dashboard.
 *
 * It stays a component-local read rather than joining `leads.directory`: notes are
 * opened for one lead at a time and most leads have none, so folding them into the
 * directory would multiply the largest read on the path by a relation almost
 * nobody looks at.
 *
 * **`created_at` is nullable, and that is why this one counts rather than seeks.**
 * The baseline declares `created_at timestamptz DEFAULT now()` with no NOT NULL,
 * so a note written by a path that passed an explicit NULL has none. A keyset seek
 * over a nullable leading column needs an explicit NULL ordering on both the
 * `ORDER BY` and the comparison, and a `ROW(...) < ROW(...)` compare involving
 * NULL evaluates to NULL rather than to false — which drops rows silently rather
 * than raising. With the relation bounded at a handful of notes per lead, offset
 * costs nothing and avoids the trap entirely.
 *
 * The order is `created_at DESC, id DESC`. The `id` tiebreaker is added here: the
 * Supabase path orders on `created_at` alone, which is fine for one unpaged
 * response and is not a total order. NULL placement is PostgreSQL's default for
 * `DESC`, which is NULLS FIRST — and it is PostgREST's too, since PostgREST emits
 * the same bare `DESC` unless a caller asks otherwise. So a note with no
 * `created_at` sorts first on both providers rather than first on one and last on
 * the other.
 */
export interface LeadNoteRow {
  readonly id: number
  readonly lead_id: string
  readonly author: string | null
  readonly body: string
  readonly created_at: string | null
}

export interface LeadNotesParams {
  /** The lead's `uuid`. Validated as one by the handler before it gets here. */
  readonly leadId: string
  readonly [key: string]: string | null
}

const LEAD_NOTES_SQL = `SELECT n.id::text AS id,
          n.lead_id::text AS lead_id,
          n.author,
          n.body,
          n.created_at
     FROM public.lead_notes n
    WHERE n.lead_id = $1::uuid
    ORDER BY n.created_at DESC, n.id DESC`

export const leadNotesOperation: NeonQueryOperation<LeadNoteRow, LeadNotesParams> =
  {
    build: ({ params }) => ({
      text: LEAD_NOTES_SQL,
      values: [params?.leadId ?? null],
    }),
    mapRow: (row: NeonRow): LeadNoteRow => ({
      id: Number(row.id),
      lead_id: String(row.lead_id),
      author: nullableText(row.author),
      body: String(row.body),
      // Nullable in the baseline; `LeadNote.created_at` in the browser is not.
      // The wider of the two crosses, so a NULL is visible rather than becoming
      // the epoch or the empty string.
      created_at: nullableText(row.created_at),
    }),
  }
