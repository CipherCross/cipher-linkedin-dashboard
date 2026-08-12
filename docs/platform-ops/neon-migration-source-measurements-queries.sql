-- Neon migration S01: reproducible source measurements
--
-- Run this statement in the Supabase SQL Editor as Snapshot A. Run the same
-- statement again after one ordinary sync cycle (or an agreed interval) as
-- Snapshot B. Export or copy the single JSON result from each run.
--
-- The statement is read-only. It returns aggregate metadata only: no message
-- bodies, lead data, user email addresses, object names, URLs, or credentials.

WITH
captured AS (
  SELECT clock_timestamp() AS captured_at_utc
),
database_summary AS (
  SELECT
    current_database() AS database_name,
    current_setting('server_version') AS server_version,
    version() AS server_version_full,
    pg_database_size(current_database()) AS database_size_bytes,
    pg_size_pretty(pg_database_size(current_database())) AS database_size_pretty
),
table_size_rows AS (
  SELECT
    schemaname AS schema_name,
    relname AS table_name,
    n_live_tup::bigint AS estimated_row_count,
    pg_table_size(relid) AS table_size_bytes,
    pg_indexes_size(relid) AS index_size_bytes,
    pg_total_relation_size(relid) AS total_size_bytes
  FROM pg_stat_user_tables
),
exact_row_counts AS (
  SELECT 'instances'::text AS table_name, count(*)::bigint AS exact_row_count FROM public.instances
  UNION ALL
  SELECT 'campaigns', count(*)::bigint FROM public.campaigns
  UNION ALL
  SELECT 'leads', count(*)::bigint FROM public.leads
  UNION ALL
  SELECT 'messages', count(*)::bigint FROM public.messages
  UNION ALL
  SELECT 'events', count(*)::bigint FROM public.events
  UNION ALL
  SELECT 'annotations', count(*)::bigint FROM public.annotations
  UNION ALL
  SELECT 'team_members', count(*)::bigint FROM public.team_members
  UNION ALL
  SELECT 'conversation_follow_up_state', count(*)::bigint FROM public.conversation_follow_up_state
  UNION ALL
  SELECT 'follow_up_events', count(*)::bigint FROM public.follow_up_events
  UNION ALL
  SELECT 'sync_runs', count(*)::bigint FROM public.sync_runs
  UNION ALL
  SELECT 'campaign_steps', count(*)::bigint FROM public.campaign_steps
  UNION ALL
  SELECT 'conversation_coaching', count(*)::bigint FROM public.conversation_coaching
  UNION ALL
  SELECT 'coaching_digest', count(*)::bigint FROM public.coaching_digest
  UNION ALL
  SELECT 'briefings', count(*)::bigint FROM public.briefings
  UNION ALL
  SELECT 'briefing_jobs', count(*)::bigint FROM public.briefing_jobs
  UNION ALL
  SELECT 'playbook', count(*)::bigint FROM public.playbook
  UNION ALL
  SELECT 'lead_notes', count(*)::bigint FROM public.lead_notes
  UNION ALL
  SELECT 'pipeline_events', count(*)::bigint FROM public.pipeline_events
  UNION ALL
  SELECT 'saved_searches', count(*)::bigint FROM public.saved_searches
  UNION ALL
  SELECT 'icps', count(*)::bigint FROM public.icps
  UNION ALL
  SELECT 'icp_personas', count(*)::bigint FROM public.icp_personas
  UNION ALL
  SELECT 'icp_industries', count(*)::bigint FROM public.icp_industries
  UNION ALL
  SELECT 'hypotheses', count(*)::bigint FROM public.hypotheses
  UNION ALL
  SELECT 'hypothesis_campaigns', count(*)::bigint FROM public.hypothesis_campaigns
  UNION ALL
  SELECT 'lead_gender_reviews', count(*)::bigint FROM public.lead_gender_reviews
),
time_profile_rows AS (
  SELECT
    'leads'::text AS table_name,
    'added_at'::text AS timestamp_column,
    min(added_at) AS min_timestamp,
    max(added_at) AS max_timestamp,
    count(*) FILTER (WHERE added_at >= now() - interval '7 days')::bigint AS rows_last_7_days,
    count(*) FILTER (WHERE added_at >= now() - interval '30 days')::bigint AS rows_last_30_days,
    count(*) FILTER (WHERE added_at >= now() - interval '90 days')::bigint AS rows_last_90_days
  FROM public.leads
  UNION ALL
  SELECT
    'messages',
    'sent_at',
    min(sent_at),
    max(sent_at),
    count(*) FILTER (WHERE sent_at >= now() - interval '7 days')::bigint,
    count(*) FILTER (WHERE sent_at >= now() - interval '30 days')::bigint,
    count(*) FILTER (WHERE sent_at >= now() - interval '90 days')::bigint
  FROM public.messages
  UNION ALL
  SELECT
    'events',
    'occurred_at',
    min(occurred_at),
    max(occurred_at),
    count(*) FILTER (WHERE occurred_at >= now() - interval '7 days')::bigint,
    count(*) FILTER (WHERE occurred_at >= now() - interval '30 days')::bigint,
    count(*) FILTER (WHERE occurred_at >= now() - interval '90 days')::bigint
  FROM public.events
  UNION ALL
  SELECT
    'annotations',
    'created_at',
    min(created_at),
    max(created_at),
    count(*) FILTER (WHERE created_at >= now() - interval '7 days')::bigint,
    count(*) FILTER (WHERE created_at >= now() - interval '30 days')::bigint,
    count(*) FILTER (WHERE created_at >= now() - interval '90 days')::bigint
  FROM public.annotations
  UNION ALL
  SELECT
    'sync_runs',
    'started_at',
    min(started_at),
    max(started_at),
    count(*) FILTER (WHERE started_at >= now() - interval '7 days')::bigint,
    count(*) FILTER (WHERE started_at >= now() - interval '30 days')::bigint,
    count(*) FILTER (WHERE started_at >= now() - interval '90 days')::bigint
  FROM public.sync_runs
  UNION ALL
  SELECT
    'follow_up_events',
    'occurred_at',
    min(occurred_at),
    max(occurred_at),
    count(*) FILTER (WHERE occurred_at >= now() - interval '7 days')::bigint,
    count(*) FILTER (WHERE occurred_at >= now() - interval '30 days')::bigint,
    count(*) FILTER (WHERE occurred_at >= now() - interval '90 days')::bigint
  FROM public.follow_up_events
  UNION ALL
  SELECT
    'pipeline_events',
    'occurred_at',
    min(occurred_at),
    max(occurred_at),
    count(*) FILTER (WHERE occurred_at >= now() - interval '7 days')::bigint,
    count(*) FILTER (WHERE occurred_at >= now() - interval '30 days')::bigint,
    count(*) FILTER (WHERE occurred_at >= now() - interval '90 days')::bigint
  FROM public.pipeline_events
  UNION ALL
  SELECT
    'lead_notes',
    'created_at',
    min(created_at),
    max(created_at),
    count(*) FILTER (WHERE created_at >= now() - interval '7 days')::bigint,
    count(*) FILTER (WHERE created_at >= now() - interval '30 days')::bigint,
    count(*) FILTER (WHERE created_at >= now() - interval '90 days')::bigint
  FROM public.lead_notes
  UNION ALL
  SELECT
    'briefings',
    'created_at',
    min(created_at),
    max(created_at),
    count(*) FILTER (WHERE created_at >= now() - interval '7 days')::bigint,
    count(*) FILTER (WHERE created_at >= now() - interval '30 days')::bigint,
    count(*) FILTER (WHERE created_at >= now() - interval '90 days')::bigint
  FROM public.briefings
  UNION ALL
  SELECT
    'campaigns',
    'created_at',
    min(created_at),
    max(created_at),
    count(*) FILTER (WHERE created_at >= now() - interval '7 days')::bigint,
    count(*) FILTER (WHERE created_at >= now() - interval '30 days')::bigint,
    count(*) FILTER (WHERE created_at >= now() - interval '90 days')::bigint
  FROM public.campaigns
),
storage_bucket_rows AS (
  SELECT
    b.id::text AS bucket_id,
    count(o.id)::bigint AS object_count,
    coalesce(
      sum(
        CASE
          WHEN (o.metadata ->> 'size') ~ '^[0-9]+$'
            THEN (o.metadata ->> 'size')::numeric
          ELSE 0
        END
      ),
      0
    ) AS object_size_bytes
  FROM storage.buckets AS b
  LEFT JOIN storage.objects AS o
    ON o.bucket_id = b.id
  GROUP BY b.id
),
extension_rows AS (
  SELECT
    e.extname AS extension_name,
    e.extversion AS extension_version,
    n.nspname AS extension_schema
  FROM pg_extension AS e
  JOIN pg_namespace AS n
    ON n.oid = e.extnamespace
),
database_write_stats AS (
  SELECT
    stats_reset,
    xact_commit,
    xact_rollback,
    tup_returned,
    tup_fetched,
    tup_inserted,
    tup_updated,
    tup_deleted,
    conflicts,
    deadlocks,
    temp_files,
    temp_bytes,
    blks_read,
    blks_hit,
    blk_read_time,
    blk_write_time
  FROM pg_stat_database
  WHERE datname = current_database()
),
migration_summary AS (
  SELECT
    count(*)::bigint AS applied_migration_count,
    min(version) AS first_migration_version,
    max(version) AS current_migration_version
  FROM supabase_migrations.schema_migrations
),
migration_versions AS (
  SELECT coalesce(jsonb_agg(version ORDER BY version), '[]'::jsonb) AS versions
  FROM supabase_migrations.schema_migrations
)
SELECT jsonb_build_object(
  'snapshot_format_version', 1,
  'captured_at_utc', (SELECT captured_at_utc FROM captured),
  'database', (SELECT to_jsonb(database_summary) FROM database_summary),
  'table_sizes', (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'schema', schema_name,
          'table', table_name,
          'estimated_row_count', estimated_row_count,
          'table_size_bytes', table_size_bytes,
          'index_size_bytes', index_size_bytes,
          'total_size_bytes', total_size_bytes,
          'total_size_pretty', pg_size_pretty(total_size_bytes)
        )
        ORDER BY total_size_bytes DESC, schema_name, table_name
      ),
      '[]'::jsonb
    )
    FROM table_size_rows
  ),
  'exact_public_row_counts', (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'table', table_name,
          'exact_row_count', exact_row_count
        )
        ORDER BY exact_row_count DESC, table_name
      ),
      '[]'::jsonb
    )
    FROM exact_row_counts
  ),
  'time_profiles', (
    SELECT coalesce(
      jsonb_agg(to_jsonb(time_profile_rows) ORDER BY table_name),
      '[]'::jsonb
    )
    FROM time_profile_rows
  ),
  'storage', jsonb_build_object(
    'buckets', (
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'bucket_id', bucket_id,
            'object_count', object_count,
            'object_size_bytes', object_size_bytes,
            'object_size_pretty', pg_size_pretty(object_size_bytes::bigint)
          )
          ORDER BY bucket_id
        ),
        '[]'::jsonb
      )
      FROM storage_bucket_rows
    ),
    'total_object_count', (
      SELECT coalesce(sum(object_count), 0)::bigint
      FROM storage_bucket_rows
    ),
    'total_object_size_bytes', (
      SELECT coalesce(sum(object_size_bytes), 0)
      FROM storage_bucket_rows
    ),
    'total_object_size_pretty', (
      SELECT pg_size_pretty(coalesce(sum(object_size_bytes), 0)::bigint)
      FROM storage_bucket_rows
    )
  ),
  'extensions', (
    SELECT coalesce(
      jsonb_agg(to_jsonb(extension_rows) ORDER BY extension_name),
      '[]'::jsonb
    )
    FROM extension_rows
  ),
  'pg_stat_database', (
    SELECT to_jsonb(database_write_stats)
    FROM database_write_stats
  ),
  'migration_summary', (
    SELECT to_jsonb(migration_summary)
    FROM migration_summary
  ),
  'migration_versions', (
    SELECT versions
    FROM migration_versions
  )
) AS source_measurement_snapshot;
