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
 * immutable S06 fixture "Active One" (`docs/archive/implementation-handoffs/N-B2.md`). A
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
  /** Filtered/sorted Leads Explorer page with reply and follow-up projections. */
  searchPage: 'leads.searchPage',
  /** The free-text notes an operator pinned to one lead, newest first. */
  notes: 'leads.notes',
  /**
   * Where a named set of leads' photos live — the object-storage read's only
   * database access.
   *
   * Two columns and nothing else, for a reason that is the whole point of it
   * being a separate operation: it is the *authorization* step of the photo path.
   * `leads.directory` already carries `photo_path`, so this projection is
   * redundant as data — but a signed URL must be minted from a path the database
   * handed this actor just now, not from one a client sent back. See
   * `storage/leadPhotoService.ts`.
   */
  photoObjects: 'leads.photoObjects',
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
// leads.searchPage — server-side Leads/Replies explorer
// ---------------------------------------------------------------------------

export interface LeadsSearchPageParams {
  readonly instanceId: string | null
  readonly campaignId: string | null
  readonly stage: string | null
  readonly risk: string | null
  readonly pipeline: string | null
  readonly owner: string | null
  readonly gender: string | null
  readonly ageBucket: string | null
  readonly followUp: string | null
  readonly repliedSince: string | null
  readonly sentiment: string | null
  readonly intent: string | null
  readonly query: string | null
  readonly sort: string
  readonly direction: string
  readonly today: string
  readonly pageSize: string
  readonly page: string
  readonly [key: string]: string | null
}

export interface LeadsSearchPageRow {
  readonly items: readonly unknown[]
  readonly total: number
  readonly allTotal: number
  readonly replyCounts: {
    readonly total: number
    readonly c: Readonly<Record<string, number>>
  }
}

/**
 * The explorer used to download every lead, every inbound message, the intent
 * view and follow-up state before filtering 50 rows in the browser. This query
 * keeps the exact filter vocabulary but returns one JSON payload for one page.
 *
 * Offset is intentional here. Unlike `leads.directory`, users can sort on seven
 * nullable columns and jump to a shared page number; a keyset cursor would make
 * page 12 depend on ten prior requests and would no longer be shareable. The
 * filtered set must already be scanned for exact sentiment facets and total
 * count, so offset does not introduce the old full-tenant network/JSON cost.
 */
