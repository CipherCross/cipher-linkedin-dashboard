/** Neon read operations for the manual reply-review surface.
 *
 * The operation builders own both the SQL and the filter semantics.  The same
 * filter fragment is used by the inbox and aggregate query; values are always
 * bound parameters, including search text and metric drill-down values.
 */

import type { NeonQueryOperation, NeonRow, NeonStatement } from '../neon.js'
import {
  REPLY_ACTIONS,
  REPLY_REASON_IDS,
  REPLY_SENTIMENTS,
  type ReplyAction,
  type ReplyAnalyticsResponse,
  type ReplyCapability,
  type ReplyFilter,
  type ReplyInboxItem,
  type ReplyReviewDto,
  type ReplyReviewHistoryItem,
  type ReplyFacets,
  type ReplySentiment,
  type ReplyThreadMessage,
} from '../../replyReview.js'

export const REPLY_REVIEW_OPERATIONS = {
  capabilities: 'replies.capabilities',
  inbox: 'replies.inbox',
  facets: 'replies.facets',
  thread: 'replies.thread',
  analytics: 'replies.analytics',
  reviewHistory: 'replies.reviewHistory',
  mutation: 'replies.mutation',
  reviewForMessage: 'replies.reviewForMessage',
  workflowForThread: 'replies.workflowForThread',
  messageForReview: 'replies.messageForReview',
  inboundRevision: 'replies.inboundRevision',
  threadExists: 'replies.threadExists',
} as const

type ReplyParams = { readonly [key: string]: string | number | boolean | null | readonly (string | number | boolean | null)[] }

export interface ReplyCapabilitiesParams extends ReplyParams { readonly probe: boolean | null }
export interface ReplyInboxParams extends ReplyParams {
  readonly scope: 'new' | 'historical' | 'all'
  readonly captureStartedAt: string | null
  readonly instanceId: string | null
  readonly campaignId: string | null
  readonly ownerId: number | null
  readonly sentiment: ReplySentiment | null
  readonly reasonId: string | null
  readonly action: ReplyAction | null
  readonly query: string | null
  readonly view: 'all' | 'unreviewed' | 'needs_reply' | 'deferred' | 'completed'
  readonly unacknowledged: boolean
  readonly unowned: boolean
  readonly overdue: boolean
  readonly my: boolean
  readonly currentActorId: string | null
  readonly from: string | null
  readonly to: string | null
  readonly metricScope: string | null
}
export type ReplyFacetsParams = ReplyInboxParams
export interface ReplyThreadParams extends ReplyParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly focusMessageId: number | null
  readonly direction: 'around' | 'older' | 'newer' | null
}
export interface ReplyHistoryParams extends ReplyThreadParams {
  readonly messageId: number | null
}
export interface ReplyAnalyticsParams extends ReplyParams {
  readonly from: string
  readonly to: string
  readonly instanceId: string | null
  readonly campaignId: string | null
  readonly ownerId: number | null
  readonly metricBase: 'dialogues' | 'messages' | 'manual_dialogues' | 'manual_messages' | null
}
export interface ReplyMutationParams extends ReplyParams { readonly mutationId: string }

const nullableText = (value: unknown): string | null => value === null || value === undefined ? null : String(value)
const nullableNumber = (value: unknown): number | null => value === null || value === undefined ? null : Number(value)
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []

function reviewFromJson(value: unknown, fallbackMessageId?: number): ReplyReviewDto | null {
  if (!value || typeof value !== 'object') return null
  const row = object(value)
  const sentiment = row.sentiment
  const intentState = String(row.intent_state ?? 'unreviewed') as ReplyReviewDto['intent_state']
  const reasonIds = array(row.reason_ids).map(String) as ReplyReviewDto['reason_ids']
  return {
    message_id: Number(row.message_id ?? fallbackMessageId ?? 0),
    sentiment: sentiment === null || sentiment === undefined ? null : String(sentiment) as ReplyReviewDto['sentiment'],
    intent_state: intentState,
    intent_level: row.intent_level === null || row.intent_level === undefined ? null : String(row.intent_level) as ReplyReviewDto['intent_level'],
    reason_ids: reasonIds,
    comment: nullableText(row.comment),
    taxonomy_version: String(row.taxonomy_version ?? 'reply-review-v1'),
    reviewed_by: nullableText(row.reviewed_by),
    provenance: ['human', 'legacy_manual', 'system', 'machine'].includes(String(row.provenance))
      ? String(row.provenance) as ReplyReviewDto['provenance']
      : 'human',
    reviewed_at: nullableText(row.reviewed_at),
    revision: Number(row.revision ?? 0),
    complete: row.complete === true,
  }
}

function mapCapability(row: NeonRow): ReplyCapability {
  const mode = row.mode === 'manual' || row.mode === 'prepared' ? row.mode : null
  const available = row.schema_version !== null && row.schema_version !== undefined
  const active = mode === 'manual'
  return {
    available,
    active,
    manual_ready: active,
    mode,
    schema_version: nullableText(row.schema_version),
    capture_started_at: nullableText(row.capture_started_at),
    activated_at: nullableText(row.activated_at),
    activation_in_progress: row.activation_in_progress === true,
    activation_cursor: Number(row.activation_cursor ?? 0),
    activation_processed: Number(row.activation_processed ?? 0),
    activation_total: Number(row.activation_total ?? 0),
    activation_cutoff: nullableNumber(row.activation_cutoff),
    activation_batch_size: nullableNumber(row.activation_batch_size),
    activation_mutation_id: nullableText(row.activation_mutation_id),
    ...(available && active ? {} : { reason: available ? 'not_activated' as const : 'schema_unavailable' as const }),
  }
}

/** Singleton read. A missing relation is intentionally surfaced as schema unavailable by Neon. */
export const capabilitiesOperation: NeonQueryOperation<ReplyCapability, ReplyCapabilitiesParams> = {
  build: (): NeonStatement => ({
    text: `SELECT schema_version, mode, capture_started_at, activated_at,
                  activation_in_progress, activation_cursor, activation_processed,
                  activation_total, activation_cutoff, activation_batch_size,
                  activation_mutation_id
             FROM public.reply_review_settings
            WHERE id = true`,
    values: [],
  }),
  mapRow: mapCapability,
}

/**
 * Fixed parameter positions shared by inbox and analytics.  `campaign_id` is
 * message attribution, never a lead join, so one profile in several campaigns
 * cannot multiply a thread.  Search escapes SQL wildcards in the expression and
 * remains a literal case-insensitive substring search.
 */
export function replyFilterBuilder(alias?: string, start?: number): { readonly sql: string; readonly values: readonly unknown[] }
export function replyFilterBuilder(filter?: ReplyFilter, alias?: string, start?: number): { readonly sql: string; readonly values: readonly unknown[] }
export function replyFilterBuilder(aliasOrFilter: string | ReplyFilter = 'i', startOrAlias: number | string = 1, maybeStart = 1): { readonly sql: string; readonly values: readonly unknown[] } {
  const alias = typeof aliasOrFilter === 'string' ? aliasOrFilter : typeof startOrAlias === 'string' ? startOrAlias : 'i'
  const start = typeof aliasOrFilter === 'string' && typeof startOrAlias === 'number' ? startOrAlias : maybeStart
  const filter = typeof aliasOrFilter === 'string' ? {} : aliasOrFilter
  const p = (offset: number) => `$${start + offset}`
  return {
    sql: `(${p(0)}::text IS NULL OR ${alias}.instance_id = ${p(0)}::text)
      AND (${p(1)}::text IS NULL OR ${alias}.campaign_id = ${p(1)}::text)
      AND (${p(2)}::bigint IS NULL OR wf.owner_id = ${p(2)}::bigint)
      AND (${p(3)}::text IS NULL OR
           (${p(3)}::text = 'missing_reason' AND EXISTS (
              SELECT 1 FROM public.reply_reviews sf
               WHERE sf.message_id = ${alias}.id
                 AND sf.sentiment IN ('negative','objection')
                 AND sf.provenance IN ('human','legacy_manual')
                 AND sf.sentiment_provenance IN ('human','legacy_manual')
                 AND NOT EXISTS (SELECT 1 FROM public.reply_review_reasons rm WHERE rm.message_id = sf.message_id)))
           OR (${p(3)}::text <> 'missing_reason' AND EXISTS (
              SELECT 1 FROM public.reply_review_reasons rf
               WHERE rf.message_id = ${alias}.id AND rf.reason_id = ${p(3)}::text)))
      AND (${p(4)}::text IS NULL OR EXISTS (SELECT 1 FROM public.reply_reviews sf WHERE sf.message_id = ${alias}.id AND sf.sentiment = ${p(4)}::text))
      AND (${p(5)}::text IS NULL OR EXISTS (SELECT 1 FROM public.conversation_follow_up_state sw WHERE sw.instance_id = ${alias}.instance_id AND sw.profile_url = ${alias}.profile_url AND sw.action = ${p(5)}::text))
      AND (${p(6)}::text IS NULL OR EXISTS (
            SELECT 1 FROM public.leads ls
             WHERE ls.instance_id = ${alias}.instance_id AND ls.profile_url = ${alias}.profile_url
               AND (lower(coalesce(ls.full_name, '')) LIKE '%' || lower(replace(replace(replace(${p(6)}::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_')) || '%' ESCAPE '\\'
                 OR lower(coalesce(ls.company, '')) LIKE '%' || lower(replace(replace(replace(${p(6)}::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_')) || '%' ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM public.messages sm WHERE sm.instance_id = ${alias}.instance_id AND sm.profile_url = ${alias}.profile_url AND lower(coalesce(sm.body, '')) LIKE '%' || lower(replace(replace(replace(${p(6)}::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_')) || '%' ESCAPE '\\'))))
      AND (${p(7)}::timestamptz IS NULL OR ${alias}.sent_at >= ${p(7)}::timestamptz)
      AND (${p(8)}::timestamptz IS NULL OR ${alias}.sent_at < ${p(8)}::timestamptz)`,
    values: replyFilterValues(filter),
  }
}

