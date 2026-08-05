/**
 * The dashboard's topline read operations (S13, first slice).
 *
 * These are the relations `DataContext` re-fetches **in full on every cycle** —
 * no delta cursor, no column-ladder retry, no fetch asymmetry to preserve. One
 * of them already had an operation before this file existed
 * (`activity.dailySeries`, S12); the five here complete the slice, and it is
 * six relations rather than seven for the reason below.
 *
 * **The `team_members` roster is deliberately not part of this slice.** N-S12
 * pre-decided the opposite — "the `team_members` roster is available through the
 * B4 function, so assignee and owner name joins work" — and that premise does
 * not hold while `leads` is still read from Supabase. `leads.assigned_to` is a
 * Supabase `team_members.id`, and the two id spaces denote different people:
 * source id 1 is the real admin, target id 1 is the immutable S06 fixture
 * "Active One" (N-B2 records the full map). A roster served from
 * `public.team_roster()` and joined against Supabase-shaped `assigned_to` values
 * in `usePipelineActions.memberName` would not fail — every owner chip on
 * Pipeline and every CSV `assigned_to` column would simply name the wrong
 * person. Nothing here reads `team_members` or any column referencing it, and
 * `frontend/tests/dashboardSlice.test.ts` asserts that rather than trusting this
 * comment.
 *
 * Two consequences for the session that moves the roster (S18 or later):
 * `team_members` and `leads` must move **together**, with the source→target id
 * map applied to `assigned_to`; and `public.team_roster()` returns no
 * `auth_user_id`, so `Team.tsx`'s "Login enabled" / "Assignment only" label —
 * which today keys on that column alone — has no source on the Neon side and
 * needs a roster column that says whether a login exists.
 *
 * **They are named as product operations, not as table reads.** G2's
 * architectural direction is explicit that the dispatching endpoint's allowlist
 * is the first entries of the application API's vocabulary rather than a
 * transitional shim, so the name says what the application offers
 * (`campaigns.performance`) and not which relation currently answers it
 * (`campaign_metrics`). A later session may re-derive any of these without the
 * vocabulary moving.
 *
 * Three rules every operation here follows:
 *
 * 1. **Read the same relation the Supabase path reads.** `campaign_metrics` and
 *    `daily_activity` are the two views B2 compared cell-for-cell on real
 *    numbers; reading the view rather than re-deriving the aggregate is what
 *    keeps that evidence applicable.
 * 2. **Emit the browser's own column names.** The rows land in `DashboardData`
 *    unchanged, so the types in `frontend/src/lib/types.ts` do not fork and no
 *    page learns which provider answered.
 * 3. **Order totally.** The driver wraps every query in `LIMIT/OFFSET`, so an
 *    ordering that is not a total order can repeat or skip a row across a page
 *    boundary. Every `ORDER BY` below ends in a unique-by-construction column.
 */

import type { NeonQueryOperation, NeonRow } from '../neon.js'

export const DASHBOARD_OPERATIONS = {
  /** Every notebook/account this team syncs, with its health fields. */
  instancesOverview: 'instances.overview',
  /** Per-campaign funnel totals and rates — the topline table. */
  campaignsPerformance: 'campaigns.performance',
  /** The outreach sequence behind each campaign, step by step. */
  campaignsSequenceSteps: 'campaigns.sequenceSteps',
  /** The sync agent's recent runs, newest first — the Health page. */
  syncRecentRuns: 'sync.recentRuns',
  /** Operator notes pinned to a day, an instance or a campaign. */
  annotationsTimeline: 'annotations.timeline',
} as const

// ---------------------------------------------------------------------------
// Row shapes. Declared here rather than imported from `frontend/src/lib/types.ts`
// because `frontend/api/` is type-checked on its own (`tsconfig.api.json`) and
// must not depend on the SPA's module graph. The client asserts the two agree.
// ---------------------------------------------------------------------------

export interface InstanceRow {
  readonly id: string
  readonly label: string
  readonly last_sync_at: string | null
  readonly agent_version: string | null
  readonly account_name: string | null
  readonly account_url: string | null
  readonly account_avatar: string | null
  readonly config: Record<string, unknown> | null
  readonly config_updated_at: string | null
}

