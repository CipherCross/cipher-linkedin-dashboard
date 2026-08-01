\set ON_ERROR_STOP on

DO $$
DECLARE
  v_public_tables integer;
  v_rls_tables integer;
  v_runtime_owned integer;
  v_runtime_bypass boolean;
  v_runtime_login boolean;
  v_runtime_inherit boolean;
  v_runtime_memberships integer;
  v_identity_constraints integer;
  v_policy_count integer;
  v_user_id_type text;
  v_user_id_not_null boolean;
  v_public_schema_acl text;
  v_public_tables_acl integer;
  v_owner_relations integer;
  v_user_columns text[];
  v_mapping_columns text[];
BEGIN
  SELECT count(*) INTO v_public_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r';

  SELECT count(*) INTO v_rls_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity;

  SELECT count(*) INTO v_runtime_owned
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE n.nspname = 'public' AND r.rolname = 'app_runtime';

  SELECT rolbypassrls, rolcanlogin, rolinherit
    INTO v_runtime_bypass, v_runtime_login, v_runtime_inherit
  FROM pg_roles
  WHERE rolname = 'app_runtime';

  SELECT count(*) INTO v_runtime_memberships
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid
  WHERE r.rolname IN ('app_owner', 'app_runtime', 'app_readonly');

  SELECT count(*) INTO v_policy_count
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public';

  SELECT format_type(a.atttypid, a.atttypmod), a.attnotnull
    INTO v_user_id_type, v_user_id_not_null
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'team_members' AND a.attname = 'user_id';

  SELECT count(*) INTO v_identity_constraints
  FROM pg_constraint
  WHERE conname IN (
    'team_members_user_id_key',
    'team_members_user_id_fkey',
    'user_identities_pkey',
    'user_identities_provider_subject_key',
    'user_identities_user_id_fkey'
  );

  SELECT n.nspacl::text INTO v_public_schema_acl
  FROM pg_namespace n
  WHERE n.nspname = 'public';

  SELECT count(*) INTO v_public_tables_acl
  FROM aclexplode(COALESCE((
    SELECT c.relacl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'annotations'
  ), '{}'::aclitem[])) a
  WHERE a.grantee = 0;

  SELECT count(*) INTO v_owner_relations
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE n.nspname = 'public' AND r.rolname = 'app_owner';

  SELECT array_agg(a.attname ORDER BY a.attnum) INTO v_user_columns
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'users' AND a.attnum > 0 AND NOT a.attisdropped;

  SELECT array_agg(a.attname ORDER BY a.attnum) INTO v_mapping_columns
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'user_identities' AND a.attnum > 0 AND NOT a.attisdropped;

  IF v_public_tables <> 27
     OR v_rls_tables <> 27
     OR v_runtime_owned <> 0
     OR v_runtime_bypass
     OR v_runtime_login
     OR v_runtime_inherit
     OR v_runtime_memberships <> 0
     OR v_policy_count <> 27
     OR v_user_id_type <> 'uuid'
     OR NOT v_user_id_not_null
     OR v_identity_constraints <> 5
     OR v_public_schema_acl ~ '(^|,)='
     OR v_public_tables_acl <> 0
     OR v_owner_relations = 0
     OR v_user_columns IS DISTINCT FROM ARRAY['id', 'active', 'created_at', 'updated_at']
     OR v_mapping_columns IS DISTINCT FROM ARRAY['user_id', 'provider', 'provider_subject', 'created_at'] THEN
    RAISE EXCEPTION 'identity/RLS catalog mismatch: tables %, RLS %, runtime owners %, bypass %, login %, inherit %, memberships %, policies %, user_id %/% constraints %, public schema ACL %, public table ACL %, owner relations %, user columns %, mapping columns %',
      v_public_tables, v_rls_tables, v_runtime_owned, v_runtime_bypass,
      v_runtime_login, v_runtime_inherit, v_runtime_memberships, v_policy_count,
      v_user_id_type, v_user_id_not_null, v_identity_constraints, v_public_schema_acl,
      v_public_tables_acl, v_owner_relations, v_user_columns, v_mapping_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'team_members' AND a.attname = 'auth_user_id'
  ) THEN
    RAISE EXCEPTION 'provider-specific membership column exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conname = 'user_identities_user_id_fkey'
      AND con.contype = 'f'
      AND con.confdeltype = 'c'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conname = 'team_members_user_id_fkey'
      AND con.contype = 'f'
      AND con.confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'canonical user foreign-key delete actions are not CASCADE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_namespace
    WHERE nspname IN ('auth', 'storage', 'supabase_migrations')
  ) OR EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role', 'ai_sql_runner')
  ) THEN
    RAISE EXCEPTION 'provider-specific schemas or roles exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'portable S06 artifact added a user trigger';
  END IF;
END
$$;

DO $$
DECLARE
  v_missing_shared integer;
  v_bad_shared integer;
  v_bad_identity integer;
  v_rls_not_forced integer;
BEGIN
  SELECT count(*) INTO v_missing_shared
  FROM unnest(ARRAY[
    'annotations', 'briefing_jobs', 'briefings', 'messages',
    'campaign_steps', 'campaigns', 'coaching_digest', 'conversation_coaching',
    'conversation_follow_up_state', 'events', 'follow_up_events', 'hypotheses',
    'hypothesis_campaigns', 'icp_industries', 'icp_personas', 'icps', 'instances',
    'lead_gender_reviews', 'lead_notes', 'leads', 'pipeline_events', 'playbook',
    'saved_searches', 'sync_runs'
  ]) AS expected(relname)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = expected.relname
      AND p.polname = expected.relname || '_active_member'
  );

  SELECT count(*) INTO v_bad_shared
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'annotations', 'briefing_jobs', 'briefings', 'messages', 'campaign_steps',
      'campaigns', 'coaching_digest', 'conversation_coaching',
      'conversation_follow_up_state', 'events', 'follow_up_events', 'hypotheses',
      'hypothesis_campaigns', 'icp_industries', 'icp_personas', 'icps', 'instances',
      'lead_gender_reviews', 'lead_notes', 'leads', 'pipeline_events', 'playbook',
      'saved_searches', 'sync_runs'
    )
    AND (p.polroles @> ARRAY[
      (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime')::oid,
      (SELECT oid FROM pg_roles WHERE rolname = 'app_readonly')::oid
    ]::oid[]) IS NOT TRUE;

  SELECT count(*) INTO v_bad_identity
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('users', 'user_identities', 'team_members')
    AND p.polname <> c.relname || '_active_actor_select';

  SELECT count(*) INTO v_rls_not_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;

  IF v_missing_shared <> 0 OR v_bad_shared <> 0 OR v_bad_identity <> 0 OR v_rls_not_forced <> 0 THEN
    RAISE EXCEPTION 'policy catalog mismatch: missing shared %, bad shared %, bad identity %, forced RLS %',
      v_missing_shared, v_bad_shared, v_bad_identity, v_rls_not_forced;
  END IF;
END
$$;

SELECT 'portable identity, roles and RLS catalog assertions passed' AS result;