export function replyFilterValues(filter: ReplyFilter): readonly unknown[] {
  return [
    filter.instance_id ?? null,
    filter.campaign_id ?? null,
    filter.owner_id ?? null,
    filter.reason_id ?? null,
    filter.sentiment ?? null,
    filter.action ?? null,
    filter.query && filter.query.length > 0 ? filter.query.slice(0, 200) : null,
    filter.from ?? null,
    filter.to ?? null,
  ]
}

function mapInbox(row: NeonRow): ReplyInboxItem {
  return {
    instance_id: String(row.instance_id), profile_url: String(row.profile_url),
    name: nullableText(row.name), company: nullableText(row.company), headline: nullableText(row.headline), campaign_id: nullableText(row.campaign_id),
    latest_snippet: nullableText(row.latest_snippet),
    latest_direction: row.latest_direction === 'in' || row.latest_direction === 'out' ? row.latest_direction : null,
    latest_sent_at: nullableText(row.latest_sent_at), selected_message_id: nullableNumber(row.selected_message_id),
    pending_count: Number(row.pending_count ?? 0), owner_id: nullableNumber(row.owner_id),
    action: row.action === null || row.action === undefined ? null : String(row.action) as ReplyAction,
    next_follow_up_date: nullableText(row.next_follow_up_date), do_not_contact: row.do_not_contact === true,
    revision: Number(row.revision ?? 0), review_revision: Number(row.review_revision ?? 0), workflow_revision: Number(row.workflow_revision ?? row.revision ?? 0), inbound_revision: Number(row.inbound_revision ?? 0),
    acknowledged_inbound_revision: Number(row.acknowledged_inbound_revision ?? 0),
    campaign_ids: array(row.campaign_ids).map(String),
    first_seen_at: nullableText(row.first_seen_at),
  }
}

function mapFacets(row: NeonRow): ReplyFacets {
  const result = object(row.result)
  const entries = (value: unknown): Array<{ id?: string | null; value?: string | null; count: number }> => array(value).map((item) => {
    const entry = object(item)
    return { id: entry.id === null || entry.id === undefined ? null : String(entry.id), value: entry.value === null || entry.value === undefined ? null : String(entry.value), count: Number(entry.count ?? 0) }
  })
  return {
    accounts: entries(result.accounts).map((entry) => ({ id: String(entry.id ?? ''), count: entry.count })),
    campaigns: entries(result.campaigns).map((entry) => ({ id: entry.id === '__none__' ? null : entry.id ?? null, count: entry.count })),
    owners: entries(result.owners).map((entry) => ({ id: entry.id === null ? null : Number(entry.id), count: entry.count })),
    actions: entries(result.actions).map((entry) => ({ value: entry.value as ReplyFacets['actions'][number]['value'], count: entry.count })),
    sentiments: entries(result.sentiments).map((entry) => ({ value: entry.value as ReplyFacets['sentiments'][number]['value'], count: entry.count })),
    reasons: entries(result.reasons).map((entry) => ({ value: entry.value as ReplyFacets['reasons'][number]['value'], count: entry.count })),
  }
}

const INBOX_FILTER = replyFilterBuilder('i', 1).sql
const metricSentiment = (kind: string | undefined, value: string): ReplySentiment | null =>
  kind === 'sentiment' && (REPLY_SENTIMENTS as readonly string[]).includes(value) ? value as ReplySentiment : null
const metricReason = (kind: string | undefined, value: string): string | null =>
  kind === 'reason' && (value === 'missing_reason' || (REPLY_REASON_IDS as readonly string[]).includes(value)) ? value : null
const metricAction = (kind: string | undefined, value: string): ReplyAction | null =>
  kind === 'workflow' && (REPLY_ACTIONS as readonly string[]).includes(value) ? value as ReplyAction : null

