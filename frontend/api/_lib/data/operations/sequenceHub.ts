import type { NeonQueryOperation, NeonRow } from '../neon.js'

export const SEQUENCE_HUB_OPERATION = 'sequences.hub'

export interface SequenceHubSnapshotRow {
  readonly items: readonly unknown[]
  readonly newestReplies: readonly unknown[]
}

const SQL = `WITH campaign_threads AS MATERIALIZED (
  SELECT l.campaign_id, l.instance_id, l.profile_url,
         max(l.full_name) AS full_name, max(l.company) AS company
    FROM public.leads l
   GROUP BY l.campaign_id, l.instance_id, l.profile_url
), inbound_ranked AS MATERIALIZED (
  SELECT t.campaign_id, t.instance_id, t.profile_url, t.full_name, t.company,
         m.body, m.sent_at, m.sentiment, m.intent_level,
         row_number() OVER (
           PARTITION BY t.campaign_id, t.instance_id, t.profile_url
           ORDER BY m.sent_at DESC, m.id DESC
         ) AS thread_rank
    FROM campaign_threads t
    JOIN public.messages m
      ON m.instance_id = t.instance_id AND m.profile_url = t.profile_url
   WHERE m.direction = 'in'
), latest_thread_replies AS MATERIALIZED (
  SELECT r.*,
         (lm.direction = 'in' OR (
           f.next_follow_up_date IS NOT NULL AND f.archived_at IS NULL
         )) AS needs_attention
    FROM inbound_ranked r
    LEFT JOIN public.conversation_latest_message lm
      ON lm.instance_id = r.instance_id AND lm.profile_url = r.profile_url
    LEFT JOIN public.conversation_follow_up_state f
      ON f.instance_id = r.instance_id AND f.profile_url = r.profile_url
   WHERE r.thread_rank = 1
), campaign_latest_reply AS MATERIALIZED (
  SELECT x.campaign_id,
         jsonb_build_object(
           'campaign_id', x.campaign_id,
           'instance_id', x.instance_id,
           'account_name', i.account_name,
           'profile_url', x.profile_url,
           'lead_name', x.full_name,
           'company', x.company,
           'body', x.body,
           'sent_at', x.sent_at,
           'sentiment', x.sentiment,
           'intent_level', x.intent_level,
           'needs_attention', x.needs_attention
         ) AS reply,
         x.sent_at
    FROM (
      SELECT r.*,
             row_number() OVER (
               PARTITION BY r.campaign_id ORDER BY r.sent_at DESC, r.profile_url
             ) AS campaign_rank
        FROM latest_thread_replies r
    ) x
    LEFT JOIN public.instances i ON i.id = x.instance_id
   WHERE x.campaign_rank = 1
), lead_stats AS MATERIALIZED (
  SELECT l.campaign_id,
         count(*)::int AS leads,
         count(*) FILTER (WHERE l.replied_at IS NOT NULL)::int AS replies
    FROM public.leads l
   GROUP BY l.campaign_id
), p3_stats AS MATERIALIZED (
  SELECT t.campaign_id,
         count(DISTINCT (m.instance_id, m.profile_url))::int AS p3
    FROM campaign_threads t
    JOIN public.messages m
      ON m.instance_id = t.instance_id AND m.profile_url = t.profile_url
   WHERE m.direction = 'in' AND m.intent_level = 'p3'
   GROUP BY t.campaign_id
), campaign_rollup AS MATERIALIZED (
  SELECT c.id AS campaign_id,
         c.name AS campaign_name,
         c.status AS campaign_status,
         c.runtime_status,
         c.is_archived,
         c.status_observed_at,
         c.status_source,
         c.status_raw,
         c.instance_id,
         i.account_name,
         i.account_avatar,
         i.last_sync_at,
         COALESCE(l.leads, 0) AS leads,
         COALESCE(l.replies, 0) AS replies,
         COALESCE(p.p3, 0) AS p3,
         r.reply AS latest_reply,
         r.sent_at AS latest_reply_at
    FROM public.campaigns c
    JOIN public.instances i ON i.id = c.instance_id
    LEFT JOIN lead_stats l ON l.campaign_id = c.id
    LEFT JOIN p3_stats p ON p.campaign_id = c.id
    LEFT JOIN campaign_latest_reply r ON r.campaign_id = c.id
), publish_ranked AS MATERIALIZED (
  SELECT j.sequence_document_id,
         j.sequence_revision,
         j.target_instance_id AS instance_id,
         j.status AS publish_status,
         j.queued_at,
         b.branch_id,
         b.branch_letter,
         b.campaign_name,
         CASE WHEN b.lh_campaign_id IS NULL THEN NULL
              ELSE j.target_instance_id || ':' || b.lh_campaign_id END AS campaign_id,
         CASE WHEN b.lh_campaign_id IS NULL
              THEN 'publish:' || j.id::text || ':' || b.branch_id
              ELSE j.target_instance_id || ':' || b.lh_campaign_id END AS deployment_key,
         row_number() OVER (
           PARTITION BY CASE WHEN b.lh_campaign_id IS NULL
             THEN 'publish:' || j.id::text || ':' || b.branch_id
             ELSE j.target_instance_id || ':' || b.lh_campaign_id END
           ORDER BY j.queued_at DESC, j.id DESC
         ) AS deployment_rank
    FROM public.sequence_publish_jobs j
    JOIN public.sequence_publish_branches b ON b.job_id = j.id
), deployment_rows AS MATERIALIZED (
  SELECT p.sequence_document_id,
         p.deployment_key AS key,
         'publish'::text AS lineage,
         p.campaign_id,
         p.campaign_name,
         p.instance_id,
         p.sequence_revision,
         p.branch_id,
         p.branch_letter,
         p.publish_status,
         p.queued_at
    FROM publish_ranked p
   WHERE p.deployment_rank = 1
     AND NOT EXISTS (
       SELECT 1 FROM public.campaign_sequence_links l WHERE l.campaign_id = p.campaign_id
     )
  UNION ALL
  SELECT l.sequence_document_id,
         l.campaign_id AS key,
         'explicit_link'::text AS lineage,
         l.campaign_id,
         c.name AS campaign_name,
         c.instance_id,
         NULL::integer AS sequence_revision,
         NULL::text AS branch_id,
         NULL::text AS branch_letter,
         NULL::text AS publish_status,
         l.linked_at AS queued_at
    FROM public.campaign_sequence_links l
    JOIN public.campaigns c ON c.id = l.campaign_id
), managed_items AS MATERIALIZED (
  SELECT jsonb_build_object(
           'id', 'managed:' || d.id::text,
           'kind', 'managed',
           'source', 'builder',
           'sequence_document_id', d.id::text,
           'name', d.name,
           'revision', d.revision,
           'archived', d.archived,
           'branch_count', CASE WHEN jsonb_typeof(d.document -> 'branches') = 'array'
             THEN jsonb_array_length(d.document -> 'branches') ELSE 0 END,
           'updated_at', d.updated_at,
           'deployments', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'key', r.key,
               'lineage', r.lineage,
               'campaign_id', r.campaign_id,
               'campaign_name', COALESCE(c.campaign_name, r.campaign_name),
               'campaign_status', c.campaign_status,
               'runtime_status', c.runtime_status,
               'is_archived', c.is_archived,
               'status_observed_at', c.status_observed_at,
               'status_source', c.status_source,
               'status_raw', c.status_raw,
               'instance_id', r.instance_id,
               'account_name', i.account_name,
               'account_avatar', i.account_avatar,
               'last_sync_at', i.last_sync_at,
               'sequence_revision', r.sequence_revision,
               'branch_id', r.branch_id,
               'branch_letter', r.branch_letter,
               'publish_status', r.publish_status,
               'awaiting_sync', r.campaign_id IS NOT NULL AND c.campaign_id IS NULL,
               'leads', COALESCE(c.leads, 0),
               'replies', COALESCE(c.replies, 0),
               'p3', COALESCE(c.p3, 0),
               'latest_reply', CASE WHEN c.latest_reply IS NULL THEN NULL ELSE
                 c.latest_reply || jsonb_build_object(
                   'sequence_id', d.id::text, 'sequence_name', d.name
                 ) END
             ) ORDER BY r.queued_at DESC, r.key)
               FROM deployment_rows r
               LEFT JOIN campaign_rollup c ON c.campaign_id = r.campaign_id
               LEFT JOIN public.instances i ON i.id = r.instance_id
              WHERE r.sequence_document_id = d.id
           ), '[]'::jsonb),
           'deployment_count', (SELECT count(*)::int FROM deployment_rows r WHERE r.sequence_document_id = d.id),
           'account_count', (SELECT count(DISTINCT r.instance_id)::int FROM deployment_rows r WHERE r.sequence_document_id = d.id),
           'leads', COALESCE((SELECT sum(c.leads)::int FROM deployment_rows r JOIN campaign_rollup c ON c.campaign_id = r.campaign_id WHERE r.sequence_document_id = d.id), 0),
           'replies', COALESCE((SELECT sum(c.replies)::int FROM deployment_rows r JOIN campaign_rollup c ON c.campaign_id = r.campaign_id WHERE r.sequence_document_id = d.id), 0),
           'p3', COALESCE((SELECT sum(c.p3)::int FROM deployment_rows r JOIN campaign_rollup c ON c.campaign_id = r.campaign_id WHERE r.sequence_document_id = d.id), 0),
           'latest_reply', (
             SELECT c.latest_reply || jsonb_build_object(
               'sequence_id', d.id::text, 'sequence_name', d.name
             )
               FROM deployment_rows r
               JOIN campaign_rollup c ON c.campaign_id = r.campaign_id
              WHERE r.sequence_document_id = d.id AND c.latest_reply IS NOT NULL
              ORDER BY c.latest_reply_at DESC LIMIT 1
           )
         ) AS item,
         d.updated_at AS sort_at
    FROM public.sequence_documents d
   WHERE d.archived = false
), external_items AS MATERIALIZED (
  SELECT jsonb_build_object(
           'id', 'external:' || c.campaign_id,
           'kind', 'external',
           'source', 'linked_helper',
           'sequence_document_id', NULL,
           'name', c.campaign_name,
           'revision', NULL,
           'archived', false,
           'branch_count', 0,
           'updated_at', c.last_sync_at,
           'deployments', jsonb_build_array(jsonb_build_object(
             'key', c.campaign_id,
             'lineage', 'external',
             'campaign_id', c.campaign_id,
             'campaign_name', c.campaign_name,
             'campaign_status', c.campaign_status,
             'runtime_status', c.runtime_status,
             'is_archived', c.is_archived,
             'status_observed_at', c.status_observed_at,
             'status_source', c.status_source,
             'status_raw', c.status_raw,
             'instance_id', c.instance_id,
             'account_name', c.account_name,
             'account_avatar', c.account_avatar,
             'last_sync_at', c.last_sync_at,
             'sequence_revision', NULL,
             'branch_id', NULL,
             'branch_letter', NULL,
             'publish_status', NULL,
             'awaiting_sync', false,
             'leads', c.leads,
             'replies', c.replies,
             'p3', c.p3,
             'latest_reply', CASE WHEN c.latest_reply IS NULL THEN NULL ELSE
               c.latest_reply || jsonb_build_object(
                 'sequence_id', NULL, 'sequence_name', c.campaign_name
               ) END
           )),
           'deployment_count', 1,
           'account_count', 1,
           'leads', c.leads,
           'replies', c.replies,
           'p3', c.p3,
           'latest_reply', CASE WHEN c.latest_reply IS NULL THEN NULL ELSE
             c.latest_reply || jsonb_build_object(
               'sequence_id', NULL, 'sequence_name', c.campaign_name
             ) END
         ) AS item,
         COALESCE(c.latest_reply_at, c.last_sync_at) AS sort_at
    FROM campaign_rollup c
   WHERE NOT EXISTS (
     SELECT 1 FROM deployment_rows r WHERE r.campaign_id = c.campaign_id
   )
), campaign_owner AS MATERIALIZED (
  SELECT r.campaign_id, d.id::text AS sequence_id, d.name AS sequence_name
    FROM deployment_rows r
    JOIN public.sequence_documents d ON d.id = r.sequence_document_id
   WHERE r.campaign_id IS NOT NULL
), attributed_replies AS MATERIALIZED (
  SELECT r.campaign_id,
         o.sequence_id,
         COALESCE(o.sequence_name, c.name) AS sequence_name,
         r.instance_id,
         i.account_name,
         r.profile_url,
         r.full_name AS lead_name,
         r.company,
         r.body,
         r.sent_at,
         r.sentiment,
         r.intent_level,
         r.needs_attention
    FROM latest_thread_replies r
    JOIN public.campaigns c ON c.id = r.campaign_id
    JOIN public.instances i ON i.id = r.instance_id
    LEFT JOIN campaign_owner o ON o.campaign_id = r.campaign_id
   WHERE r.needs_attention
     AND c.is_archived = false
)
SELECT jsonb_build_object(
  'items', COALESCE((
    SELECT jsonb_agg(x.item ORDER BY x.sort_at DESC NULLS LAST, x.item ->> 'name')
      FROM (
        SELECT * FROM managed_items
        UNION ALL
        SELECT * FROM external_items
      ) x
  ), '[]'::jsonb),
  'newestReplies', COALESCE((
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.sent_at DESC)
      FROM (
        SELECT * FROM attributed_replies ORDER BY sent_at DESC LIMIT 12
      ) r
  ), '[]'::jsonb)
) AS snapshot`

export const sequenceHubOperation: NeonQueryOperation<SequenceHubSnapshotRow> = {
  build: () => ({ text: SQL }),
  mapRow: (row: NeonRow): SequenceHubSnapshotRow =>
    (row.snapshot ?? { items: [], newestReplies: [] }) as SequenceHubSnapshotRow,
}
