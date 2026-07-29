\set ON_ERROR_STOP on

do $assertions$
declare
  expected_tables constant text[] := array[
    'annotations', 'briefing_jobs', 'briefings', 'campaign_steps', 'campaigns',
    'coaching_digest', 'conversation_coaching', 'conversation_follow_up_state',
    'events', 'follow_up_events', 'hypotheses', 'hypothesis_campaigns',
    'icp_industries', 'icp_personas', 'icps', 'instances',
    'lead_gender_reviews', 'lead_notes', 'leads', 'messages',
    'pipeline_events', 'playbook', 'saved_searches', 'sync_runs', 'team_members'
  ];
  expected_views constant text[] := array[
    'campaign_metrics', 'campaign_reply_intent', 'campaign_reply_sentiment',
    'conversation_latest_message', 'conversation_reply_intent',
    'daily_activity', 'pipeline_metrics'
  ];
  expected_functions constant text[] := array[
    'admin_update_team_member(p_member_id bigint, p_name text, p_role text, p_active boolean)',
    'ai_execute_sql(query text)',
    'apply_follow_up_action(p_action text, p_instance_id text, p_profile_url text, p_actor text, p_expected_revision bigint, p_mutation_id uuid, p_owner_id bigint, p_next_follow_up_date date, p_reason text)',
    'archive_follow_up_after_last_lead()',
    'delete_manual_message(p_message_id bigint)',
    'is_active_team_member()',
    'is_app_admin()',
    'leads_keep_milestones()',
    'pipeline_auto_advance()',
    'refresh_lead_age_estimate()',
    'reset_lead_gender_on_input_change()',
    'set_hypothesis_campaigns(p_hypothesis_id bigint, p_campaign_ids text[])',
    'touch_updated_at()'
  ];
  expected_triggers constant text[] := array[
    'archive_follow_up_on_last_lead_delete', 'leads_keep_milestones',
    'refresh_lead_age_estimate', 'reset_lead_gender_on_input_change',
    'touch_campaigns_updated_at', 'touch_hypotheses_updated_at',
    'touch_icp_industries_updated_at', 'touch_icp_personas_updated_at',
    'touch_icps_updated_at', 'touch_leads_updated_at',
    'touch_messages_updated_at', 'touch_saved_searches_updated_at'
  ];
  actual text[];
  object_name text;
  row_count bigint;
  function_definition text;