export const inboxOperation: NeonQueryOperation<ReplyInboxItem, ReplyInboxParams> = {
  keyset: { columns: ['sort_at', 'instance_id', 'profile_url'] },
  build: ({ params, after }) => {
    const p = params
    const metricParts = p?.metricScope?.split(':') ?? []
    const metricKind = metricParts[0]
    const metricValue = metricParts.slice(1).join(':')
    const f = replyFilterValues({
      instance_id: p?.instanceId, campaign_id: p?.campaignId, owner_id: p?.ownerId,
      sentiment: p?.sentiment ?? metricSentiment(metricKind, metricValue),
      reason_id: (p?.reasonId as ReplyFilter['reason_id']) ?? metricReason(metricKind, metricValue) as ReplyFilter['reason_id'],
      action: p?.action ?? metricAction(metricKind, metricValue),
      query: p?.query, from: p?.from, to: p?.to,
    })
    return {
      text: `WITH candidate AS (
          SELECT i.id, i.instance_id, i.profile_url, i.campaign_id, i.sent_at, i.body, i.first_seen_at,
                 rr.sentiment, rr.provenance AS review_provenance, rr.sentiment_provenance,
                 rr.intent_state, rr.revision AS review_revision,
                 EXISTS (SELECT 1 FROM public.legacy_reply_classifications lac WHERE lac.message_id=i.id
                         AND (lac.sentiment_provenance='legacy_ai' OR lac.intent_provenance='legacy_ai')) AS legacy_ai,
                 (rr.message_id IS NULL OR rr.sentiment IS NULL OR
                   (rr.sentiment IN ('negative','objection') AND NOT EXISTS
                     (SELECT 1 FROM public.reply_review_reasons r0 WHERE r0.message_id = i.id))) AS pending,
                 row_number() OVER (PARTITION BY i.instance_id, i.profile_url ORDER BY COALESCE(i.first_seen_at, i.sent_at), i.id) AS first_rank
            FROM public.messages i
            LEFT JOIN public.reply_reviews rr ON rr.message_id = i.id
            LEFT JOIN public.conversation_follow_up_state wf ON wf.instance_id = i.instance_id AND wf.profile_url = i.profile_url
           WHERE i.direction = 'in' AND ${INBOX_FILTER}
             AND ($10::text <> 'new' OR i.first_seen_at >= $11::timestamptz)
             AND ($10::text <> 'historical' OR i.first_seen_at IS NULL OR i.first_seen_at < $11::timestamptz)
             AND ($10::text = 'all' OR $11::timestamptz IS NOT NULL)
        ), dialogs AS (
          SELECT c.instance_id, c.profile_url,
                 count(*) AS inbound_count,
                 count(*) FILTER (WHERE c.pending) AS pending_count,
                 count(*) FILTER (WHERE c.intent_state IS NULL OR c.intent_state='unreviewed') AS unreviewed_intent_count,
                 count(*) FILTER (WHERE c.legacy_ai) AS legacy_ai_count,
                 (array_agg(c.id ORDER BY COALESCE(c.first_seen_at,c.sent_at), c.id) FILTER (WHERE c.pending))[1] AS pending_message_id,
                 (array_agg(c.review_revision ORDER BY COALESCE(c.first_seen_at,c.sent_at), c.id) FILTER (WHERE c.pending))[1] AS pending_review_revision,
                 (array_agg(c.id ORDER BY c.sent_at DESC, c.id DESC))[1] AS latest_inbound_id,
                 (array_agg(c.review_revision ORDER BY c.sent_at DESC, c.id DESC))[1] AS latest_review_revision,
                 (array_agg(c.sentiment ORDER BY c.sent_at DESC, c.id DESC))[1] AS latest_sentiment,
                 (array_agg(c.review_provenance ORDER BY c.sent_at DESC, c.id DESC))[1] AS latest_review_provenance,
                 (array_agg(c.sentiment_provenance ORDER BY c.sent_at DESC, c.id DESC))[1] AS latest_sentiment_provenance,
                 (array_agg(c.first_seen_at ORDER BY COALESCE(c.first_seen_at,c.sent_at), c.id))[1] AS first_seen_at,
                 (array_agg(c.sent_at ORDER BY COALESCE(c.first_seen_at,c.sent_at), c.id))[1] AS first_sent_at,
                 array_agg(DISTINCT c.campaign_id) FILTER (WHERE c.campaign_id IS NOT NULL) AS campaign_ids
            FROM candidate c GROUP BY c.instance_id, c.profile_url
        ), latest AS (
          SELECT DISTINCT ON (m.instance_id, m.profile_url) m.instance_id, m.profile_url,
                 m.body AS latest_snippet, m.direction AS latest_direction, m.sent_at AS latest_sent_at
            FROM public.messages m JOIN dialogs d USING (instance_id, profile_url)
           ORDER BY m.instance_id, m.profile_url, m.sent_at DESC, m.id DESC
        ), filtered AS (
          SELECT d.*, wf.owner_id, wf.action, wf.next_follow_up_date, coalesce(wf.do_not_contact,false) AS do_not_contact,
                 coalesce(wf.revision,0) AS workflow_revision, coalesce(wf.acknowledged_inbound_revision,0) AS acknowledged_inbound_revision,
                 coalesce(rs.inbound_revision,0) AS inbound_revision,
                 l.latest_snippet, l.latest_direction, l.latest_sent_at,
                 CASE WHEN $12::text = 'unreviewed' AND $10::text = 'new'
                      THEN COALESCE(d.first_seen_at, d.first_sent_at) ELSE l.latest_sent_at END AS sort_at
            FROM dialogs d JOIN latest l USING (instance_id, profile_url)
            LEFT JOIN public.conversation_follow_up_state wf USING (instance_id, profile_url)
            LEFT JOIN public.conversation_reply_review_state rs USING (instance_id, profile_url)
           WHERE ($12::text = 'all'
              OR ($12::text = 'unreviewed' AND d.pending_count > 0)
              OR ($12::text = 'needs_reply' AND wf.action = 'needs_reply' AND coalesce(wf.do_not_contact,false) = false)
              OR ($12::text = 'deferred' AND wf.action = 'follow_up' AND coalesce(wf.do_not_contact,false) = false)
              OR ($12::text = 'completed' AND d.pending_count = 0 AND (wf.action IN ('resolved','closed_soft','closed_hard') OR wf.do_not_contact = true)))
             AND (NOT $13::boolean OR coalesce(rs.inbound_revision,0) > coalesce(wf.acknowledged_inbound_revision,0))
             AND (NOT $14::boolean OR wf.owner_id IS NULL)
             AND (NOT $15::boolean OR (wf.action = 'follow_up' AND wf.next_follow_up_date < (now() AT TIME ZONE 'Europe/Madrid')::date))
             AND (NOT $16::boolean OR (wf.owner_id IS NOT NULL AND wf.owner_id =
                  (SELECT tm.id FROM public.team_members tm WHERE tm.user_id = CASE
                    WHEN $17::text ~* '^[0-9a-f-]{36}$' THEN $17::uuid ELSE NULL::uuid END AND tm.active)))
             AND ($21::text IS NULL OR
                  ($21::text = 'full_dialogues' AND d.pending_count = 0) OR
                  ($21::text = 'unreviewed_dialogues' AND d.pending_count > 0) OR
                  ($21::text IN ('dialogues','account','campaign','messages','weekly_volume','weekly_messages') AND d.inbound_count > 0) OR
                  ($21::text = 'unreviewed_intent' AND d.unreviewed_intent_count > 0) OR
                  ($21::text = 'legacy_ai' AND d.legacy_ai_count > 0) OR
                  ($21::text = 'latest_unreviewed' AND d.latest_sentiment IS NULL) OR
                  ($21::text = 'only_auto' AND NOT EXISTS
                    (SELECT 1 FROM candidate cx WHERE cx.instance_id=d.instance_id AND cx.profile_url=d.profile_url
                       AND cx.sentiment IS DISTINCT FROM 'auto')) OR
                  ($21::text IN ('business_rate','negative_objection') AND
                    d.latest_sentiment IN ('negative','objection') AND
                    d.latest_review_provenance IN ('human','legacy_manual') AND
                    d.latest_sentiment_provenance IN ('human','legacy_manual')) OR
                  ($21::text = 'needs_confirmation' AND
                    (coalesce(rs.inbound_revision,0) > coalesce(wf.acknowledged_inbound_revision,0) OR wf.action IS NULL)) OR
                  ($21::text = 'overdue' AND coalesce(wf.do_not_contact,false) = false AND
                    coalesce(rs.inbound_revision,0) <= coalesce(wf.acknowledged_inbound_revision,0) AND
                    wf.action='follow_up' AND wf.next_follow_up_date < (now() AT TIME ZONE 'Europe/Madrid')::date) OR
                  ($21::text = 'follow_up_today' AND coalesce(wf.do_not_contact,false) = false AND
                    coalesce(rs.inbound_revision,0) <= coalesce(wf.acknowledged_inbound_revision,0) AND
                    wf.action='follow_up' AND wf.next_follow_up_date = (now() AT TIME ZONE 'Europe/Madrid')::date) OR
                  ($21::text = 'follow_up_later' AND coalesce(wf.do_not_contact,false) = false AND
                    coalesce(rs.inbound_revision,0) <= coalesce(wf.acknowledged_inbound_revision,0) AND
                    wf.action='follow_up' AND wf.next_follow_up_date > (now() AT TIME ZONE 'Europe/Madrid')::date) OR
                  ($21::text = 'do_not_contact' AND coalesce(wf.do_not_contact,false) = true) OR
                  ($21::text = 'transfers' AND EXISTS (
                    SELECT 1 FROM public.reply_review_events te
                     WHERE te.instance_id=d.instance_id AND te.profile_url=d.profile_url
                       AND te.event_type='workflow'
                       AND ($8::timestamptz IS NULL OR te.occurred_at >= $8::timestamptz)
                       AND ($9::timestamptz IS NULL OR te.occurred_at < $9::timestamptz)
                       AND (te.after->>'owner_id') IS DISTINCT FROM (te.before->>'owner_id'))) OR
                  ($21::text IN ('needs_reply','awaiting_reply','resolved','closed_soft','closed_hard') AND
                    coalesce(wf.do_not_contact,false) = false AND
                    coalesce(rs.inbound_revision,0) <= coalesce(wf.acknowledged_inbound_revision,0) AND wf.action=$21::text))
        ), identity AS (
          SELECT f.*, ld.full_name AS name, ld.company, ld.headline,
                 (f.sort_at, f.instance_id, f.profile_url) AS cursor_key,
                 COALESCE(f.pending_message_id, f.latest_inbound_id) AS selected_message_id,
                 CASE WHEN f.pending_message_id IS NOT NULL
                      THEN COALESCE(f.pending_review_revision, 0)
                      ELSE COALESCE(f.latest_review_revision, 0)
                  END AS review_revision
            FROM filtered f LEFT JOIN LATERAL (
              SELECT full_name, company, headline FROM public.leads ld0
               WHERE ld0.instance_id=f.instance_id AND ld0.profile_url=f.profile_url
               ORDER BY ld0.updated_at DESC, ld0.id DESC LIMIT 1
            ) ld ON true
        )
        SELECT instance_id, profile_url, name, company, headline, latest_snippet, latest_direction, latest_sent_at,
               selected_message_id, pending_count, owner_id, action, to_char(next_follow_up_date,'YYYY-MM-DD') AS next_follow_up_date,
               do_not_contact, GREATEST(workflow_revision, inbound_revision) AS revision, review_revision,
               workflow_revision, inbound_revision, acknowledged_inbound_revision, campaign_ids,
               campaign_ids[1] AS campaign_id, first_seen_at, sort_at
          FROM identity
         WHERE ($18::timestamptz IS NULL OR
               (($12::text = 'unreviewed' AND $10::text = 'new') AND
                 (sort_at > $18::timestamptz OR (sort_at = $18::timestamptz AND (instance_id,profile_url) > ($19::text,$20::text)))) OR
               (($12::text <> 'unreviewed' OR $10::text <> 'new') AND
                 (sort_at < $18::timestamptz OR (sort_at = $18::timestamptz AND (instance_id,profile_url) > ($19::text,$20::text)))))
         ORDER BY CASE WHEN $12::text = 'unreviewed' AND $10::text = 'new' THEN sort_at END ASC NULLS FIRST,
                  CASE WHEN NOT ($12::text = 'unreviewed' AND $10::text = 'new') THEN sort_at END DESC NULLS LAST,
                  instance_id, profile_url`,
      values: [...f, p?.scope ?? 'all', p?.captureStartedAt ?? null, p?.view ?? 'unreviewed', p?.unacknowledged ?? false, p?.unowned ?? false, p?.overdue ?? false, p?.my ?? false, p?.currentActorId ?? null, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, metricValue || null],
    }
  },
  mapRow: mapInbox,
}

