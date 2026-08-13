/**
 * Route-owned dashboard projections.
 *
 * The SPA bootstrap contains navigation metadata only. A page that needs more
 * asks for exactly one of these fixed projections, so one actor resolution and
 * one statement replace the historical twenty-operation tenant snapshot.
 * Route names choose server-owned SQL; callers never submit SQL or columns.
 */
import type { NeonQueryOperation, NeonRow, NeonStatement } from '../neon.js'

export const ROUTE_SNAPSHOT_OPERATION = 'dashboard.routeSnapshot'

export const ROUTE_SNAPSHOT_ROUTES = [
  'account',
  'campaign',
  'pipeline',
  'follow-ups',
  'review',
  'health',
  'searches',
  'icp',
  'hypotheses',
] as const

export type RouteSnapshotRoute = (typeof ROUTE_SNAPSHOT_ROUTES)[number]

export interface RouteSnapshotParams {
  readonly route: RouteSnapshotRoute
  readonly routeId: string | null
  readonly compareIds: string | null
  readonly [key: string]: string | null
}

export interface RouteSnapshotRow {
  readonly campaigns?: readonly unknown[]
  readonly leads?: readonly unknown[]
  readonly messages?: readonly unknown[]
  readonly pipelineEvents?: readonly unknown[]
  readonly conversationReplyIntents?: readonly unknown[]
  readonly annotations?: readonly unknown[]
  readonly steps?: readonly unknown[]
  readonly syncRuns?: readonly unknown[]
  readonly followUpStates?: readonly unknown[]
  readonly latestConversationMessages?: readonly unknown[]
  readonly followUpsAvailable?: boolean
  readonly savedSearches?: readonly unknown[]
  readonly icps?: readonly unknown[]
  readonly icpPersonas?: readonly unknown[]
  readonly icpIndustries?: readonly unknown[]
  readonly hypotheses?: readonly unknown[]
  readonly hypothesisCampaigns?: readonly unknown[]
}

const EMPTY_ARRAY = `'[]'::jsonb`

const ACCOUNT_SQL = `WITH scoped_messages AS MATERIALIZED (
  SELECT m.*,
         row_number() OVER (
           PARTITION BY m.instance_id, m.profile_url
           ORDER BY m.sent_at DESC, m.id DESC
         ) AS latest_rank
    FROM public.messages m
   WHERE m.instance_id = $1 AND m.direction = 'in'
)
SELECT jsonb_build_object(
  'campaigns', COALESCE((
    SELECT jsonb_agg(to_jsonb(c) ORDER BY c.campaign_name, c.campaign_id)
      FROM public.campaign_metrics c WHERE c.instance_id = $1
  ), ${EMPTY_ARRAY}),
  'leads', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', l.id,
      'instance_id', l.instance_id,
      'campaign_id', l.campaign_id,
      'profile_url', l.profile_url,
      'added_at', l.added_at,
      'invited_at', l.invited_at,
      'connected_at', l.connected_at,
      'first_message_at', l.first_message_at,
      'replied_at', l.replied_at,
      'last_action_at', l.last_action_at,
      'pipeline_stage', l.pipeline_stage,
      'pipeline_stage_changed_at', l.pipeline_stage_changed_at
    ) ORDER BY l.id)
      FROM public.leads l
     WHERE l.instance_id = $1
  ), ${EMPTY_ARRAY}),
  'messages', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', m.id,
      'instance_id', m.instance_id,
      'campaign_id', m.campaign_id,
      'profile_url', m.profile_url,
      'direction', m.direction,
      'body', CASE WHEN m.latest_rank = 1 THEN m.body ELSE NULL END,
      'sent_at', m.sent_at,
      'sentiment', m.sentiment,
      'reason', CASE WHEN m.latest_rank = 1 THEN m.reason ELSE NULL END,
      'classified_at', m.classified_at,
      'intent_level', m.intent_level,
      'intent_reason', CASE WHEN m.latest_rank = 1 THEN m.intent_reason ELSE NULL END
    ) ORDER BY m.sent_at DESC, m.id DESC)
      FROM scoped_messages m
     WHERE m.latest_rank = 1 OR m.intent_level IS NOT NULL
  ), ${EMPTY_ARRAY}),
  'pipelineEvents', COALESCE((
    SELECT jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at, e.id)
      FROM public.pipeline_events e
      JOIN public.leads l ON l.id = e.lead_id
     WHERE l.instance_id = $1
  ), ${EMPTY_ARRAY}),
  'conversationReplyIntents', COALESCE((
    SELECT jsonb_agg(to_jsonb(i) ORDER BY i.instance_id, i.profile_url)
      FROM public.conversation_reply_intent i
     WHERE i.instance_id = $1
  ), ${EMPTY_ARRAY})
) AS payload`