begin
  select array_agg(c.relname order by c.relname)
    into actual
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r';
  if actual is distinct from expected_tables then
    raise exception 'table inventory mismatch: %', actual;
  end if;

  select array_agg(c.relname order by c.relname)
    into actual
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v';
  if actual is distinct from expected_views then
    raise exception 'view inventory mismatch: %', actual;
  end if;

  select array_agg(
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           order by p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
         )
    into actual
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  left join pg_depend d
    on d.classid = 'pg_proc'::regclass
   and d.objid = p.oid
   and d.deptype = 'e'
  where n.nspname = 'public'
    and d.objid is null;
  if actual is distinct from expected_functions then
    raise exception 'function inventory mismatch: %', actual;
  end if;

  select array_agg(t.tgname order by t.tgname)
    into actual
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and not t.tgisinternal;
  if actual is distinct from expected_triggers then
    raise exception 'trigger inventory mismatch: %', actual;
  end if;

  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
  ) then
    raise exception 'every public table must have RLS enabled';
  end if;

  foreach object_name in array expected_tables loop
    if (
      select count(*)
      from pg_policies
      where schemaname = 'public' and tablename = object_name
    ) <> 2 then
      raise exception 'expected exactly two policies on %', object_name;
    end if;

    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = object_name
        and cmd = 'SELECT'
        and roles = array['authenticated']::name[]
        and qual = 'is_active_team_member()'
    ) then
      raise exception 'missing authenticated member policy on %', object_name;
    end if;

    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = object_name
        and cmd = 'SELECT'
        and roles = array['ai_sql_runner']::name[]
        and qual = 'true'
    ) then
      raise exception 'missing AI reader policy on %', object_name;
    end if;

    if not has_table_privilege(
      'authenticated', format('public.%I', object_name), 'SELECT'
    ) then
      raise exception 'authenticated lacks SELECT on %', object_name;
    end if;

    if has_table_privilege('anon', format('public.%I', object_name), 'SELECT') then
      raise exception 'anon unexpectedly has SELECT on %', object_name;
    end if;

    if exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(
        coalesce(c.relacl, acldefault('r', c.relowner))
      ) acl
      where n.nspname = 'public'
        and c.relname = object_name
        and acl.grantee = 0
        and acl.privilege_type = 'SELECT'
    ) then
      raise exception 'PUBLIC unexpectedly has SELECT on %', object_name;
    end if;

    execute format('select count(*) from public.%I', object_name)
      into row_count;
    if row_count <> 0 then
      raise exception 'business table % is not empty', object_name;
    end if;

    if object_name not in ('instances', 'team_members') then
      if not has_table_privilege(
        'ai_sql_runner', format('public.%I', object_name), 'SELECT'
      ) then
        raise exception 'AI reader lacks SELECT on %', object_name;
      end if;
    end if;

    if exists (
      select 1
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = object_name
        and grantee = 'ai_sql_runner'
        and privilege_type <> 'SELECT'
    ) then
      raise exception 'AI reader has a write privilege on %', object_name;
    end if;
  end loop;

  foreach object_name in array expected_views loop
    if not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = object_name
        and c.relkind = 'v'
        and c.reloptions @> array['security_invoker=true']
    ) then
      raise exception 'view % is not security_invoker', object_name;
    end if;

    if not has_table_privilege(
      'authenticated', format('public.%I', object_name), 'SELECT'
    ) or not has_table_privilege(
      'ai_sql_runner', format('public.%I', object_name), 'SELECT'
    ) then
      raise exception 'missing authenticated/AI SELECT on view %', object_name;
    end if;

    if has_table_privilege('anon', format('public.%I', object_name), 'SELECT') then
      raise exception 'anon unexpectedly has SELECT on view %', object_name;
    end if;

    if exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(
        coalesce(c.relacl, acldefault('r', c.relowner))
      ) acl
      where n.nspname = 'public'
        and c.relname = object_name
        and acl.grantee = 0
        and acl.privilege_type = 'SELECT'
    ) then
      raise exception 'PUBLIC unexpectedly has SELECT on view %', object_name;
    end if;
  end loop;

  if has_table_privilege('ai_sql_runner', 'public.instances', 'SELECT')
     or has_table_privilege('ai_sql_runner', 'public.team_members', 'SELECT') then
    raise exception 'AI reader has forbidden whole-table access';
  end if;

  foreach object_name in array array[
    'id', 'label', 'last_sync_at', 'agent_version', 'created_at',
    'account_name', 'account_url', 'account_avatar', 'config_updated_at'
  ] loop
    if not has_column_privilege(
      'ai_sql_runner', 'public.instances', object_name, 'SELECT'
    ) then
      raise exception 'AI reader lacks instances.%', object_name;
    end if;
  end loop;

  foreach object_name in array array['config'] loop
    if has_column_privilege(
      'ai_sql_runner', 'public.instances', object_name, 'SELECT'
    ) then
      raise exception 'AI reader can read instances.%', object_name;
    end if;
  end loop;

  foreach object_name in array array['id', 'name', 'active', 'created_at'] loop
    if not has_column_privilege(
      'ai_sql_runner', 'public.team_members', object_name, 'SELECT'
    ) then
      raise exception 'AI reader lacks team_members.%', object_name;
    end if;
  end loop;

  foreach object_name in array array['auth_user_id', 'email', 'role'] loop
    if has_column_privilege(
      'ai_sql_runner', 'public.team_members', object_name, 'SELECT'
    ) then
      raise exception 'AI reader can read team_members.%', object_name;
    end if;
  end loop;

  if exists (
    select 1
    from pg_default_acl d
    cross join lateral aclexplode(d.defaclacl) acl
    where d.defaclnamespace = 'public'::regnamespace
      and d.defaclobjtype = 'r'
      and acl.grantee = 'ai_sql_runner'::regrole
  ) then
    raise exception 'AI reader has default privileges on future tables';
  end if;

  if has_schema_privilege('ai_sql_runner', 'auth', 'USAGE') then
    raise exception 'AI reader unexpectedly has Auth schema access';
  end if;

  if not exists (
    select 1
    from pg_roles
    where rolname = 'ai_sql_runner'
      and not rolcanlogin
      and not rolbypassrls
      and not rolsuper
      and not rolcreaterole
      and not rolcreatedb
  ) then
    raise exception 'ai_sql_runner role attributes are unsafe';
  end if;

  if not exists (
    select 1
    from pg_proc
    where oid = 'public.ai_execute_sql(text)'::regprocedure
      and pg_get_userbyid(proowner) = 'ai_sql_runner'
      and prosecdef
      and proconfig @> array['search_path=public']
  ) then
    raise exception 'ai_execute_sql owner/security/search_path mismatch';
  end if;

  foreach object_name in array array[
    'public.ai_execute_sql(text)',
    'public.pipeline_auto_advance()',
    'public.delete_manual_message(bigint)',
    'public.set_hypothesis_campaigns(bigint,text[])',
    'public.apply_follow_up_action(text,text,text,text,bigint,uuid,bigint,date,text)',
    'public.admin_update_team_member(bigint,text,text,boolean)'
  ] loop
    if not has_function_privilege('service_role', object_name, 'EXECUTE')
       or has_function_privilege('anon', object_name, 'EXECUTE')
       or has_function_privilege('authenticated', object_name, 'EXECUTE') then
      raise exception 'service-only execute boundary mismatch for %', object_name;
    end if;
  end loop;

  foreach object_name in array array[
    'public.is_active_team_member()', 'public.is_app_admin()'
  ] loop
    if not has_function_privilege('authenticated', object_name, 'EXECUTE')
       or has_function_privilege('anon', object_name, 'EXECUTE') then
      raise exception 'authenticated helper execute boundary mismatch for %',
        object_name;
    end if;
  end loop;

  foreach object_name in array array[
    'public.admin_update_team_member(bigint,text,text,boolean)',
    'public.is_active_team_member()',
    'public.is_app_admin()'
  ] loop
    if not exists (
      select 1
      from pg_proc
      where oid = object_name::regprocedure
        and prosecdef
        and proconfig @> array['search_path=""']
    ) then
      raise exception 'hardened empty search_path missing for %', object_name;
    end if;
  end loop;

  foreach object_name in array array[
    'public.pipeline_auto_advance()',
    'public.delete_manual_message(bigint)',
    'public.apply_follow_up_action(text,text,text,text,bigint,uuid,bigint,date,text)',
    'public.archive_follow_up_after_last_lead()'
  ] loop
    if not exists (
      select 1
      from pg_proc
      where oid = object_name::regprocedure
        and prosecdef
        and proconfig @> array['search_path=public']
    ) then
      raise exception 'SECURITY DEFINER/search_path mismatch for %', object_name;
    end if;
  end loop;

  select pg_get_functiondef(
    'public.apply_follow_up_action(text,text,text,text,bigint,uuid,bigint,date,text)'::regprocedure
  ) into function_definition;
  if function_definition not like '%jsonb_build_array(p_instance_id, p_profile_url)%'
     or function_definition like '%chr(0)%'
     or function_definition like '%pg_get_functiondef%' then
    raise exception 'apply_follow_up_action does not contain the final v053 lock';
  end if;

  select pg_get_functiondef(
    'public.archive_follow_up_after_last_lead()'::regprocedure
  ) into function_definition;
  if function_definition not like '%jsonb_build_array(old.instance_id, old.profile_url)%'
     or function_definition like '%chr(0)%'
     or function_definition like '%pg_get_functiondef%' then
    raise exception 'archive_follow_up_after_last_lead does not contain the final v053 lock';
  end if;

  select pg_get_functiondef('public.ai_execute_sql(text)'::regprocedure)
    into function_definition;
  if function_definition not like '%limit 1000%' then
    raise exception 'ai_execute_sql final bounded guard mismatch';
  end if;

  if (
    select count(*)
    from storage.buckets
    where id = 'lead-photos'
      and name = 'lead-photos'
      and public = false
  ) <> 1 then
    raise exception 'private lead-photos bucket is missing';
  end if;

  if exists (select 1 from storage.buckets where id = 'agent' or name = 'agent') then
    raise exception 'internal agent bucket leaked into tenant';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and roles && array['anon']::name[]
  ) then
    raise exception 'anonymous Storage object policy exists';
  end if;

  if (
    select count(*)
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'active members can read lead photos'
      and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
      and qual like '%bucket_id%lead-photos%'
      and qual like '%is_active_team_member%'
  ) <> 1 then
    raise exception 'authenticated lead-photo Storage policy is missing or malformed';
  end if;

  if not exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '053'
  ) or exists (
    select 1
    from supabase_migrations.schema_migrations
    where version < '053'
  ) then
    raise exception 'tenant migration ledger does not begin at 053';
  end if;
end
$assertions$;