/**
 * Counts facets over the complete filtered dialog cohort, rather than the
 * current page.  It intentionally returns one bounded JSON row so the public
 * inbox read can compose real facets without a second unscoped snapshot.
 */
export const facetsOperation: NeonQueryOperation<ReplyFacets, ReplyFacetsParams> = {
  build: ({ params }) => {
    const p = params
    const metricParts = p?.metricScope?.split(':') ?? []
    const metricKind = metricParts[0]
    const metricValue = metricParts.slice(1).join(':')
    const f = replyFilterValues({
      instance_id: p?.instanceId, campaign_id: p?.campaignId, owner_id: p?.ownerId,
      sentiment: p?.sentiment ?? metricSentiment(metricKind, metricValue),
      reason_id: (p?.reasonId as ReplyFilter['reason_id']) ?? metricReason(metricKind, metricValue) as ReplyFilter['reason_id'],
      action: p?.action ?? metricAction(metricKind, metricValue),
      query: p?.query, from: p?.from, to: p?.to,
    })
    return {
      text: `WITH candidate AS (
        SELECT i.id, i.instance_id, i.profile_url, i.campaign_id, i.sent_at, rr.sentiment,
               rr.provenance AS review_provenance, rr.sentiment_provenance, rr.intent_state,
               EXISTS (SELECT 1 FROM public.legacy_reply_classifications lac WHERE lac.message_id=i.id
                       AND (lac.sentiment_provenance='legacy_ai' OR lac.intent_provenance='legacy_ai')) AS legacy_ai,
               (rr.message_id IS NULL OR rr.sentiment IS NULL OR (rr.sentiment IN ('negative','objection') AND NOT EXISTS (SELECT 1 FROM public.reply_review_reasons r0 WHERE r0.message_id=i.id))) AS pending
          FROM public.messages i
          LEFT JOIN public.reply_reviews rr ON rr.message_id=i.id
          LEFT JOIN public.conversation_follow_up_state wf ON wf.instance_id=i.instance_id AND wf.profile_url=i.profile_url
         WHERE i.direction='in' AND ${INBOX_FILTER}
           AND ($10::text <> 'new' OR i.first_seen_at >= $11::timestamptz)
           AND ($10::text <> 'historical' OR i.first_seen_at IS NULL OR i.first_seen_at < $11::timestamptz)
           AND ($10::text = 'all' OR $11::timestamptz IS NOT NULL)
      ), dialogs AS (
        SELECT c.instance_id,c.profile_url,count(*) FILTER (WHERE c.pending) AS pending_count,
               count(*) AS inbound_count,
               count(*) FILTER (WHERE c.intent_state IS NULL OR c.intent_state='unreviewed') AS unreviewed_intent_count,
               count(*) FILTER (WHERE c.legacy_ai) AS legacy_ai_count,
               (array_agg(c.sentiment ORDER BY c.sent_at DESC,c.id DESC))[1] AS latest_sentiment
               ,(array_agg(c.review_provenance ORDER BY c.sent_at DESC,c.id DESC))[1] AS latest_review_provenance
               ,(array_agg(c.sentiment_provenance ORDER BY c.sent_at DESC,c.id DESC))[1] AS latest_sentiment_provenance
          FROM candidate c GROUP BY c.instance_id,c.profile_url
      ), filtered AS (
        SELECT d.*,wf.owner_id,wf.action,wf.next_follow_up_date,coalesce(wf.do_not_contact,false) AS do_not_contact,
               coalesce(rs.inbound_revision,0) AS inbound_revision,coalesce(wf.acknowledged_inbound_revision,0) AS acknowledged_revision
          FROM dialogs d LEFT JOIN public.conversation_follow_up_state wf USING(instance_id,profile_url)
          LEFT JOIN public.conversation_reply_review_state rs USING(instance_id,profile_url)
         WHERE ($12::text='all'
            OR ($12::text='unreviewed' AND d.pending_count>0)
            OR ($12::text='needs_reply' AND wf.action='needs_reply' AND coalesce(wf.do_not_contact,false)=false)
            OR ($12::text='deferred' AND wf.action='follow_up' AND coalesce(wf.do_not_contact,false)=false)
            OR ($12::text='completed' AND d.pending_count=0 AND (wf.action IN ('resolved','closed_soft','closed_hard') OR wf.do_not_contact=true)))
           AND (NOT $13::boolean OR coalesce(rs.inbound_revision,0) > coalesce(wf.acknowledged_inbound_revision,0))
           AND (NOT $14::boolean OR wf.owner_id IS NULL)
           AND (NOT $15::boolean OR (wf.action='follow_up' AND wf.next_follow_up_date < (now() AT TIME ZONE 'Europe/Madrid')::date))
           AND (NOT $16::boolean OR (wf.owner_id IS NOT NULL AND wf.owner_id=(SELECT tm.id FROM public.team_members tm WHERE tm.user_id=CASE WHEN $17::text ~* '^[0-9a-f-]{36}$' THEN $17::uuid ELSE NULL::uuid END AND tm.active)))
           AND ($18::text IS NULL OR ($18::text='full_dialogues' AND d.pending_count=0)
             OR ($18::text='unreviewed_dialogues' AND d.pending_count>0)
             OR ($18::text IN ('dialogues','account','campaign','messages','weekly_volume','weekly_messages') AND d.inbound_count>0)
             OR ($18::text='unreviewed_intent' AND d.unreviewed_intent_count>0)
             OR ($18::text='legacy_ai' AND d.legacy_ai_count>0)
             OR ($18::text='latest_unreviewed' AND d.latest_sentiment IS NULL)
             OR ($18::text='only_auto' AND NOT EXISTS (SELECT 1 FROM candidate cx WHERE cx.instance_id=d.instance_id AND cx.profile_url=d.profile_url AND cx.sentiment IS DISTINCT FROM 'auto'))
             OR ($18::text IN ('business_rate','negative_objection') AND d.latest_sentiment IN ('negative','objection') AND d.latest_review_provenance IN ('human','legacy_manual') AND d.latest_sentiment_provenance IN ('human','legacy_manual'))
             OR ($18::text='needs_confirmation' AND (coalesce(rs.inbound_revision,0)>coalesce(wf.acknowledged_inbound_revision,0) OR wf.action IS NULL))
             OR ($18::text='overdue' AND coalesce(wf.do_not_contact,false)=false AND coalesce(rs.inbound_revision,0)<=coalesce(wf.acknowledged_inbound_revision,0) AND wf.action='follow_up' AND wf.next_follow_up_date < (now() AT TIME ZONE 'Europe/Madrid')::date)
             OR ($18::text='follow_up_today' AND coalesce(wf.do_not_contact,false)=false AND coalesce(rs.inbound_revision,0)<=coalesce(wf.acknowledged_inbound_revision,0) AND wf.action='follow_up' AND wf.next_follow_up_date=(now() AT TIME ZONE 'Europe/Madrid')::date)
             OR ($18::text='follow_up_later' AND coalesce(wf.do_not_contact,false)=false AND coalesce(rs.inbound_revision,0)<=coalesce(wf.acknowledged_inbound_revision,0) AND wf.action='follow_up' AND wf.next_follow_up_date>(now() AT TIME ZONE 'Europe/Madrid')::date)
             OR ($18::text='do_not_contact' AND coalesce(wf.do_not_contact,false)=true)
             OR ($18::text='transfers' AND EXISTS (SELECT 1 FROM public.reply_review_events te WHERE te.instance_id=d.instance_id AND te.profile_url=d.profile_url AND te.event_type='workflow' AND ($8::timestamptz IS NULL OR te.occurred_at >= $8::timestamptz) AND ($9::timestamptz IS NULL OR te.occurred_at < $9::timestamptz) AND (te.after->>'owner_id') IS DISTINCT FROM (te.before->>'owner_id')))
             OR ($18::text IN ('needs_reply','awaiting_reply','resolved','closed_soft','closed_hard') AND coalesce(wf.do_not_contact,false)=false AND coalesce(rs.inbound_revision,0)<=coalesce(wf.acknowledged_inbound_revision,0) AND wf.action=$18::text))
      ), scoped_messages AS (
        SELECT c.* FROM candidate c JOIN filtered f USING(instance_id,profile_url)
      )
      SELECT jsonb_build_object(
        'accounts',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.instance_id,'count',x.n) ORDER BY x.instance_id),'[]'::jsonb) FROM (SELECT instance_id,count(*) n FROM filtered GROUP BY instance_id) x),
        'campaigns',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',coalesce(x.campaign_id,'__none__'),'count',x.n) ORDER BY coalesce(x.campaign_id,'__none__')),'[]'::jsonb) FROM (SELECT c.campaign_id,count(DISTINCT c.instance_id||chr(31)||c.profile_url) n FROM scoped_messages c GROUP BY c.campaign_id) x),
        'owners',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.owner_id,'count',x.n) ORDER BY x.owner_id NULLS FIRST),'[]'::jsonb) FROM (SELECT owner_id,count(*) n FROM filtered GROUP BY owner_id) x),
        'actions',(SELECT coalesce(jsonb_agg(jsonb_build_object('value',x.action,'count',x.n) ORDER BY x.action NULLS FIRST),'[]'::jsonb) FROM (SELECT action,count(*) n FROM filtered GROUP BY action) x),
        'sentiments',(SELECT coalesce(jsonb_agg(jsonb_build_object('value',x.latest_sentiment,'count',x.n) ORDER BY x.latest_sentiment NULLS FIRST),'[]'::jsonb) FROM (SELECT latest_sentiment,count(*) n FROM filtered GROUP BY latest_sentiment) x),
        'reasons',(SELECT coalesce(jsonb_agg(jsonb_build_object('value',x.reason_id,'count',x.n) ORDER BY x.reason_id),'[]'::jsonb) FROM (SELECT r.reason_id,count(DISTINCT c.instance_id||chr(31)||c.profile_url) n FROM scoped_messages c JOIN public.reply_review_reasons r ON r.message_id=c.id GROUP BY r.reason_id) x)
      ) AS result`,
      values: [...f, p?.scope ?? 'all', p?.captureStartedAt ?? null, p?.view ?? 'unreviewed', p?.unacknowledged ?? false, p?.unowned ?? false, p?.overdue ?? false, p?.my ?? false, p?.currentActorId ?? null, metricValue || null],
    }
  },
  mapRow: mapFacets,
}