export interface CampaignMetricsRow {
  readonly campaign_id: string
  readonly campaign_name: string
  readonly instance_id: string
  readonly status: string
  readonly total_leads: number
  readonly invites_sent: number
  readonly accepted: number
  readonly replies: number
  readonly acceptance_rate: number | null
  readonly reply_rate: number | null
  readonly last_activity_at: string | null
  readonly briefing_context: string | null
  readonly briefing_context_updated_at: string | null
}

export interface CampaignStepRow {
  readonly campaign_id: string
  readonly step_index: number
  readonly step_label: string | null
  readonly step_type: string | null
  readonly template_body: string | null
  readonly sent_count: number
  readonly replied_count: number
  readonly current_count: number
}

export interface SyncRunRow {
  readonly id: string
  readonly instance_id: string
  readonly started_at: string
  readonly finished_at: string | null
  readonly status: string
  readonly rows_upserted: number | null
  readonly error: string | null
}

export interface AnnotationRow {
  readonly id: number
  readonly instance_id: string | null
  readonly campaign_id: string | null
  readonly note: string
  /** UTC calendar day, `YYYY-MM-DD`. A `date` column, not an instant. */
  readonly noted_at: string
}

// ---------------------------------------------------------------------------
// Mapping helpers.
// ---------------------------------------------------------------------------

const text = (value: unknown): string => String(value)
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

/**
 * `count(*)` is `bigint` and `round(...)` is `numeric`; `pg` returns both as
 * strings so a value wider than a JS number cannot silently lose precision.
 * The browser's `CampaignMetrics` has always held numbers — PostgREST coerces
 * them on the Supabase side — so the coercion happens here instead, and `null`
 * stays `null` rather than becoming `0`.
 */
const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

const requiredNumber = (value: unknown): number => Number(value)

// ---------------------------------------------------------------------------
// instances.overview
// ---------------------------------------------------------------------------

/**
 * The same column list `DataContext` asks PostgREST for, in the same order.
 * `created_at` is deliberately absent from both: no page reads it.
 */
const INSTANCES_SQL = `SELECT i.id,
          i.label,
          i.last_sync_at,
          i.agent_version,
          i.account_name,
          i.account_url,
          i.account_avatar,
          i.config,
          i.config_updated_at
     FROM public.instances i
    ORDER BY i.id`

export const instancesOverviewOperation: NeonQueryOperation<InstanceRow> = {
  build: () => ({ text: INSTANCES_SQL }),
  mapRow: (row: NeonRow): InstanceRow => ({
    id: text(row.id),
    label: text(row.label),
    last_sync_at: nullableText(row.last_sync_at),
    agent_version: nullableText(row.agent_version),
    account_name: nullableText(row.account_name),
    account_url: nullableText(row.account_url),
    account_avatar: nullableText(row.account_avatar),
    // `jsonb` is already parsed by `pg`. The baseline defaults it to `{}` and
    // declares it NOT NULL, so the `null` branch is defensive only.
    config: (row.config ?? null) as Record<string, unknown> | null,
    config_updated_at: nullableText(row.config_updated_at),
  }),
}

// ---------------------------------------------------------------------------
// campaigns.performance
// ---------------------------------------------------------------------------

/**
 * `ORDER BY campaign_name, campaign_id`.
 *
 * The Supabase path orders by `campaign_name` alone, which is not unique — two
 * campaigns on different instances routinely share a name. That is harmless
 * there because PostgREST returns the whole (small) relation in one response,
 * and it is *not* harmless here, because this path pages. The tiebreaker is the
 * primary key, so the order is total and every page boundary is stable.
 */
const CAMPAIGN_METRICS_SQL = `SELECT cm.campaign_id,
          cm.campaign_name,
          cm.instance_id,
          cm.status,
          cm.total_leads,
          cm.invites_sent,
          cm.accepted,
          cm.replies,
          cm.acceptance_rate,
          cm.reply_rate,
          cm.last_activity_at,
          cm.briefing_context,
          cm.briefing_context_updated_at
     FROM public.campaign_metrics cm
    ORDER BY cm.campaign_name, cm.campaign_id`