const CAMPAIGN_SQL = `WITH scoped_leads AS MATERIALIZED (
  SELECT * FROM public.leads
   WHERE campaign_id = $1
      OR campaign_id = ANY(string_to_array(COALESCE($2, ''), ','))
), scoped_threads AS MATERIALIZED (
  SELECT DISTINCT instance_id, profile_url FROM scoped_leads
), scoped_messages AS MATERIALIZED (
  SELECT m.*,
         row_number() OVER (
           PARTITION BY m.instance_id, m.profile_url
           ORDER BY m.sent_at DESC, m.id DESC
         ) AS latest_rank
    FROM public.messages m
    JOIN scoped_threads t USING (instance_id, profile_url)
   WHERE m.direction = 'in'
)
SELECT jsonb_build_object(
  'campaigns', COALESCE((
    SELECT jsonb_agg(to_jsonb(c) ORDER BY c.campaign_name, c.campaign_id)
      FROM public.campaign_metrics c
  ), ${EMPTY_ARRAY}),
  'leads', COALESCE((
    SELECT jsonb_agg(to_jsonb(l) - 'updated_at' ORDER BY l.id) FROM scoped_leads l
  ), ${EMPTY_ARRAY}),
  'messages', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', m.id,
      'instance_id', m.instance_id,
      'campaign_id', m.campaign_id,
      'profile_url', m.profile_url,
      'direction', m.direction,
      'body', CASE WHEN m.latest_rank = 1 THEN m.body ELSE NULL END,
      'sent_at', m.sent_at,
      'sentiment', m.sentiment,
      'reason', CASE WHEN m.latest_rank = 1 THEN m.reason ELSE NULL END,
      'classified_at', m.classified_at,
      'intent_level', m.intent_level,
      'intent_reason', CASE WHEN m.latest_rank = 1 THEN m.intent_reason ELSE NULL END
    ) ORDER BY m.sent_at DESC, m.id DESC)
      FROM scoped_messages m
     WHERE m.latest_rank = 1 OR m.intent_level IS NOT NULL
  ), ${EMPTY_ARRAY}),
  'pipelineEvents', COALESCE((
    SELECT jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at, e.id)
      FROM public.pipeline_events e
      JOIN scoped_leads l ON l.id = e.lead_id
  ), ${EMPTY_ARRAY}),
  'conversationReplyIntents', COALESCE((
    SELECT jsonb_agg(to_jsonb(i) ORDER BY i.instance_id, i.profile_url)
      FROM public.conversation_reply_intent i
      JOIN scoped_threads t USING (instance_id, profile_url)
  ), ${EMPTY_ARRAY}),
  'annotations', COALESCE((
    SELECT jsonb_agg(to_jsonb(a) ORDER BY a.noted_at, a.id)
      FROM public.annotations a WHERE a.campaign_id = $1
  ), ${EMPTY_ARRAY}),
  'steps', COALESCE((
    SELECT jsonb_agg(to_jsonb(s) ORDER BY s.step_index)
      FROM public.campaign_steps s WHERE s.campaign_id = $1
  ), ${EMPTY_ARRAY})
) AS payload`

const PIPELINE_SQL = `WITH scoped_leads AS MATERIALIZED (
  SELECT * FROM public.leads
   WHERE replied_at IS NOT NULL OR pipeline_stage IS NOT NULL
), scoped_threads AS MATERIALIZED (
  SELECT DISTINCT instance_id, profile_url FROM scoped_leads
)
SELECT jsonb_build_object(
  'leads', COALESCE((
    SELECT jsonb_agg(to_jsonb(l) - 'updated_at' ORDER BY l.id) FROM scoped_leads l
  ), ${EMPTY_ARRAY}),
  'followUpStates', COALESCE((
    SELECT jsonb_agg(to_jsonb(s) ORDER BY s.instance_id, s.profile_url)
      FROM public.conversation_follow_up_state s
      JOIN scoped_threads t USING (instance_id, profile_url)
  ), ${EMPTY_ARRAY}),
  'latestConversationMessages', COALESCE((
    SELECT jsonb_agg(to_jsonb(m) ORDER BY m.instance_id, m.profile_url)
      FROM public.conversation_latest_message m
      JOIN scoped_threads t USING (instance_id, profile_url)
  ), ${EMPTY_ARRAY}),
  'followUpsAvailable', true
) AS payload`

