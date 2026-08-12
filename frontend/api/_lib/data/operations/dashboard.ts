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
  /** Minimal shell/navigation data, returned as one row and one actor check. */
  bootstrap: 'dashboard.bootstrap',
  /** Exact route-level aggregates for Overview; never returns raw lead/message rows. */
  overviewSummary: 'overview.summary',
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

export interface DashboardBootstrapRow {
  readonly instances: readonly InstanceRow[]
  readonly campaigns: readonly CampaignMetricsRow[]
  readonly teamMembers: readonly {
    id: number
    name: string
    active: boolean
    created_at: string
    auth_user_id: null
    email: string | null
    role: 'member' | 'admin'
  }[]
}

export interface OverviewTotalsRow {
  readonly leads: number
  readonly invites: number
  readonly accepted: number
  readonly replies: number
  readonly positive: number
  readonly acceptedOfInvited: number
  readonly repliedOfConnected: number
  readonly added: number
}

export interface OverviewIntentMetricsRow {
  readonly p1: number
  readonly p2: number
  readonly p3: number
  readonly p3Booked: number
  readonly matureP3: number
  readonly matureP3Booked: number
  readonly p3Ghosted: number
}

export interface OverviewAccountSummaryRow {
  readonly instance_id: string
  readonly totals: OverviewTotalsRow
  readonly prevTotals: OverviewTotalsRow | null
  readonly intent: OverviewIntentMetricsRow
  readonly intentPrev: OverviewIntentMetricsRow | null
  readonly weeklyAdded: number
}

export interface OverviewFunnelRow {
  readonly leads: number
  readonly invited: number
  readonly accepted: number
  readonly replied: number
  readonly pending: number
  readonly preExisting: number
  readonly pipelineAvailable: boolean
  readonly interested: number
  readonly negotiationsCall: number
  readonly callBooked: number
  readonly callDone: number
  readonly proposalPresented: number
  readonly client: number
}

export interface OverviewSummaryRow {
  readonly totals: OverviewTotalsRow
  readonly prevTotals: OverviewTotalsRow | null
  readonly intent: OverviewIntentMetricsRow
  readonly intentPrev: OverviewIntentMetricsRow | null
  readonly accounts: readonly OverviewAccountSummaryRow[]
  readonly campaigns: readonly CampaignMetricsRow[]
  readonly activity: readonly {
    day: string
    instance_id: string
    event_type: string
    cnt: number
  }[]
  readonly velocity: readonly { week: string; added: number }[]
  readonly velocityUndated: number
  readonly funnel: OverviewFunnelRow
}

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
// dashboard.bootstrap
// ---------------------------------------------------------------------------

/**
 * The application shell used to wait for twenty independently authenticated
 * relation walks. This operation deliberately contains only the rows needed to
 * render navigation and route identity: accounts, campaign names and the team
 * roster. It is one actor-scoped statement and never scans leads or messages.
 */
const DASHBOARD_BOOTSTRAP_SQL = `SELECT jsonb_build_object(
          'instances', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', i.id,
              'label', i.label,
              'last_sync_at', i.last_sync_at,
              'agent_version', i.agent_version,
              'account_name', i.account_name,
              'account_url', i.account_url,
              'account_avatar', i.account_avatar,
              'config', i.config,
              'config_updated_at', i.config_updated_at
            ) ORDER BY i.id)
              FROM public.instances i
          ), '[]'::jsonb),
          'campaigns', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'campaign_id', c.id,
              'campaign_name', c.name,
              'instance_id', c.instance_id,
              'status', c.status,
              'total_leads', 0,
              'invites_sent', 0,
              'accepted', 0,
              'replies', 0,
              'acceptance_rate', NULL,
              'reply_rate', NULL,
              'last_activity_at', NULL,
              'briefing_context', c.briefing_context,
              'briefing_context_updated_at', c.briefing_context_updated_at
            ) ORDER BY c.name, c.id)
              FROM public.campaigns c
          ), '[]'::jsonb),
          'teamMembers', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', r.id,
              'name', r.name,
              'active', r.active,
              'created_at', r.created_at,
              'auth_user_id', NULL,
              'email', r.email,
              'role', r.role
            ) ORDER BY r.name, r.id)
              FROM public.team_roster() AS r
          ), '[]'::jsonb)
        ) AS bootstrap`