function mapThread(row: NeonRow): ReplyThreadMessage {
  return {
    id: Number(row.id), instance_id: String(row.instance_id), profile_url: String(row.profile_url),
    campaign_id: nullableText(row.campaign_id), direction: row.direction === 'out' ? 'out' : 'in',
    body: nullableText(row.body), sent_at: String(row.sent_at), first_seen_at: nullableText(row.first_seen_at),
    review: reviewFromJson(row.review, Number(row.id)),
    has_older: row.has_older === true, has_newer: row.has_newer === true,
  }
}

export const threadOperation: NeonQueryOperation<ReplyThreadMessage, ReplyThreadParams> = {
  keyset: { columns: ['sent_at', 'id'] },
  build: ({ params, after, page }) => {
    const requested = Math.min(100, Math.max(1, page?.limit ?? 50))
    // Neon wraps this statement with LIMIT page.limit + 1. Directional pages
    // must expose one extra candidate internally so the outer probe can learn
    // hasMore and emit a cursor; the driver trims that far-side row.
    const directionalLimit = requested + 1
    const olderAround = Math.max(1, Math.floor(requested / 2))
    const newerAround = Math.max(1, Math.ceil(requested / 2))
    return {
    text: `WITH focus AS (
             SELECT sent_at, id FROM public.messages
              WHERE id = $3::bigint AND instance_id = $1 AND profile_url = $2
           ), windowed AS (
             (SELECT m.* FROM public.messages m, focus f
              WHERE m.instance_id = $1 AND m.profile_url = $2
                AND $4::timestamptz IS NULL AND $6::text = 'around'
                AND (m.sent_at, m.id) < (f.sent_at, f.id)
              ORDER BY m.sent_at DESC, m.id DESC LIMIT ${olderAround})
             UNION ALL
             (SELECT m.* FROM public.messages m, focus f
              WHERE m.instance_id = $1 AND m.profile_url = $2
                AND $4::timestamptz IS NULL AND $6::text = 'around'
                AND (m.sent_at, m.id) >= (f.sent_at, f.id)
              ORDER BY m.sent_at ASC, m.id ASC LIMIT ${newerAround})
             UNION ALL
             (SELECT m.* FROM public.messages m, focus f
              WHERE m.instance_id = $1 AND m.profile_url = $2
                AND $4::timestamptz IS NULL AND $6::text = 'older'
                AND (m.sent_at, m.id) < (f.sent_at, f.id)
              ORDER BY m.sent_at DESC, m.id DESC LIMIT ${directionalLimit})
             UNION ALL
             (SELECT m.* FROM public.messages m, focus f
              WHERE m.instance_id = $1 AND m.profile_url = $2
                AND $4::timestamptz IS NULL AND $6::text = 'newer'
                AND (m.sent_at, m.id) >= (f.sent_at, f.id)
              ORDER BY m.sent_at ASC, m.id ASC LIMIT ${directionalLimit})
             UNION ALL
             (SELECT m.* FROM public.messages m
              WHERE m.instance_id = $1 AND m.profile_url = $2
                AND $3::bigint IS NULL AND $4::timestamptz IS NULL
              ORDER BY m.sent_at DESC, m.id DESC LIMIT ${directionalLimit})
             UNION ALL
             (SELECT m.* FROM public.messages m
              WHERE m.instance_id = $1 AND m.profile_url = $2
                AND $4::timestamptz IS NOT NULL AND $6::text = 'older'
                AND (m.sent_at, m.id) < ($4::timestamptz,$5::bigint)
              ORDER BY m.sent_at DESC, m.id DESC LIMIT ${directionalLimit})
             UNION ALL
             (SELECT m.* FROM public.messages m
              WHERE m.instance_id = $1 AND m.profile_url = $2
                AND $4::timestamptz IS NOT NULL AND $6::text = 'newer'
                AND (m.sent_at, m.id) > ($4::timestamptz,$5::bigint)
              ORDER BY m.sent_at ASC, m.id ASC LIMIT ${directionalLimit})
           ), page AS (
             SELECT DISTINCT ON (id) * FROM windowed
           ), bounds AS (
             SELECT (array_agg(sent_at ORDER BY sent_at ASC, id ASC))[1] AS first_sent_at,
                    (array_agg(id ORDER BY sent_at ASC, id ASC))[1] AS first_id,
                    (array_agg(sent_at ORDER BY sent_at DESC, id DESC))[1] AS last_sent_at,
                    (array_agg(id ORDER BY sent_at DESC, id DESC))[1] AS last_id
               FROM page
           )
           SELECT m.id::text AS id, m.instance_id, m.profile_url, m.campaign_id,
                  m.direction, m.body, m.sent_at, m.first_seen_at,
                  EXISTS (SELECT 1 FROM public.messages om WHERE om.instance_id=$1 AND om.profile_url=$2 AND (om.sent_at,om.id)<(b.first_sent_at,b.first_id)) AS has_older,
                  EXISTS (SELECT 1 FROM public.messages nm WHERE nm.instance_id=$1 AND nm.profile_url=$2 AND (nm.sent_at,nm.id)>(b.last_sent_at,b.last_id)) AS has_newer,
                  CASE WHEN rr.message_id IS NULL THEN NULL ELSE jsonb_build_object(
                    'message_id', rr.message_id, 'sentiment', rr.sentiment, 'intent_state', rr.intent_state,
                    'intent_level', rr.intent_level, 'reason_ids', coalesce((SELECT jsonb_agg(r.reason_id ORDER BY r.reason_id) FROM public.reply_review_reasons r WHERE r.message_id = rr.message_id), '[]'::jsonb),
                    'comment', rr.comment, 'taxonomy_version', rr.taxonomy_version, 'reviewed_by', rr.reviewed_by,
                    'provenance', rr.provenance, 'reviewed_at', rr.reviewed_at, 'revision', rr.revision,
                    'complete', (rr.sentiment IS NOT NULL AND (rr.sentiment NOT IN ('negative','objection') OR EXISTS (SELECT 1 FROM public.reply_review_reasons rx WHERE rx.message_id = rr.message_id)))
                  ) END AS review
             FROM page m CROSS JOIN bounds b LEFT JOIN public.reply_reviews rr ON rr.message_id = m.id
             ORDER BY CASE WHEN $6::text = 'older' THEN m.sent_at END DESC NULLS LAST,
                      CASE WHEN $6::text = 'older' THEN m.id END DESC NULLS LAST,
                      CASE WHEN $6::text <> 'older' THEN m.sent_at END ASC NULLS LAST,
                      CASE WHEN $6::text <> 'older' THEN m.id END ASC NULLS LAST`,
    values: [params?.instanceId ?? '', params?.profileUrl ?? '', params?.focusMessageId ?? null, after?.[0] ?? null, after?.[1] ?? null, params?.direction ?? 'around'],
    }
  },
  mapRow: mapThread,
}