const FOLLOW_UPS_SQL = `WITH scoped_states AS MATERIALIZED (
  SELECT * FROM public.conversation_follow_up_state
   WHERE next_follow_up_date IS NOT NULL AND archived_at IS NULL
), scoped_threads AS MATERIALIZED (
  SELECT instance_id, profile_url FROM scoped_states
), scoped_leads AS MATERIALIZED (
  SELECT l.* FROM public.leads l
  JOIN scoped_threads t USING (instance_id, profile_url)
)
SELECT jsonb_build_object(
  'leads', COALESCE((
    SELECT jsonb_agg(to_jsonb(l) - 'updated_at' ORDER BY l.id) FROM scoped_leads l
  ), ${EMPTY_ARRAY}),
  'followUpStates', COALESCE((
    SELECT jsonb_agg(to_jsonb(s) ORDER BY s.next_follow_up_date, s.instance_id, s.profile_url)
      FROM scoped_states s
  ), ${EMPTY_ARRAY}),
  'latestConversationMessages', COALESCE((
    SELECT jsonb_agg(to_jsonb(m) ORDER BY m.instance_id, m.profile_url)
      FROM public.conversation_latest_message m
      JOIN scoped_threads t USING (instance_id, profile_url)
  ), ${EMPTY_ARRAY}),
  'followUpsAvailable', true
) AS payload`

/**
 * Review keeps all lead milestone rows because the Leads Added tab supports an
 * all-time range, but projects only fields the review helpers read. Messages are
 * bounded to the largest selectable review window (16 weeks). Durable intent
 * chronology remains exact through conversation_reply_intent.
 */
const REVIEW_SQL = `SELECT jsonb_build_object(
  'campaigns', COALESCE((
    SELECT jsonb_agg(to_jsonb(c) ORDER BY c.campaign_name, c.campaign_id)
      FROM public.campaign_metrics c
  ), ${EMPTY_ARRAY}),
  'leads', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', l.id,
      'instance_id', l.instance_id,
      'campaign_id', l.campaign_id,
      'profile_url', l.profile_url,
      'added_at', l.added_at,
      'invited_at', l.invited_at,
      'connected_at', l.connected_at,
      'first_message_at', l.first_message_at,
      'replied_at', l.replied_at,
      'pipeline_stage', l.pipeline_stage,
      'pipeline_stage_changed_at', l.pipeline_stage_changed_at
    ) ORDER BY l.id) FROM public.leads l
  ), ${EMPTY_ARRAY}),
  'messages', COALESCE((
    SELECT jsonb_agg(to_jsonb(m) - 'content_hash' - 'updated_at' ORDER BY m.sent_at DESC, m.id DESC)
      FROM public.messages m
     WHERE m.direction = 'in'
       AND m.sent_at >= date_trunc('week', current_timestamp AT TIME ZONE 'UTC') - interval '15 weeks'
  ), ${EMPTY_ARRAY}),
  'pipelineEvents', COALESCE((
    SELECT jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at, e.id)
      FROM public.pipeline_events e
  ), ${EMPTY_ARRAY}),
  'conversationReplyIntents', COALESCE((
    SELECT jsonb_agg(to_jsonb(i) ORDER BY i.instance_id, i.profile_url)
      FROM public.conversation_reply_intent i
  ), ${EMPTY_ARRAY}),
  'steps', COALESCE((
    SELECT jsonb_agg(to_jsonb(s) ORDER BY s.campaign_id, s.step_index)
      FROM public.campaign_steps s
  ), ${EMPTY_ARRAY})
) AS payload`

const HEALTH_SQL = `SELECT jsonb_build_object(
  'syncRuns', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', r.id::text,
      'instance_id', r.instance_id,
      'started_at', r.started_at,
      'finished_at', r.finished_at,
      'status', r.status,
      'rows_upserted', r.rows_upserted,
      'error', r.error
    ) ORDER BY r.started_at DESC, r.id DESC)
      FROM (SELECT * FROM public.sync_runs ORDER BY started_at DESC, id DESC LIMIT 200) r
  ), ${EMPTY_ARRAY})
) AS payload`

const SEARCHES_SQL = `SELECT jsonb_build_object(
  'savedSearches', COALESCE((
    SELECT jsonb_agg(to_jsonb(s) ORDER BY s.name, s.id) FROM public.saved_searches s
  ), ${EMPTY_ARRAY})
) AS payload`

