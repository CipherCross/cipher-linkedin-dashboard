-- Authenticated-data cutover.
--
-- IMPORTANT: apply this only after 050_auth_identity.sql is live, the first
-- admin is linked, and the auth-aware frontend/API deployment has passed its
-- pre-cutover checks. This migration intentionally removes all anonymous
-- dashboard reads.

do $$
declare
  v_table text;
  v_policy record;
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
    execute format('alter table public.%I enable row level security', v_table);

    for v_policy in
      select policyname
      from pg_catalog.pg_policies
      where schemaname = 'public'
        and tablename = v_table
        and cmd = 'SELECT'
    loop
      execute format(
        'drop policy if exists %I on public.%I',
        v_policy.policyname,
        v_table
      );
    end loop;

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_active_team_member())',
      'active members can read ' || v_table,
      v_table
    );

    execute format('revoke select on table public.%I from public, anon', v_table);
    execute format('grant select on table public.%I to authenticated', v_table);
  end loop;
end;
$$;

-- Views otherwise run with their owner's privileges and can bypass the RLS on
-- their base tables. PostgreSQL 15+ (Supabase) supports changing this option
-- without restating each view definition.
alter view public.campaign_metrics set (security_invoker = true);
alter view public.daily_activity set (security_invoker = true);
alter view public.campaign_reply_sentiment set (security_invoker = true);
alter view public.pipeline_metrics set (security_invoker = true);
alter view public.campaign_reply_intent set (security_invoker = true);
alter view public.conversation_reply_intent set (security_invoker = true);
alter view public.conversation_latest_message set (security_invoker = true);

revoke select on
  public.campaign_metrics,
  public.daily_activity,
  public.campaign_reply_sentiment,
  public.pipeline_metrics,
  public.campaign_reply_intent,
  public.conversation_reply_intent,
  public.conversation_latest_message
from public, anon;

grant select on
  public.campaign_metrics,
  public.daily_activity,
  public.campaign_reply_sentiment,
  public.pipeline_metrics,
  public.campaign_reply_intent,
  public.conversation_reply_intent,
  public.conversation_latest_message
to authenticated;