function mapHistory(row: NeonRow): ReplyReviewHistoryItem {
  const provenance = ['human', 'legacy_manual', 'system', 'machine'].includes(String(row.provenance))
    ? String(row.provenance) as ReplyReviewHistoryItem['provenance']
    : 'human'
  return {
    id: String(row.id), event_id: String(row.id), instance_id: String(row.instance_id), profile_url: String(row.profile_url),
    message_id: nullableNumber(row.message_id), actor_id: nullableText(row.actor_id), actor: nullableText(row.actor_id),
    provenance, before: object(row.before), after: object(row.after),
    occurred_at: String(row.occurred_at), mutation_id: String(row.mutation_id),
  }
}

export const reviewHistoryOperation: NeonQueryOperation<ReplyReviewHistoryItem, ReplyHistoryParams> = {
  keyset: { columns: ['occurred_at', 'id'] },
  build: ({ params, after }) => ({
    text: `SELECT e.id::text AS id, e.instance_id, e.profile_url, e.message_id::text AS message_id,
                  e.actor_id::text AS actor_id, e.provenance, e.before, e.after, e.occurred_at, e.mutation_id::text AS mutation_id
             FROM public.reply_review_events e
            WHERE e.instance_id = $1 AND e.profile_url = $2
              AND ($3::bigint IS NULL OR e.message_id = $3::bigint)
              AND ($4::timestamptz IS NULL OR (e.occurred_at, e.id) < ($4::timestamptz, $5::bigint))
            ORDER BY e.occurred_at DESC, e.id DESC`,
    values: [params?.instanceId ?? '', params?.profileUrl ?? '', params?.messageId ?? null, after?.[0] ?? null, after?.[1] ?? null],
  }),
  mapRow: mapHistory,
}

const metric = (n: string, d: string, drilldown: string) => {
  const expression = drilldown.trim().startsWith('{') ? `'${drilldown.replace(/'/g, "''")}'` : drilldown
  return `jsonb_build_object('numerator', ${n}, 'denominator', ${d}, 'rate', CASE WHEN ${d} = 0 THEN NULL ELSE (${n})::numeric / (${d}) END, 'base','dialogues','bounds',jsonb_build_object('from',$1::timestamptz,'to',$2::timestamptz), 'drilldown', ${expression}::jsonb)`
}