const ICP_SQL = `SELECT jsonb_build_object(
  'icps', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.name, i.id) FROM public.icps i), ${EMPTY_ARRAY}),
  'icpPersonas', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.icp_id, p.sort, p.id) FROM public.icp_personas p), ${EMPTY_ARRAY}),
  'icpIndustries', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.icp_id, i.name, i.id) FROM public.icp_industries i), ${EMPTY_ARRAY}),
  'hypotheses', COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.name, h.id) FROM public.hypotheses h), ${EMPTY_ARRAY})
) AS payload`

/** A compact all-time milestone projection is enough for hypothesis funnel math. */
const HYPOTHESES_SQL = `WITH highest_intent AS (
  SELECT m.instance_id,
         m.profile_url,
         CASE max(CASE m.intent_level WHEN 'p3' THEN 3 WHEN 'p2' THEN 2 WHEN 'p1' THEN 1 END)
           WHEN 3 THEN 'p3' WHEN 2 THEN 'p2' WHEN 1 THEN 'p1' ELSE NULL END AS intent_level,
         max(m.sent_at) AS sent_at
    FROM public.messages m
   WHERE m.direction = 'in'
   GROUP BY m.instance_id, m.profile_url
), numbered_intent AS (
  SELECT row_number() OVER (ORDER BY i.instance_id, i.profile_url) AS id, i.*
    FROM highest_intent i
)
SELECT jsonb_build_object(
  'campaigns', COALESCE((
    SELECT jsonb_agg(to_jsonb(c) ORDER BY c.campaign_name, c.campaign_id)
      FROM public.campaign_metrics c
  ), ${EMPTY_ARRAY}),
  'hypotheses', COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.name, h.id) FROM public.hypotheses h), ${EMPTY_ARRAY}),
  'hypothesisCampaigns', COALESCE((SELECT jsonb_agg(to_jsonb(hc) ORDER BY hc.hypothesis_id, hc.campaign_id) FROM public.hypothesis_campaigns hc), ${EMPTY_ARRAY}),
  'icps', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.name, i.id) FROM public.icps i), ${EMPTY_ARRAY}),
  'savedSearches', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.name, s.id) FROM public.saved_searches s), ${EMPTY_ARRAY}),
  'leads', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', l.id,
      'instance_id', l.instance_id,
      'campaign_id', l.campaign_id,
      'profile_url', l.profile_url,
      'added_at', l.added_at,
      'invited_at', l.invited_at,
      'connected_at', l.connected_at,
      'first_message_at', l.first_message_at,
      'replied_at', l.replied_at,
      'last_action_at', l.last_action_at
    ) ORDER BY l.id) FROM public.leads l
  ), ${EMPTY_ARRAY}),
  'messages', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', i.id,
      'instance_id', i.instance_id,
      'campaign_id', NULL,
      'profile_url', i.profile_url,
      'direction', 'in',
      'body', NULL,
      'sent_at', i.sent_at,
      'sentiment', NULL,
      'reason', NULL,
      'classified_at', NULL,
      'intent_level', i.intent_level
    ) ORDER BY i.instance_id, i.profile_url) FROM numbered_intent i
  ), ${EMPTY_ARRAY})
) AS payload`

const SQL_BY_ROUTE: Readonly<Record<RouteSnapshotRoute, string>> = {
  account: ACCOUNT_SQL,
  campaign: CAMPAIGN_SQL,
  pipeline: PIPELINE_SQL,
  'follow-ups': FOLLOW_UPS_SQL,
  review: REVIEW_SQL,
  health: HEALTH_SQL,
  searches: SEARCHES_SQL,
  icp: ICP_SQL,
  hypotheses: HYPOTHESES_SQL,
}

export const routeSnapshotOperation: NeonQueryOperation<
  RouteSnapshotRow,
  RouteSnapshotParams
> = {
  build: ({ params }): NeonStatement => {
    const route = params?.route
    if (!route || !(route in SQL_BY_ROUTE)) {
      throw new Error('route snapshot requires an allowlisted route')
    }
    const needsId = route === 'account' || route === 'campaign'
    return {
      text: SQL_BY_ROUTE[route],
      values: route === 'campaign'
        ? [params?.routeId ?? null, params?.compareIds ?? '']
        : needsId ? [params?.routeId ?? null] : [],
    }
  },
  mapRow: (row: NeonRow): RouteSnapshotRow =>
    (row.payload ?? {}) as RouteSnapshotRow,
}
