-- Restore the service-only AI SQL reader after the authenticated RLS cutover.
--
-- 051 intentionally replaced every public/anon SELECT policy with an
-- authenticated-team-member policy. ai_execute_sql is SECURITY DEFINER and owned
-- by the NOLOGIN, SELECT-only ai_sql_runner role, so those policies also made its
-- base-table reads return zero rows. Security-invoker views such as
-- pipeline_metrics inherited the same empty result. Views created after migration
-- 034 additionally had no SELECT grant for ai_sql_runner and failed outright.
--
-- Keep the SQL guard least-privileged: add explicit SELECT policies and grants
-- instead of BYPASSRLS. The RPC itself remains executable by service_role only.

do $$
declare
  v_table text;
  v_tables constant text[] := array[
    'instances',
    'campaigns',
    'leads',
    'events',
    'sync_runs',
    'messages',
    'annotations',
    'campaign_steps',
    'conversation_coaching',
    'coaching_digest',
    'briefings',
    'playbook',
    'briefing_jobs',
    'team_members',
    'lead_notes',
    'pipeline_events',
    'saved_searches',
    'icps',
    'icp_personas',
    'icp_industries',
    'hypotheses',
    'hypothesis_campaigns',
    'follow_up_events',
    'conversation_follow_up_state',
    'lead_gender_reviews'
  ];
begin
  foreach v_table in array v_tables loop
    execute format(
      'drop policy if exists %I on public.%I',
      'ai sql runner can read',
      v_table
    );
    execute format(
      'create policy %I on public.%I for select to ai_sql_runner using (true)',
      'ai sql runner can read',
      v_table
    );
  end loop;
end;
$$;

-- Re-assert the intended analytical surface explicitly. Migration 034 disabled
-- default grants so every post-034 table/view must be opted in.
grant select on
  public.campaigns,
  public.leads,
  public.events,
  public.sync_runs,
  public.messages,
  public.annotations,
  public.campaign_steps,
  public.conversation_coaching,
  public.coaching_digest,
  public.briefings,
  public.playbook,
  public.briefing_jobs,
  public.lead_notes,
  public.pipeline_events,
  public.saved_searches,
  public.icps,
  public.icp_personas,
  public.icp_industries,
  public.hypotheses,
  public.hypothesis_campaigns,
  public.follow_up_events,
  public.conversation_follow_up_state,
  public.lead_gender_reviews
to ai_sql_runner;

grant select on
  public.campaign_metrics,
  public.daily_activity,
  public.campaign_reply_sentiment,
  public.pipeline_metrics,
  public.campaign_reply_intent,
  public.conversation_reply_intent,
  public.conversation_latest_message
to ai_sql_runner;

-- Keep authentication identity out of model-accessible SQL. Pipeline analysis
-- only needs the stable assignment directory fields.
revoke select on table public.team_members from ai_sql_runner;
grant select (id, name, active, created_at)
  on public.team_members to ai_sql_runner;

-- Preserve migration 034's column-level protection for instances.config while
-- making the allowed operational fields explicit for fresh databases.
revoke select on table public.instances from ai_sql_runner;
grant select (
  id,
  label,
  last_sync_at,
  agent_version,
  created_at,
  account_name,
  account_url,
  account_avatar,
  config_updated_at
) on public.instances to ai_sql_runner;