export const analyticsOperation: NeonQueryOperation<ReplyAnalyticsResponse, ReplyAnalyticsParams> = {
  build: ({ params }) => {
    // The base cohort intentionally has no reason/sentiment filter.  Drilldown
    // filters are applied only to the list; applying them here would change a
    // denominator (especially the business-rate and reason denominators).
    const filter = replyFilterBuilder({ instance_id: params?.instanceId, campaign_id: params?.campaignId, owner_id: params?.ownerId, reason_id: null, sentiment: null, action: null, query: null, from: params?.from ?? null, to: params?.to ?? null }, 'm', 3)
    return {
      text: `WITH inbound AS (
        SELECT m.id, m.instance_id, m.profile_url, m.campaign_id, m.sent_at,
               rr.sentiment, rr.intent_state, rr.intent_level, rr.provenance,
               rr.sentiment_provenance, rr.intent_provenance,
               (rr.message_id IS NOT NULL AND rr.sentiment IS NOT NULL AND
                (rr.sentiment NOT IN ('negative','objection') OR EXISTS
                  (SELECT 1 FROM public.reply_review_reasons r0 WHERE r0.message_id=m.id))) AS complete,
               (rr.message_id IS NOT NULL AND rr.sentiment IS NOT NULL AND rr.sentiment <> 'auto'
                AND rr.provenance IN ('human','legacy_manual')) AS manual_non_auto,
               EXISTS (SELECT 1 FROM public.legacy_reply_classifications lac WHERE lac.message_id=m.id
                       AND (lac.sentiment_provenance='legacy_ai' OR lac.intent_provenance='legacy_ai')) AS legacy_ai
          FROM public.messages m
          LEFT JOIN public.reply_reviews rr ON rr.message_id=m.id
          LEFT JOIN public.conversation_follow_up_state wf ON wf.instance_id=m.instance_id AND wf.profile_url=m.profile_url
         WHERE m.direction = 'in' AND ${filter.sql}
      ), dialogs AS (
        SELECT instance_id, profile_url, count(*) AS message_count,
               count(*) FILTER (WHERE complete) AS complete_message_count,
               count(*) FILTER (WHERE sentiment IS NULL) AS unreviewed_message_count,
               count(*) FILTER (WHERE intent_state IS NULL OR intent_state='unreviewed') AS unreviewed_intent_count,
               count(*) FILTER (WHERE legacy_ai) AS legacy_ai_message_count
          FROM inbound GROUP BY instance_id, profile_url
      ), latest_inbound AS (
        SELECT DISTINCT ON (instance_id,profile_url) *
          FROM inbound ORDER BY instance_id,profile_url,sent_at DESC,id DESC
      ), eligible_latest AS (
        SELECT * FROM latest_inbound
         WHERE manual_non_auto
      ), classified AS (
        SELECT li.instance_id,li.profile_url,
               CASE WHEN li.sentiment IS NULL THEN 'latest_unreviewed'
                    WHEN li.sentiment = 'auto' AND NOT EXISTS
                      (SELECT 1 FROM inbound ai WHERE ai.instance_id=li.instance_id AND ai.profile_url=li.profile_url
                         AND ai.sentiment IS DISTINCT FROM 'auto') THEN 'only_auto'
                    ELSE li.sentiment END AS bucket
          FROM latest_inbound li
      ), manual_negative AS (
        SELECT DISTINCT i.instance_id,i.profile_url
          FROM inbound i WHERE i.manual_non_auto AND i.sentiment IN ('negative','objection')
      ), reason_dialogues AS (
        SELECT r.reason_id, count(DISTINCT i.instance_id||chr(31)||i.profile_url) AS n
          FROM inbound i JOIN public.reply_review_reasons r ON r.message_id=i.id
         WHERE i.manual_non_auto AND i.sentiment IN ('negative','objection')
         GROUP BY r.reason_id
      ), workflow_cohort AS (
        SELECT d.*, wf.action, wf.owner_id, wf.next_follow_up_date, coalesce(wf.do_not_contact,false) AS do_not_contact,
               coalesce(wf.acknowledged_inbound_revision,0) AS acknowledged_revision,
               coalesce(rs.inbound_revision,0) AS inbound_revision
          FROM dialogs d
          LEFT JOIN public.conversation_follow_up_state wf USING(instance_id,profile_url)
          LEFT JOIN public.conversation_reply_review_state rs USING(instance_id,profile_url)
      ), workflow_bucketed AS (
        SELECT instance_id, profile_url,
               CASE WHEN do_not_contact THEN 'do_not_contact'
                    WHEN acknowledged_revision < inbound_revision OR action IS NULL THEN 'needs_confirmation'
                    WHEN action='follow_up' AND next_follow_up_date < (now() AT TIME ZONE 'Europe/Madrid')::date THEN 'overdue'
                    WHEN action='follow_up' AND next_follow_up_date = (now() AT TIME ZONE 'Europe/Madrid')::date THEN 'follow_up_today'
                    WHEN action='follow_up' THEN 'follow_up_later'
                    ELSE action END AS bucket
          FROM workflow_cohort
      ), weeks AS (
        SELECT date_trunc('week',sent_at)::date AS week,* FROM inbound
      ), weekly_latest AS (
        SELECT DISTINCT ON (week,instance_id,profile_url) week,instance_id,profile_url,sentiment,id
          FROM weeks
         ORDER BY week,instance_id,profile_url,sent_at DESC,id DESC
      ), weekly_classified AS (
        SELECT wl.week, wl.instance_id, wl.profile_url,
               CASE WHEN wl.sentiment IS NULL THEN 'latest_unreviewed'
                    WHEN wl.sentiment = 'auto' AND NOT EXISTS
                      (SELECT 1 FROM weeks wa WHERE wa.week=wl.week AND wa.instance_id=wl.instance_id
                         AND wa.profile_url=wl.profile_url AND wa.sentiment IS DISTINCT FROM 'auto') THEN 'only_auto'
                    ELSE wl.sentiment END AS bucket
          FROM weekly_latest wl
      ), weekly_dialogues AS (
        SELECT DISTINCT week,instance_id,profile_url FROM weeks
      ), weekly_manual_negative AS (
        SELECT week, count(DISTINCT instance_id||chr(31)||profile_url) AS n
          FROM weeks
         WHERE manual_non_auto AND sentiment IN ('negative','objection')
         GROUP BY week
      ), weekly_reasons AS (
        SELECT w.week,r.reason_id,count(DISTINCT w.instance_id||chr(31)||w.profile_url) AS n
          FROM weeks w JOIN public.reply_review_reasons r ON r.message_id=w.id
         WHERE w.manual_non_auto AND w.sentiment IN ('negative','objection') GROUP BY w.week,r.reason_id
      ), weekly_rows AS (
        SELECT week, count(*) AS messages, count(*) FILTER (WHERE complete) AS complete_messages
          FROM weeks GROUP BY week
      ), campaign_dialogues AS (
        SELECT coalesce(campaign_id,'__none__') AS campaign_id, instance_id, profile_url,
               bool_and(complete) AS complete,
               bool_or(manual_non_auto AND sentiment IN ('negative','objection')) AS neg_objection
          FROM inbound GROUP BY coalesce(campaign_id,'__none__'),instance_id,profile_url
      ), comparison_reasons AS (
        SELECT 'account'::text AS kind, i.instance_id AS id, r.reason_id,
               count(DISTINCT i.instance_id||chr(31)||i.profile_url)::int AS n
          FROM inbound i JOIN public.reply_review_reasons r ON r.message_id=i.id
         WHERE i.manual_non_auto AND i.sentiment IN ('negative','objection')
         GROUP BY i.instance_id,r.reason_id
        UNION ALL
        SELECT 'campaign'::text, coalesce(i.campaign_id,'__none__'), r.reason_id,
               count(DISTINCT i.instance_id||chr(31)||i.profile_url)::int
          FROM inbound i JOIN public.reply_review_reasons r ON r.message_id=i.id
         WHERE i.manual_non_auto AND i.sentiment IN ('negative','objection')
         GROUP BY coalesce(i.campaign_id,'__none__'),r.reason_id
      ), comparison AS (
        SELECT 'account'::text AS kind, d.instance_id AS id, count(*)::int AS volume,
               count(*) FILTER (WHERE d.complete_message_count=d.message_count)::int AS covered,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM eligible_latest l WHERE l.instance_id=d.instance_id AND l.profile_url=d.profile_url AND l.manual_non_auto AND l.sentiment IN ('negative','objection')))::int AS neg_objection
          FROM dialogs d GROUP BY d.instance_id
        UNION ALL
        SELECT 'campaign',c.campaign_id,count(*)::int,
               count(*) FILTER (WHERE c.complete)::int,
               count(*) FILTER (WHERE c.neg_objection)::int
          FROM campaign_dialogues c GROUP BY c.campaign_id
      ), sentiment_labels AS (
        SELECT unnest(ARRAY['positive','neutral','negative','objection','referral','auto','latest_unreviewed','only_auto']) AS bucket
      ), workflow_labels AS (
        SELECT unnest(ARRAY['do_not_contact','needs_confirmation','overdue','follow_up_today','follow_up_later','needs_reply','awaiting_reply','resolved','closed_soft','closed_hard']) AS bucket
      ), transfers AS (
        SELECT count(*) AS n FROM public.reply_review_events e
         JOIN workflow_cohort wc ON wc.instance_id=e.instance_id AND wc.profile_url=e.profile_url
         WHERE e.event_type='workflow'
           AND e.occurred_at >= $1::timestamptz AND e.occurred_at < $2::timestamptz
           AND (e.after->>'owner_id') IS DISTINCT FROM (e.before->>'owner_id')
      )
      SELECT jsonb_build_object(
        'coverage', jsonb_build_object(
          'dialogues', ${metric('(SELECT count(*) FROM dialogs)','(SELECT count(*) FROM dialogs)','{"kind":"coverage","value":"dialogues"}')},
          'full_dialogues', ${metric('(SELECT count(*) FROM dialogs WHERE complete_message_count=message_count)','(SELECT count(*) FROM dialogs)','{"kind":"coverage","value":"full_dialogues"}')},
          'messages', ${metric('(SELECT coalesce(sum(complete_message_count),0) FROM dialogs)','(SELECT coalesce(sum(message_count),0) FROM dialogs)','{"kind":"coverage","value":"messages"}')},
          'unreviewed_dialogues', ${metric('(SELECT count(*) FROM dialogs WHERE complete_message_count < message_count)','(SELECT count(*) FROM dialogs)','{"kind":"coverage","value":"unreviewed_dialogues"}')},
          'unreviewed_intent', ${metric('(SELECT coalesce(sum(unreviewed_intent_count),0) FROM dialogs)','(SELECT coalesce(sum(message_count),0) FROM dialogs)','{"kind":"coverage","value":"unreviewed_intent"}')},
          'legacy_ai', ${metric('(SELECT coalesce(sum(legacy_ai_message_count),0) FROM dialogs)','(SELECT coalesce(sum(message_count),0) FROM dialogs)','{"kind":"coverage","value":"legacy_ai"}')}
        ),
        'sentiment', (SELECT jsonb_object_agg(sl.bucket, ${metric('(SELECT count(*) FROM classified c WHERE c.bucket=sl.bucket)','(SELECT count(*) FROM classified)',"jsonb_build_object('kind','sentiment','value',sl.bucket)")}) FROM sentiment_labels sl)
          || jsonb_build_object('business_rate', ${metric("(SELECT count(*) FROM eligible_latest WHERE manual_non_auto AND sentiment IN ('negative','objection'))",'(SELECT count(*) FROM eligible_latest WHERE manual_non_auto)',"jsonb_build_object('kind','sentiment','value','business_rate')")}),
        'reasons', (SELECT jsonb_object_agg(sl.reason_id, jsonb_build_object('numerator', CASE WHEN sl.reason_id='missing_reason' THEN (SELECT count(DISTINCT mi.instance_id||chr(31)||mi.profile_url) FROM inbound mi WHERE mi.manual_non_auto AND mi.sentiment IN ('negative','objection') AND NOT EXISTS (SELECT 1 FROM public.reply_review_reasons mr WHERE mr.message_id=mi.id)) ELSE (SELECT coalesce(n,0) FROM reason_dialogues r WHERE r.reason_id=sl.reason_id) END, 'denominator',(SELECT count(*) FROM manual_negative), 'rate',CASE WHEN (SELECT count(*) FROM manual_negative)=0 THEN NULL ELSE (CASE WHEN sl.reason_id='missing_reason' THEN (SELECT count(DISTINCT mi.instance_id||chr(31)||mi.profile_url) FROM inbound mi WHERE mi.manual_non_auto AND mi.sentiment IN ('negative','objection') AND NOT EXISTS (SELECT 1 FROM public.reply_review_reasons mr WHERE mr.message_id=mi.id)) ELSE (SELECT coalesce(n,0) FROM reason_dialogues r WHERE r.reason_id=sl.reason_id) END)::numeric/(SELECT count(*) FROM manual_negative) END, 'drilldown',jsonb_build_object('kind','reason','value',sl.reason_id)::jsonb)) FROM (SELECT unnest(ARRAY['no_need','timing','budget','existing_solution','offer_fit','wrong_person','trust_information','do_not_contact','other','missing_reason']) AS reason_id) sl),
        'weekly_trend', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'week',w.week,'sample',w.messages,'volume',${metric('(SELECT count(*) FROM weekly_dialogues wd WHERE wd.week=w.week)','(SELECT count(*) FROM weekly_dialogues wd WHERE wd.week=w.week)',"jsonb_build_object('kind','coverage','value','weekly_volume')")},
          'messages',w.messages,'coverage',${metric('w.complete_messages','w.messages',"jsonb_build_object('kind','coverage','value','weekly_messages')")},
          'sentiment',(SELECT jsonb_object_agg(sl.bucket, ${metric('(SELECT count(*) FROM weekly_classified wc WHERE wc.week=w.week AND wc.bucket=sl.bucket)','(SELECT count(*) FROM weekly_classified wc WHERE wc.week=w.week)',"jsonb_build_object('kind','sentiment','value',sl.bucket)")}) FROM sentiment_labels sl),
          'reasons',(SELECT jsonb_object_agg(wrl.reason_id, CASE WHEN wrl.reason_id='missing_reason' THEN ${metric("(SELECT count(DISTINCT mi.instance_id||chr(31)||mi.profile_url) FROM weeks mi WHERE mi.week=w.week AND mi.manual_non_auto AND mi.sentiment IN ('negative','objection') AND NOT EXISTS (SELECT 1 FROM public.reply_review_reasons mr WHERE mr.message_id=mi.id))",'(SELECT coalesce(n,0) FROM weekly_manual_negative wm WHERE wm.week=w.week)',"jsonb_build_object('kind','reason','value',wrl.reason_id)")} ELSE ${metric('(SELECT coalesce(n,0) FROM weekly_reasons wr WHERE wr.week=w.week AND wr.reason_id=wrl.reason_id)','(SELECT coalesce(n,0) FROM weekly_manual_negative wm WHERE wm.week=w.week)',"jsonb_build_object('kind','reason','value',wrl.reason_id)")} END) FROM (SELECT unnest(ARRAY['no_need','timing','budget','existing_solution','offer_fit','wrong_person','trust_information','do_not_contact','other','missing_reason']) AS reason_id) wrl)) ORDER BY w.week) FROM weekly_rows w), '[]'::jsonb),
        'workflow', (SELECT jsonb_object_agg(wl.bucket, ${metric('(SELECT count(*) FROM workflow_bucketed wb WHERE wb.bucket=wl.bucket)','(SELECT count(*) FROM workflow_cohort)',"jsonb_build_object('kind','workflow','value',wl.bucket)")}) FROM workflow_labels wl) || jsonb_build_object('transfers', jsonb_build_object('numerator',(SELECT n FROM transfers),'denominator',(SELECT count(*) FROM workflow_cohort),'rate',CASE WHEN (SELECT count(*) FROM workflow_cohort)=0 THEN NULL ELSE ((SELECT n FROM transfers))::numeric/(SELECT count(*) FROM workflow_cohort) END,'drilldown',jsonb_build_object('kind','workflow','value','transfers'))),
        'comparison', coalesce((SELECT jsonb_agg(jsonb_build_object('kind',c.kind,'id',c.id,'volume',c.volume,'coverage',${metric('c.covered','c.volume',"jsonb_build_object('kind','coverage','value',c.kind)")},'neg_objection',${metric('c.neg_objection','c.volume',"jsonb_build_object('kind','sentiment','value','negative_objection')")},'top_reasons',(SELECT coalesce(jsonb_agg(jsonb_build_object('reason_id',cr.reason_id,'numerator',cr.n) ORDER BY cr.n DESC,cr.reason_id),'[]'::jsonb) FROM comparison_reasons cr WHERE cr.kind=c.kind AND cr.id=c.id AND (SELECT count(*) FROM comparison_reasons cr2 WHERE cr2.kind=cr.kind AND cr2.id=cr.id AND (cr2.n > cr.n OR (cr2.n=cr.n AND cr2.reason_id <= cr.reason_id))) <= 5)) ORDER BY c.kind,c.id) FROM comparison c),'[]'::jsonb),
        'dataset_at',clock_timestamp()
      ) AS result`,
      values: [params?.from ?? '', params?.to ?? '', ...filter.values],
    }
  },
  mapRow: (row: NeonRow): ReplyAnalyticsResponse => {
    const result = object(row.result)
    return {
      coverage: object(result.coverage) as ReplyAnalyticsResponse['coverage'], sentiment: object(result.sentiment) as ReplyAnalyticsResponse['sentiment'],
      reasons: object(result.reasons) as ReplyAnalyticsResponse['reasons'], weekly_trend: array(result.weekly_trend) as ReplyAnalyticsResponse['weekly_trend'],
      workflow: object(result.workflow) as ReplyAnalyticsResponse['workflow'], comparison: array(result.comparison) as ReplyAnalyticsResponse['comparison'], dataset_at: String(result.dataset_at ?? new Date(0).toISOString()),
    }
  },
}