const LEADS_SEARCH_PAGE_SQL = `WITH latest_inbound AS (
  SELECT DISTINCT ON (m.instance_id, m.profile_url)
         m.instance_id,
         m.profile_url,
         m.id,
         m.campaign_id,
         m.body,
         m.sent_at,
         m.sentiment,
         m.reason,
         m.intent_level,
         m.intent_reason
    FROM public.messages m
   WHERE m.direction = 'in'
     AND m.body IS NOT NULL
     AND btrim(m.body) <> ''
   ORDER BY m.instance_id, m.profile_url, m.sent_at DESC, m.id DESC
), intent_by_conversation AS (
  SELECT m.instance_id,
         m.profile_url,
         CASE max(CASE m.intent_level WHEN 'p3' THEN 3 WHEN 'p2' THEN 2 WHEN 'p1' THEN 1 END)
           WHEN 3 THEN 'p3'
           WHEN 2 THEN 'p2'
           WHEN 1 THEN 'p1'
           ELSE NULL
         END AS highest_intent
    FROM public.messages m
   WHERE m.direction = 'in' AND m.intent_level IS NOT NULL
   GROUP BY m.instance_id, m.profile_url
), joined AS (
  SELECT l.*,
         li.id AS latest_reply_id,
         li.campaign_id AS latest_reply_campaign_id,
         li.body AS latest_reply_body,
         li.sent_at AS latest_reply_sent_at,
         li.sentiment AS latest_reply_sentiment,
         li.reason AS latest_reply_reason,
         li.intent_level AS latest_reply_intent,
         li.intent_reason AS latest_reply_intent_reason,
         ri.highest_intent,
         s.next_follow_up_date,
         s.owner_id AS follow_up_owner_id,
         s.revision AS follow_up_revision,
         s.last_event_id AS follow_up_last_event_id,
         s.last_mutation_id AS follow_up_last_mutation_id,
         s.created_at AS follow_up_created_at,
         s.updated_at AS follow_up_updated_at,
         s.updated_by AS follow_up_updated_by,
         s.archived_at AS follow_up_archived_at,
         CASE
           WHEN l.replied_at IS NOT NULL THEN 'replied'
           WHEN l.connected_at IS NOT NULL THEN 'accepted'
           WHEN l.invited_at IS NOT NULL THEN 'invited'
           ELSE 'queued'
         END AS derived_stage,
         CASE
           WHEN l.birth_year_min IS NULL OR l.birth_year_max IS NULL THEN NULL
           ELSE floor(
             extract(year FROM now() AT TIME ZONE 'UTC')
             - (l.birth_year_min + l.birth_year_max) / 2.0
           )::int
         END AS derived_age
    FROM public.leads l
    LEFT JOIN latest_inbound li
      ON li.instance_id = l.instance_id AND li.profile_url = l.profile_url
    LEFT JOIN intent_by_conversation ri
      ON ri.instance_id = l.instance_id AND ri.profile_url = l.profile_url
    LEFT JOIN public.conversation_follow_up_state s
      ON s.instance_id = l.instance_id AND s.profile_url = l.profile_url
), base AS (
  SELECT j.*
    FROM joined j
   WHERE ($1::text IS NULL OR j.instance_id = $1::text)
     AND ($2::text IS NULL OR j.campaign_id = $2::text)
     AND ($3::text IS NULL OR j.derived_stage = $3::text)
     AND (
       $4::text IS NULL
       OR ($4::text = 'pending_2w' AND j.invited_at < now() - interval '14 days' AND j.connected_at IS NULL)
       OR ($4::text = 'no_reply_2w' AND j.connected_at < now() - interval '14 days' AND j.replied_at IS NULL)
     )
     AND (
       $5::text IS NULL
       OR ($5::text = 'untriaged' AND j.replied_at IS NOT NULL AND j.pipeline_stage IS NULL)
       OR ($5::text <> 'untriaged' AND j.pipeline_stage = $5::text)
     )
     AND (
       $6::text IS NULL
       OR ($6::text = 'unassigned' AND j.assigned_to IS NULL)
       OR ($6::text <> 'unassigned' AND j.assigned_to::text = $6::text)
     )
     AND (
       $7::text IS NULL
       OR ($7::text = 'pending' AND j.gender IS NULL)
       OR ($7::text <> 'pending' AND j.gender = $7::text)
     )
     AND (
       $8::text IS NULL
       OR ($8::text = 'under_25' AND j.derived_age < 25)
       OR ($8::text = '25_34' AND j.derived_age BETWEEN 25 AND 34)
       OR ($8::text = '35_44' AND j.derived_age BETWEEN 35 AND 44)
       OR ($8::text = '45_54' AND j.derived_age BETWEEN 45 AND 54)
       OR ($8::text = '55_plus' AND j.derived_age >= 55)
     )
     AND (
       $9::text IS NULL
       OR ($9::text = 'unscheduled' AND (j.next_follow_up_date IS NULL OR j.follow_up_archived_at IS NOT NULL))
       OR ($9::text = 'overdue' AND j.next_follow_up_date < $16::date AND j.follow_up_archived_at IS NULL)
       OR ($9::text = 'today' AND j.next_follow_up_date = $16::date AND j.follow_up_archived_at IS NULL)
       OR ($9::text = 'upcoming' AND j.next_follow_up_date > $16::date AND j.follow_up_archived_at IS NULL)
     )
     AND (
       $13::text IS NULL
       OR lower(concat_ws(' ', j.full_name, j.headline, j.company)) LIKE '%' || lower($13::text) || '%'
     )
), reply_base AS (
  SELECT b.*
    FROM base b
   WHERE b.replied_at IS NOT NULL
     AND ($10::timestamptz IS NULL OR b.replied_at >= $10::timestamptz)
), filtered AS (
  SELECT b.*
    FROM base b
   WHERE ($10::timestamptz IS NULL OR b.replied_at >= $10::timestamptz)
     AND (
       $11::text IS NULL
       OR ($11::text = 'any' AND b.replied_at IS NOT NULL)
       OR ($11::text = 'unclassified' AND b.replied_at IS NOT NULL AND b.latest_reply_sentiment IS NULL)
       OR ($11::text NOT IN ('any', 'unclassified') AND b.latest_reply_sentiment = $11::text)
     )
     AND (
       $12::text IS NULL
       OR ($12::text = 'none' AND b.highest_intent IS NULL)
       OR ($12::text <> 'none' AND b.highest_intent = $12::text)
     )
), ordered AS (
  SELECT f.*,
         row_number() OVER (ORDER BY
           CASE WHEN $14::text = 'full_name' AND $15::text = 'asc' THEN lower(f.full_name) END ASC NULLS LAST,
           CASE WHEN $14::text = 'full_name' AND $15::text = 'desc' THEN lower(f.full_name) END DESC NULLS LAST,
           CASE WHEN $14::text = 'added_at' AND $15::text = 'asc' THEN f.added_at END ASC NULLS LAST,
           CASE WHEN $14::text = 'added_at' AND $15::text = 'desc' THEN f.added_at END DESC NULLS LAST,
           CASE WHEN $14::text = 'invited_at' AND $15::text = 'asc' THEN f.invited_at END ASC NULLS LAST,
           CASE WHEN $14::text = 'invited_at' AND $15::text = 'desc' THEN f.invited_at END DESC NULLS LAST,
           CASE WHEN $14::text = 'connected_at' AND $15::text = 'asc' THEN f.connected_at END ASC NULLS LAST,
           CASE WHEN $14::text = 'connected_at' AND $15::text = 'desc' THEN f.connected_at END DESC NULLS LAST,
           CASE WHEN $14::text = 'replied_at' AND $15::text = 'asc' THEN f.replied_at END ASC NULLS LAST,
           CASE WHEN $14::text = 'replied_at' AND $15::text = 'desc' THEN f.replied_at END DESC NULLS LAST,
           CASE WHEN $14::text = 'last_action_at' AND $15::text = 'asc' THEN f.last_action_at END ASC NULLS LAST,
           CASE WHEN $14::text = 'last_action_at' AND $15::text = 'desc' THEN f.last_action_at END DESC NULLS LAST,
           CASE WHEN $14::text = 'next_follow_up_date' AND $15::text = 'asc' THEN f.next_follow_up_date END ASC NULLS LAST,
           CASE WHEN $14::text = 'next_follow_up_date' AND $15::text = 'desc' THEN f.next_follow_up_date END DESC NULLS LAST,
           f.id ASC
         ) AS page_order
    FROM filtered f
), paged AS (
  SELECT *
    FROM ordered
   WHERE page_order > ($18::int * $17::int)
     AND page_order <= (($18::int + 1) * $17::int)
   ORDER BY page_order
), reply_counts AS (
  SELECT coalesce(latest_reply_sentiment, 'unclassified') AS bucket, count(*)::int AS cnt
    FROM reply_base
   GROUP BY coalesce(latest_reply_sentiment, 'unclassified')
)
SELECT jsonb_build_object(
  'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'lead', to_jsonb(p) - ARRAY[
        'updated_at', 'derived_stage', 'derived_age', 'latest_reply_id',
        'latest_reply_campaign_id', 'latest_reply_body', 'latest_reply_sent_at',
        'latest_reply_sentiment', 'latest_reply_reason', 'latest_reply_intent',
        'latest_reply_intent_reason', 'highest_intent', 'next_follow_up_date',
        'follow_up_owner_id', 'follow_up_revision', 'follow_up_last_event_id',
        'follow_up_last_mutation_id', 'follow_up_created_at', 'follow_up_updated_at',
        'follow_up_updated_by', 'follow_up_archived_at', 'page_order'
      ]::text[],
      'reply', CASE WHEN p.latest_reply_id IS NULL THEN NULL ELSE jsonb_build_object(
        'body', p.latest_reply_body,
        'sentiment', p.latest_reply_sentiment,
        'reason', p.latest_reply_reason,
        'intent_level', p.latest_reply_intent,
        'intent_reason', p.latest_reply_intent_reason,
        'highest_intent', p.highest_intent,
        'sent_at', p.latest_reply_sent_at
      ) END,
      'highestIntent', p.highest_intent,
      'followUp', CASE WHEN p.follow_up_updated_at IS NULL THEN NULL ELSE jsonb_build_object(
        'instance_id', p.instance_id,
        'profile_url', p.profile_url,
        'next_follow_up_date', to_char(p.next_follow_up_date, 'YYYY-MM-DD'),
        'owner_id', p.follow_up_owner_id,
        'revision', p.follow_up_revision,
        'last_event_id', p.follow_up_last_event_id,
        'last_mutation_id', p.follow_up_last_mutation_id,
        'created_at', p.follow_up_created_at,
        'updated_at', p.follow_up_updated_at,
        'updated_by', p.follow_up_updated_by,
        'archived_at', p.follow_up_archived_at
      ) END
    ) ORDER BY p.page_order)
      FROM paged p
  ), '[]'::jsonb),
  'total', (SELECT count(*)::int FROM filtered),
  'allTotal', (SELECT count(*)::int FROM joined),
  'replyCounts', jsonb_build_object(
    'total', (SELECT count(*)::int FROM reply_base),
    'c', coalesce((SELECT jsonb_object_agg(bucket, cnt) FROM reply_counts), '{}'::jsonb)
  )
) AS payload`