export const dashboardBootstrapOperation: NeonQueryOperation<DashboardBootstrapRow> = {
  build: () => ({ text: DASHBOARD_BOOTSTRAP_SQL }),
  mapRow: (row: NeonRow): DashboardBootstrapRow =>
    (row.bootstrap ?? { instances: [], campaigns: [], teamMembers: [] }) as DashboardBootstrapRow,
}

// ---------------------------------------------------------------------------
// overview.summary
// ---------------------------------------------------------------------------

/**
 * Exact Overview aggregates in one database round trip. The selected range is
 * the same half-open UTC range produced by `dayRangeToUtcRange`; its previous
 * comparison window is the immediately preceding equal-length interval. An
 * open-ended range has no previous interval.
 *
 * The query intentionally mirrors the browser helpers instead of using the
 * all-time campaign view for range metrics: counts are lead-row counts, the
 * global automated funnel deduplicates by `(instance_id, profile_url)`, and the
 * manual funnel takes the deepest current-or-event stage while treating `lost`
 * as an off-ramp rather than rank seven. Intent chronology comes from the
 * authoritative full-thread projection and booking events/current-stage
 * compatibility path used by `replyIntentMetrics`.
 */
const OVERVIEW_SUMMARY_SQL = `WITH bounds AS (
  SELECT $1::timestamptz AS cur_from,
         $2::timestamptz AS cur_to,
         CASE WHEN $1::timestamptz IS NOT NULL AND $2::timestamptz IS NOT NULL
              THEN $1::timestamptz - ($2::timestamptz - $1::timestamptz)
              ELSE NULL END AS prev_from,
         CASE WHEN $1::timestamptz IS NOT NULL AND $2::timestamptz IS NOT NULL
              THEN $1::timestamptz ELSE NULL END AS prev_to,
         current_timestamp AS as_of,
         date_trunc('week', current_timestamp AT TIME ZONE 'UTC')::date AS current_monday
),
lead_rows AS (
  SELECT l.*,
         COALESCE(l.added_at, LEAST(l.invited_at, l.connected_at, l.first_message_at, l.replied_at))
           AS effective_added_at
    FROM public.leads l
),
lead_stats AS (
  SELECT CASE WHEN GROUPING(l.instance_id) = 1 THEN NULL ELSE l.instance_id END AS scope_id,
         count(*)::int AS leads,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR l.invited_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.invited_at < b.cur_to))::int AS invites,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR l.connected_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.connected_at < b.cur_to))::int AS accepted,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR l.replied_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.replied_at < b.cur_to))::int AS replies,
         count(*) FILTER (WHERE l.invited_at IS NOT NULL
                            AND (b.cur_from IS NULL OR l.connected_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.connected_at < b.cur_to))::int AS accepted_of_invited,
         count(*) FILTER (WHERE l.connected_at IS NOT NULL
                            AND (b.cur_from IS NULL OR l.replied_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.replied_at < b.cur_to))::int AS replied_of_connected,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR l.added_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.added_at < b.cur_to))::int AS added,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL
                            AND l.invited_at >= b.prev_from AND l.invited_at < b.prev_to)::int AS prev_invites,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL
                            AND l.connected_at >= b.prev_from AND l.connected_at < b.prev_to)::int AS prev_accepted,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL
                            AND l.replied_at >= b.prev_from AND l.replied_at < b.prev_to)::int AS prev_replies,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL AND l.invited_at IS NOT NULL
                            AND l.connected_at >= b.prev_from AND l.connected_at < b.prev_to)::int AS prev_accepted_of_invited,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL AND l.connected_at IS NOT NULL
                            AND l.replied_at >= b.prev_from AND l.replied_at < b.prev_to)::int AS prev_replied_of_connected,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL
                            AND l.added_at >= b.prev_from AND l.added_at < b.prev_to)::int AS prev_added,
         count(*) FILTER (WHERE l.effective_added_at >= (b.current_monday::timestamp AT TIME ZONE 'UTC')
                            AND l.effective_added_at < ((b.current_monday + 7)::timestamp AT TIME ZONE 'UTC'))::int
           AS weekly_added
    FROM lead_rows l CROSS JOIN bounds b
   GROUP BY GROUPING SETS ((), (l.instance_id))
),
booking_events AS (
  SELECT l.instance_id, l.profile_url, e.occurred_at AS booked_at
    FROM public.pipeline_events e
    JOIN public.leads l ON l.id = e.lead_id
   WHERE e.kind = 'stage' AND e.to_stage = 'call_booked'
  UNION ALL
  SELECT l.instance_id, l.profile_url, l.pipeline_stage_changed_at AS booked_at
    FROM public.leads l
   WHERE l.pipeline_stage = 'call_booked' AND l.pipeline_stage_changed_at IS NOT NULL
),
bookings AS (
  SELECT instance_id, profile_url, max(booked_at) AS last_booking_at
    FROM booking_events
   GROUP BY instance_id, profile_url
),
intent_rows AS (
  SELECT i.*, bk.last_booking_at
    FROM public.conversation_reply_intent i
    LEFT JOIN bookings bk USING (instance_id, profile_url)
),
intent_stats AS (
  SELECT CASE WHEN GROUPING(i.instance_id) = 1 THEN NULL ELSE i.instance_id END AS scope_id,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR i.first_p1_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR i.first_p1_at < b.cur_to))::int AS p1,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR i.first_p2_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR i.first_p2_at < b.cur_to))::int AS p2,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR i.first_p3_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR i.first_p3_at < b.cur_to))::int AS p3,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR i.first_p3_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR i.first_p3_at < b.cur_to)
                            AND i.last_booking_at > i.first_p3_at)::int AS p3_booked,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR i.first_p3_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR i.first_p3_at < b.cur_to)
                            AND i.first_p3_at <= b.as_of - interval '14 days')::int AS mature_p3,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR i.first_p3_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR i.first_p3_at < b.cur_to)
                            AND i.first_p3_at <= b.as_of - interval '14 days'
                            AND i.last_booking_at > i.first_p3_at)::int AS mature_p3_booked,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR i.first_p3_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR i.first_p3_at < b.cur_to)
                            AND NOT COALESCE(i.last_booking_at > i.first_p3_at, false)
                            AND i.last_out_after_p3_at <= b.as_of - interval '30 days'
                            AND NOT COALESCE(i.last_in_after_p3_at > i.last_out_after_p3_at, false))::int AS p3_ghosted,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL
                            AND i.first_p1_at >= b.prev_from AND i.first_p1_at < b.prev_to)::int AS prev_p1,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL
                            AND i.first_p2_at >= b.prev_from AND i.first_p2_at < b.prev_to)::int AS prev_p2,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL
                            AND i.first_p3_at >= b.prev_from AND i.first_p3_at < b.prev_to)::int AS prev_p3,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL
                            AND i.first_p3_at >= b.prev_from AND i.first_p3_at < b.prev_to
                            AND i.last_booking_at > i.first_p3_at)::int AS prev_p3_booked,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL
                            AND i.first_p3_at >= b.prev_from AND i.first_p3_at < b.prev_to
                            AND i.first_p3_at <= b.as_of - interval '14 days')::int AS prev_mature_p3,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL
                            AND i.first_p3_at >= b.prev_from AND i.first_p3_at < b.prev_to
                            AND i.first_p3_at <= b.as_of - interval '14 days'
                            AND i.last_booking_at > i.first_p3_at)::int AS prev_mature_p3_booked,
         count(*) FILTER (WHERE b.prev_from IS NOT NULL
                            AND i.first_p3_at >= b.prev_from AND i.first_p3_at < b.prev_to
                            AND NOT COALESCE(i.last_booking_at > i.first_p3_at, false)
                            AND i.last_out_after_p3_at <= b.as_of - interval '30 days'
                            AND NOT COALESCE(i.last_in_after_p3_at > i.last_out_after_p3_at, false))::int AS prev_p3_ghosted
    FROM intent_rows i CROSS JOIN bounds b
   GROUP BY GROUPING SETS ((), (i.instance_id))
),
campaign_stats AS (
  SELECT l.campaign_id,
         c.name AS campaign_name,
         l.instance_id,
         c.status,
         count(*)::int AS total_leads,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR l.added_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.added_at < b.cur_to))::int AS leads_added,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR l.invited_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.invited_at < b.cur_to))::int AS invites_sent,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR l.connected_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.connected_at < b.cur_to))::int AS accepted,
         count(*) FILTER (WHERE (b.cur_from IS NULL OR l.replied_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.replied_at < b.cur_to))::int AS replies,
         count(*) FILTER (WHERE l.invited_at IS NOT NULL
                            AND (b.cur_from IS NULL OR l.connected_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.connected_at < b.cur_to))::int AS accepted_of_invited,
         count(*) FILTER (WHERE l.connected_at IS NOT NULL
                            AND (b.cur_from IS NULL OR l.replied_at >= b.cur_from)
                            AND (b.cur_to IS NULL OR l.replied_at < b.cur_to))::int AS replied_of_connected,
         max(GREATEST(l.invited_at, l.connected_at, l.replied_at)) AS last_activity_at,
         c.briefing_context,
         c.briefing_context_updated_at
    FROM public.leads l
    JOIN public.campaigns c ON c.id = l.campaign_id
    CROSS JOIN bounds b
   GROUP BY l.campaign_id, c.name, l.instance_id, c.status,
            c.briefing_context, c.briefing_context_updated_at
),
activity_rows AS (
  SELECT to_char(e.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
         l.instance_id,
         e.event_type,
         count(*)::int AS cnt
    FROM public.leads l
    CROSS JOIN bounds b
    CROSS JOIN LATERAL (VALUES
      (l.invited_at, 'invite_sent'::text),
      (l.connected_at, 'invite_accepted'::text),
      (l.replied_at, 'reply_received'::text)
    ) AS e(ts, event_type)
   WHERE e.ts IS NOT NULL
     AND (b.cur_from IS NULL OR e.ts >= b.cur_from)
     AND (b.cur_to IS NULL OR e.ts < b.cur_to)
   GROUP BY 1, l.instance_id, e.event_type
),
velocity_rows AS (
  SELECT to_char(date_trunc('week', l.added_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week,
         count(*)::int AS added
    FROM public.leads l CROSS JOIN bounds b
   WHERE l.added_at IS NOT NULL
     AND date_trunc('week', l.added_at AT TIME ZONE 'UTC')::date
           BETWEEN b.current_monday - 84 AND b.current_monday
   GROUP BY 1
),
persons AS (
  SELECT l.instance_id, l.profile_url,
         bool_or(l.invited_at IS NOT NULL) AS invited,
         bool_or(l.connected_at IS NOT NULL) AS connected,
         bool_or(l.replied_at IS NOT NULL) AS replied
    FROM public.leads l
   GROUP BY l.instance_id, l.profile_url
),
pipeline_touches AS (
  SELECT l.instance_id, l.profile_url, l.pipeline_stage AS stage
    FROM public.leads l
   WHERE l.pipeline_stage IS NOT NULL
  UNION ALL
  SELECT l.instance_id, l.profile_url, e.to_stage AS stage
    FROM public.pipeline_events e
    JOIN public.leads l ON l.id = e.lead_id
   WHERE e.kind = 'stage' AND e.to_stage IS NOT NULL
),
pipeline_ranked AS (
  SELECT instance_id, profile_url, stage,
         CASE stage
           WHEN 'lost' THEN 0
           WHEN 'first_contact' THEN 0
           WHEN 'interested' THEN 1
           WHEN 'neutral' THEN 1
           WHEN 'negative' THEN 1
           WHEN 'following_up' THEN 1
           WHEN 'negotiations_call' THEN 2
           WHEN 'call_booked' THEN 3
           WHEN 'call_done' THEN 4
           WHEN 'proposal_in_progress' THEN 5
           WHEN 'proposal_presented' THEN 6
           WHEN 'client' THEN 7
           ELSE -1
         END AS rank
    FROM pipeline_touches
),
pipeline_reach AS (
  SELECT instance_id, profile_url, max(rank) AS rank,
         bool_or(stage = 'client') AS is_client
    FROM pipeline_ranked
   WHERE rank >= 0
   GROUP BY instance_id, profile_url
),
funnel AS (
  SELECT jsonb_build_object(
    'leads', count(*)::int,
    'invited', count(*) FILTER (WHERE invited)::int,
    'accepted', count(*) FILTER (WHERE invited AND connected)::int,
    'replied', count(*) FILTER (WHERE invited AND connected AND replied)::int,
    'pending', count(*) FILTER (WHERE invited AND NOT connected)::int,
    'preExisting', count(*) FILTER (WHERE connected AND NOT invited)::int,
    'pipelineAvailable', EXISTS (SELECT 1 FROM pipeline_reach),
    'interested', (SELECT count(*)::int FROM pipeline_reach WHERE rank >= 1),
    'negotiationsCall', (SELECT count(*)::int FROM pipeline_reach WHERE rank >= 2),
    'callBooked', (SELECT count(*)::int FROM pipeline_reach WHERE rank >= 3),
    'callDone', (SELECT count(*)::int FROM pipeline_reach WHERE rank >= 4),
    'proposalPresented', (SELECT count(*)::int FROM pipeline_reach WHERE rank >= 6),
    'client', (SELECT count(*)::int FROM pipeline_reach WHERE is_client)
  ) AS value
    FROM persons
),
account_payload AS (
  SELECT jsonb_agg(jsonb_build_object(
    'instance_id', l.scope_id,
    'totals', jsonb_build_object(
      'leads', l.leads, 'invites', l.invites, 'accepted', l.accepted,
      'replies', l.replies, 'positive', 0,
      'acceptedOfInvited', l.accepted_of_invited,
      'repliedOfConnected', l.replied_of_connected, 'added', l.added
    ),
    'prevTotals', CASE WHEN b.prev_from IS NULL THEN NULL ELSE jsonb_build_object(
      'leads', l.leads, 'invites', l.prev_invites, 'accepted', l.prev_accepted,
      'replies', l.prev_replies, 'positive', 0,
      'acceptedOfInvited', l.prev_accepted_of_invited,
      'repliedOfConnected', l.prev_replied_of_connected, 'added', l.prev_added
    ) END,
    'intent', jsonb_build_object(
      'p1', COALESCE(i.p1, 0), 'p2', COALESCE(i.p2, 0), 'p3', COALESCE(i.p3, 0),
      'p3Booked', COALESCE(i.p3_booked, 0), 'matureP3', COALESCE(i.mature_p3, 0),
      'matureP3Booked', COALESCE(i.mature_p3_booked, 0), 'p3Ghosted', COALESCE(i.p3_ghosted, 0)
    ),
    'intentPrev', CASE WHEN b.prev_from IS NULL THEN NULL ELSE jsonb_build_object(
      'p1', COALESCE(i.prev_p1, 0), 'p2', COALESCE(i.prev_p2, 0), 'p3', COALESCE(i.prev_p3, 0),
      'p3Booked', COALESCE(i.prev_p3_booked, 0), 'matureP3', COALESCE(i.prev_mature_p3, 0),
      'matureP3Booked', COALESCE(i.prev_mature_p3_booked, 0),
      'p3Ghosted', COALESCE(i.prev_p3_ghosted, 0)
    ) END,
    'weeklyAdded', l.weekly_added
  ) ORDER BY l.scope_id) AS value
    FROM lead_stats l
    LEFT JOIN intent_stats i ON i.scope_id = l.scope_id
    CROSS JOIN bounds b
   WHERE l.scope_id IS NOT NULL
),
global_payload AS (
  SELECT jsonb_build_object(
    'totals', jsonb_build_object(
      'leads', l.leads, 'invites', l.invites, 'accepted', l.accepted,
      'replies', l.replies, 'positive', 0,
      'acceptedOfInvited', l.accepted_of_invited,
      'repliedOfConnected', l.replied_of_connected, 'added', l.added
    ),
    'prevTotals', CASE WHEN b.prev_from IS NULL THEN NULL ELSE jsonb_build_object(
      'leads', l.leads, 'invites', l.prev_invites, 'accepted', l.prev_accepted,
      'replies', l.prev_replies, 'positive', 0,
      'acceptedOfInvited', l.prev_accepted_of_invited,
      'repliedOfConnected', l.prev_replied_of_connected, 'added', l.prev_added
    ) END,
    'intent', jsonb_build_object(
      'p1', COALESCE(i.p1, 0), 'p2', COALESCE(i.p2, 0), 'p3', COALESCE(i.p3, 0),
      'p3Booked', COALESCE(i.p3_booked, 0), 'matureP3', COALESCE(i.mature_p3, 0),
      'matureP3Booked', COALESCE(i.mature_p3_booked, 0), 'p3Ghosted', COALESCE(i.p3_ghosted, 0)
    ),
    'intentPrev', CASE WHEN b.prev_from IS NULL THEN NULL ELSE jsonb_build_object(
      'p1', COALESCE(i.prev_p1, 0), 'p2', COALESCE(i.prev_p2, 0), 'p3', COALESCE(i.prev_p3, 0),
      'p3Booked', COALESCE(i.prev_p3_booked, 0), 'matureP3', COALESCE(i.prev_mature_p3, 0),
      'matureP3Booked', COALESCE(i.prev_mature_p3_booked, 0),
      'p3Ghosted', COALESCE(i.prev_p3_ghosted, 0)
    ) END
  ) AS value
    FROM lead_stats l
    LEFT JOIN intent_stats i ON i.scope_id IS NULL
    CROSS JOIN bounds b
   WHERE l.scope_id IS NULL
)
SELECT (g.value || jsonb_build_object(
  'accounts', COALESCE(a.value, '[]'::jsonb),
  'campaigns', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'campaign_id', c.campaign_id,
    'campaign_name', c.campaign_name,
    'instance_id', c.instance_id,
    'status', c.status,
    'total_leads', c.total_leads,
    'leads_added', c.leads_added,
    'invites_sent', c.invites_sent,
    'accepted', c.accepted,
    'replies', c.replies,
    'acceptance_rate', CASE WHEN c.invites_sent > 0
      THEN (100.0 * c.accepted_of_invited / c.invites_sent) ELSE NULL END,
    'reply_rate', CASE WHEN c.accepted > 0
      THEN (100.0 * c.replied_of_connected / c.accepted) ELSE NULL END,
    'last_activity_at', c.last_activity_at,
    'briefing_context', c.briefing_context,
    'briefing_context_updated_at', c.briefing_context_updated_at
  ) ORDER BY c.invites_sent DESC, c.campaign_name), '[]'::jsonb),
  'activity', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.day, x.instance_id, x.event_type)
                           FROM activity_rows x), '[]'::jsonb),
  'velocity', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.week)
                           FROM velocity_rows v), '[]'::jsonb),
  'velocityUndated', (SELECT count(*)::int FROM public.leads WHERE added_at IS NULL),
  'funnel', f.value
)) AS summary
  FROM global_payload g
  CROSS JOIN account_payload a
  CROSS JOIN funnel f`

export const overviewSummaryOperation: NeonQueryOperation<OverviewSummaryRow> = {
  build: ({ range }) => ({
    text: OVERVIEW_SUMMARY_SQL,
    values: [range?.fromInclusive ?? null, range?.toExclusive ?? null],
  }),
  mapRow: (row: NeonRow): OverviewSummaryRow => row.summary as OverviewSummaryRow,
}

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