export const mutationOperation: NeonQueryOperation<{ mutation_id: string; actor_id: string; payload_hash: string; result: unknown }, ReplyMutationParams> = {
  build: ({ params }) => ({ text: `SELECT mutation_id::text AS mutation_id, actor_id::text AS actor_id, payload_hash, result FROM public.reply_review_mutations WHERE mutation_id = $1::uuid`, values: [params?.mutationId ?? ''] }),
  mapRow: (row) => ({ mutation_id: String(row.mutation_id), actor_id: String(row.actor_id), payload_hash: String(row.payload_hash), result: row.result }),
}

export const reviewForMessageOperation: NeonQueryOperation<ReplyReviewDto, ReplyHistoryParams> = {
  build: ({ params }) => ({
    text: `SELECT r.message_id::text AS message_id, r.sentiment, r.intent_state, r.intent_level,
      r.comment, r.taxonomy_version, r.reviewed_by::text AS reviewed_by, r.provenance,
      r.reviewed_at, r.revision,
      coalesce((SELECT jsonb_agg(x.reason_id ORDER BY x.reason_id) FROM public.reply_review_reasons x WHERE x.message_id = r.message_id), '[]'::jsonb) AS reason_ids,
      (r.sentiment IS NOT NULL AND (r.sentiment NOT IN ('negative','objection') OR EXISTS (SELECT 1 FROM public.reply_review_reasons z WHERE z.message_id = r.message_id))) AS complete
      FROM public.reply_reviews r JOIN public.messages m ON m.id = r.message_id
      WHERE r.message_id = $1::bigint AND m.instance_id = $2 AND m.profile_url = $3`,
    values: [params?.messageId ?? null, params?.instanceId ?? '', params?.profileUrl ?? ''],
  }),
  mapRow: (row) => ({
    message_id: Number(row.message_id), sentiment: nullableText(row.sentiment) as ReplyReviewDto['sentiment'],
    intent_state: String(row.intent_state) as ReplyReviewDto['intent_state'], intent_level: nullableText(row.intent_level) as ReplyReviewDto['intent_level'],
    reason_ids: array(row.reason_ids).map(String) as ReplyReviewDto['reason_ids'], comment: nullableText(row.comment), taxonomy_version: String(row.taxonomy_version),
    reviewed_by: nullableText(row.reviewed_by), provenance: ['human', 'legacy_manual', 'system', 'machine'].includes(String(row.provenance)) ? String(row.provenance) as ReplyReviewDto['provenance'] : 'human', reviewed_at: nullableText(row.reviewed_at), revision: Number(row.revision), complete: row.complete === true,
  }),
}

export const workflowForThreadOperation: NeonQueryOperation<Record<string, unknown>, ReplyThreadParams> = {
  build: ({ params }) => ({ text: `SELECT s.instance_id, s.profile_url, s.action, s.owner_id, to_char(s.next_follow_up_date, 'YYYY-MM-DD') AS next_follow_up_date, s.do_not_contact, s.acknowledged_inbound_revision, coalesce(rs.inbound_revision, 0) AS inbound_revision, s.revision, s.supporting_message_id, s.updated_at, s.updated_by FROM public.conversation_follow_up_state s LEFT JOIN public.conversation_reply_review_state rs USING (instance_id, profile_url) WHERE s.instance_id = $1 AND s.profile_url = $2`, values: [params?.instanceId ?? '', params?.profileUrl ?? ''] }),
  mapRow: (row) => ({ ...row, owner_id: nullableNumber(row.owner_id), supporting_message_id: nullableNumber(row.supporting_message_id), revision: Number(row.revision ?? 0), acknowledged_inbound_revision: Number(row.acknowledged_inbound_revision ?? 0), inbound_revision: Number(row.inbound_revision ?? 0), do_not_contact: row.do_not_contact === true, next_follow_up_date: nullableText(row.next_follow_up_date), action: nullableText(row.action), updated_at: String(row.updated_at), updated_by: nullableText(row.updated_by) }),
}

export const messageForReviewOperation: NeonQueryOperation<{ id: number; direction: 'in' | 'out'; sent_at: string }, ReplyHistoryParams> = {
  build: ({ params }) => ({ text: `SELECT id::text AS id, direction, sent_at FROM public.messages WHERE id = $1::bigint AND instance_id = $2 AND profile_url = $3`, values: [params?.messageId ?? null, params?.instanceId ?? '', params?.profileUrl ?? ''] }),
  mapRow: (row) => ({ id: Number(row.id), direction: row.direction === 'out' ? 'out' : 'in', sent_at: String(row.sent_at) }),
}

export const threadExistsOperation: NeonQueryOperation<{ readonly exists: boolean }, ReplyThreadParams> = {
  build: ({ params }) => ({ text: `SELECT EXISTS (SELECT 1 FROM public.messages WHERE instance_id = $1 AND profile_url = $2) AS exists`, values: [params?.instanceId ?? '', params?.profileUrl ?? ''] }),
  mapRow: (row) => ({ exists: row.exists === true }),
}

export const inboundRevisionOperation: NeonQueryOperation<{ instance_id: string; profile_url: string; inbound_revision: number }, ReplyThreadParams> = {
  build: ({ params }) => ({ text: `SELECT instance_id, profile_url, inbound_revision FROM public.conversation_reply_review_state WHERE instance_id = $1 AND profile_url = $2`, values: [params?.instanceId ?? '', params?.profileUrl ?? ''] }),
  mapRow: (row) => ({ instance_id: String(row.instance_id), profile_url: String(row.profile_url), inbound_revision: Number(row.inbound_revision ?? 0) }),
}

export const allReplyReviewOperations = {
  capabilitiesOperation, inboxOperation, facetsOperation, threadOperation, analyticsOperation, reviewHistoryOperation, mutationOperation,
  reviewForMessageOperation, workflowForThreadOperation, messageForReviewOperation, inboundRevisionOperation, threadExistsOperation,
}

// Keep these references in this module so a changed enum cannot silently leave
// SQL vocabulary behind; the values are also useful to clean-room tests.
export const REPLY_REVIEW_ENUMS = Object.freeze({ sentiments: REPLY_SENTIMENTS, reasons: REPLY_REASON_IDS, actions: REPLY_ACTIONS })