export const campaignsPerformanceOperation: NeonQueryOperation<CampaignMetricsRow> =
  {
    build: () => ({ text: CAMPAIGN_METRICS_SQL }),
    mapRow: (row: NeonRow): CampaignMetricsRow => ({
      campaign_id: text(row.campaign_id),
      campaign_name: text(row.campaign_name),
      instance_id: text(row.instance_id),
      status: text(row.status),
      total_leads: requiredNumber(row.total_leads),
      invites_sent: requiredNumber(row.invites_sent),
      accepted: requiredNumber(row.accepted),
      replies: requiredNumber(row.replies),
      acceptance_rate: nullableNumber(row.acceptance_rate),
      reply_rate: nullableNumber(row.reply_rate),
      last_activity_at: nullableText(row.last_activity_at),
      briefing_context: nullableText(row.briefing_context),
      briefing_context_updated_at: nullableText(row.briefing_context_updated_at),
    }),
  }

// ---------------------------------------------------------------------------
// campaigns.sequenceSteps
// ---------------------------------------------------------------------------

/**
 * `(campaign_id, step_index)` is the table's primary key, so this order is
 * total. `updated_at` exists on the relation and is not selected: the Supabase
 * path fetches it only because it asks for `*`, and no page reads it.
 */
const CAMPAIGN_STEPS_SQL = `SELECT s.campaign_id,
          s.step_index,
          s.step_label,
          s.step_type,
          s.template_body,
          s.sent_count,
          s.replied_count,
          s.current_count
     FROM public.campaign_steps s
    ORDER BY s.campaign_id, s.step_index`

export const campaignsSequenceStepsOperation: NeonQueryOperation<CampaignStepRow> =
  {
    build: () => ({ text: CAMPAIGN_STEPS_SQL }),
    mapRow: (row: NeonRow): CampaignStepRow => ({
      campaign_id: text(row.campaign_id),
      step_index: requiredNumber(row.step_index),
      step_label: nullableText(row.step_label),
      step_type: nullableText(row.step_type),
      template_body: nullableText(row.template_body),
      sent_count: requiredNumber(row.sent_count),
      replied_count: requiredNumber(row.replied_count),
      current_count: requiredNumber(row.current_count),
    }),
  }

// ---------------------------------------------------------------------------
// sync.recentRuns
// ---------------------------------------------------------------------------

/**
 * Newest first, with the primary key as tiebreaker — a nightly cron starts
 * every notebook's run within the same second, so `started_at` alone is not a
 * total order and the Health page's first page would be non-deterministic.
 *
 * The Supabase path caps this at 200 rows with `.limit(200)`. The cap lives in
 * the caller here, as a page limit, because a limit baked into the SQL and a
 * limit applied by the driver's `LIMIT/OFFSET` wrapper would compose into
 * something neither one states.
 */
const SYNC_RUNS_SQL = `SELECT r.id::text AS id,
          r.instance_id,
          r.started_at,
          r.finished_at,
          r.status,
          r.rows_upserted,
          r.error
     FROM public.sync_runs r
    ORDER BY r.started_at DESC, r.id DESC`

export const syncRecentRunsOperation: NeonQueryOperation<SyncRunRow> = {
  build: () => ({ text: SYNC_RUNS_SQL }),
  mapRow: (row: NeonRow): SyncRunRow => ({
    id: text(row.id),
    instance_id: text(row.instance_id),
    started_at: text(row.started_at),
    finished_at: nullableText(row.finished_at),
    status: text(row.status),
    rows_upserted: nullableNumber(row.rows_upserted),
    error: nullableText(row.error),
  }),
}

// ---------------------------------------------------------------------------
// annotations.timeline
// ---------------------------------------------------------------------------

/**
 * `noted_at` is selected as text for the same reason `daily_activity.day` is
 * (see `activity.ts`): it is a `date`, a calendar day rather than an instant,
 * and the browser compares it against `YYYY-MM-DD` strings produced by
 * `presetRanges`. The driver normalizes OID 1082 too, so this is belt and
 * braces — and it keeps the operation's contract independent of the driver's
 * parser.
 */
const ANNOTATIONS_SQL = `SELECT a.id,
          a.instance_id,
          a.campaign_id,
          a.note,
          to_char(a.noted_at, 'YYYY-MM-DD') AS noted_at
     FROM public.annotations a
    ORDER BY a.noted_at, a.id`

export const annotationsTimelineOperation: NeonQueryOperation<AnnotationRow> = {
  build: () => ({ text: ANNOTATIONS_SQL }),
  mapRow: (row: NeonRow): AnnotationRow => ({
    id: requiredNumber(row.id),
    instance_id: nullableText(row.instance_id),
    campaign_id: nullableText(row.campaign_id),
    note: text(row.note),
    noted_at: text(row.noted_at),
  }),
}