export const leadsSearchPageOperation: NeonQueryOperation<
  LeadsSearchPageRow,
  LeadsSearchPageParams
> = {
  build: ({ params }) => ({
    text: LEADS_SEARCH_PAGE_SQL,
    values: [
      params?.instanceId ?? null,
      params?.campaignId ?? null,
      params?.stage ?? null,
      params?.risk ?? null,
      params?.pipeline ?? null,
      params?.owner ?? null,
      params?.gender ?? null,
      params?.ageBucket ?? null,
      params?.followUp ?? null,
      params?.repliedSince ?? null,
      params?.sentiment ?? null,
      params?.intent ?? null,
      params?.query ?? null,
      params?.sort ?? 'last_action_at',
      params?.direction ?? 'desc',
      params?.today ?? null,
      params?.pageSize ?? '50',
      params?.page ?? '0',
    ],
  }),
  mapRow: (row: NeonRow): LeadsSearchPageRow => {
    const payload = row.payload as LeadsSearchPageRow | undefined
    return payload ?? { items: [], total: 0, allTotal: 0, replyCounts: { total: 0, c: {} } }
  },
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

// ---------------------------------------------------------------------------
// leads.photoObjects — the photo path's authorization step
// ---------------------------------------------------------------------------

/**
 * The photo location of a named set of leads.
 *
 * ## Why the ids arrive as one array parameter
 *
 * `= ANY($1::uuid[])` rather than a generated `IN (…)` list. A per-id placeholder
 * list would make the *SQL text* depend on the batch size, which defeats the
 * statement cache and puts caller-controlled arity into a query string — the two
 * things this registry exists to keep out of handlers. One array parameter of any
 * length is one prepared statement.
 *
 * The endpoint validates each id as a uuid before this runs, so the cast cannot
 * raise 22P02 on caller input. That is a status-code decision, not a safety one:
 * the values are parameters and a malformed one would simply match nothing.
 *
 * ## Why rows with no photo come back at all
 *
 * `photo_path IS NULL` is not filtered out here. The caller needs to distinguish
 * "this lead has no photo" from "this lead is not visible to you" — the first is
 * ordinary and the second is a refusal — and a query that dropped both would make
 * them the same empty answer. The service treats a NULL path as absent; the
 * *missing row* is what a denial looks like.
 *
 * RLS does the deciding. `app_runtime` reads `public.leads` under the baseline's
 * membership policy with `app.actor_id` set by the transaction wrapper, so a lead
 * the actor may not see produces no row here regardless of what was asked for.
 */
export interface LeadPhotoObjectRow {
  readonly lead_id: string
  readonly photo_path: string | null
}

export interface LeadPhotoObjectsParams {
  /**
   * The lead ids, as a single comma-free array value.
   *
   * Typed as a string array rather than `DataStoreParams`' scalar union, which is
   * why this interface does not carry the index signature the others do — see
   * `leadPhotoObjectsOperation`'s `build`.
   */
  readonly leadIds: readonly string[]
}

const LEAD_PHOTO_OBJECTS_SQL = `SELECT l.id::text AS lead_id,
          l.photo_path
     FROM public.leads l
    WHERE l.id = ANY($1::uuid[])
    ORDER BY l.id`

export const leadPhotoObjectsOperation: NeonQueryOperation<
  LeadPhotoObjectRow,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see below
  any
> = {
  // The params type is widened here rather than in `LeadPhotoObjectsParams`
  // because `DataStoreParams` values are scalars: every other operation passes
  // strings, and an array-valued parameter is the first exception. Widening at the
  // registration point keeps the exception visible at exactly one line instead of
  // loosening the shared contract type for every operation that does not need it.
  build: ({ params }) => ({
    text: LEAD_PHOTO_OBJECTS_SQL,
    values: [(params?.leadIds as readonly string[] | undefined) ?? []],
  }),
  mapRow: (row: NeonRow): LeadPhotoObjectRow => ({
    lead_id: String(row.lead_id),
    photo_path: nullableText(row.photo_path),
  }),
}
