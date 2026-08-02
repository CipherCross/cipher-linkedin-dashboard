\set ON_ERROR_STOP on

-- These are catalog assertions, not authorization proofs. The migration
-- principal enters the owner role purely so unqualified/qualified object names
-- resolve; every privilege question below names its subject role explicitly and
-- is answered from the catalog, never from what this session can do.
SET ROLE app_owner;

-- Catalog shape: expected function and trigger counts, ownership, security
-- properties and fixed search_path on every function.
DO $$
DECLARE
  v_functions integer;
  v_triggers integer;
  v_owner_functions integer;
  v_ai_owned_functions integer;
  v_other_owner_functions integer;
  v_security_definer integer;
  v_missing_search_path integer;
  v_public_executable integer;
  v_ai_runner_owns_relations integer;
  v_ai_runner_bypass boolean;
  v_ai_runner_login boolean;
  v_ai_runner_super boolean;
  v_ai_runner_inherit boolean;
  v_runtime_owns_relations integer;
  v_runtime_bypass boolean;
  v_ai_policies integer;
  v_all_policies integer;
  v_trigger_names text[];
  v_function_names text[];
BEGIN
  SELECT count(*) INTO v_functions
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
;

  SELECT array_agg(p.proname ORDER BY p.proname) INTO v_function_names
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
;

  SELECT count(*) INTO v_triggers
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal;

  SELECT array_agg(t.tgname ORDER BY t.tgname) INTO v_trigger_names
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal;

  SELECT
    count(*) FILTER (WHERE r.rolname = 'app_owner'),
    count(*) FILTER (WHERE r.rolname = 'app_ai_runner'),
    count(*) FILTER (WHERE r.rolname NOT IN ('app_owner', 'app_ai_runner')),
    count(*) FILTER (WHERE p.prosecdef),
    count(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}'::text[])) AS cfg
      WHERE cfg LIKE 'search\_path=%'
    ))
  INTO v_owner_functions, v_ai_owned_functions, v_other_owner_functions,
       v_security_definer, v_missing_search_path
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE n.nspname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
;

  SELECT count(*) INTO v_public_executable
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND EXISTS (
      SELECT 1
      FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    );

  SELECT count(*) INTO v_ai_runner_owns_relations
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE n.nspname = 'public' AND r.rolname = 'app_ai_runner';

  SELECT count(*) INTO v_runtime_owns_relations
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE n.nspname = 'public' AND r.rolname = 'app_runtime';

  SELECT rolbypassrls, rolcanlogin, rolsuper, rolinherit
    INTO v_ai_runner_bypass, v_ai_runner_login, v_ai_runner_super, v_ai_runner_inherit
  FROM pg_roles WHERE rolname = 'app_ai_runner';

  SELECT rolbypassrls INTO v_runtime_bypass
  FROM pg_roles WHERE rolname = 'app_runtime';

  SELECT count(*) INTO v_ai_policies
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND p.polname = c.relname || '_ai_read'
    AND p.polcmd = 'r'
    AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'app_ai_runner')]::oid[]
    AND pg_get_expr(p.polqual, p.polrelid) = 'true';

  SELECT count(*) INTO v_all_policies
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public';

  IF v_functions <> 13
     OR v_triggers <> 12
     OR v_owner_functions <> 12
     OR v_ai_owned_functions <> 1
     OR v_other_owner_functions <> 0
     OR v_security_definer <> 8
     OR v_missing_search_path <> 0
     OR v_public_executable <> 0
     OR v_ai_runner_owns_relations <> 0
     OR v_runtime_owns_relations <> 0
     OR v_ai_runner_bypass
     OR v_ai_runner_login
     OR v_ai_runner_super
     OR v_ai_runner_inherit
     OR v_runtime_bypass
     OR v_ai_policies <> 25
     OR v_all_policies <> 52 THEN
    RAISE EXCEPTION 'function/trigger catalog mismatch: functions %, triggers %, owner/ai/other owners %/%/%, security definer %, missing search_path %, public executable %, ai/runtime owned relations %/%, ai runner bypass/login/super/inherit %/%/%/%, runtime bypass %, ai policies %, all policies %',
      v_functions, v_triggers, v_owner_functions, v_ai_owned_functions,
      v_other_owner_functions, v_security_definer, v_missing_search_path,
      v_public_executable, v_ai_runner_owns_relations, v_runtime_owns_relations,
      v_ai_runner_bypass, v_ai_runner_login, v_ai_runner_super, v_ai_runner_inherit,
      v_runtime_bypass, v_ai_policies, v_all_policies;
  END IF;

  IF v_function_names IS DISTINCT FROM ARRAY[
       'admin_update_team_member', 'ai_execute_sql', 'apply_follow_up_action',
       'archive_follow_up_after_last_lead', 'delete_manual_message',
       'is_active_team_member', 'is_app_admin', 'leads_keep_milestones',
       'pipeline_auto_advance', 'refresh_lead_age_estimate',
       'reset_lead_gender_on_input_change', 'set_hypothesis_campaigns',
       'touch_updated_at'
     ] THEN
    RAISE EXCEPTION 'function inventory mismatch: %', v_function_names;
  END IF;

  IF v_trigger_names IS DISTINCT FROM ARRAY[
       'archive_follow_up_on_last_lead_delete', 'leads_keep_milestones',
       'refresh_lead_age_estimate', 'reset_lead_gender_on_input_change',
       'touch_campaigns_updated_at', 'touch_hypotheses_updated_at',
       'touch_icp_industries_updated_at', 'touch_icp_personas_updated_at',
       'touch_icps_updated_at', 'touch_leads_updated_at',
       'touch_messages_updated_at', 'touch_saved_searches_updated_at'
     ] THEN
    RAISE EXCEPTION 'trigger inventory mismatch: %', v_trigger_names;
  END IF;
END
$$;

-- Per-function security properties match the source contract exactly.
DO $$
DECLARE
  expected record;
  v_secdef boolean;
  v_owner text;
  v_config text;
BEGIN
  -- The stored proconfig entry is matched by pattern because PostgreSQL quotes
  -- an empty search_path; both the quoted and bare spellings are the same fixed
  -- setting and neither is mutable at call time.
  FOR expected IN
    SELECT * FROM (VALUES
      ('admin_update_team_member(bigint,text,text,boolean)', true,  'app_owner',     '^search_path=("")?$'),
      ('ai_execute_sql(text)',                               true,  'app_ai_runner', '^search_path="?public"?$'),
      ('apply_follow_up_action(text,text,text,text,bigint,uuid,bigint,date,text)', true, 'app_owner', '^search_path="?public"?$'),
      ('archive_follow_up_after_last_lead()',                true,  'app_owner',     '^search_path="?public"?$'),
      ('delete_manual_message(bigint)',                      true,  'app_owner',     '^search_path="?public"?$'),
      ('is_active_team_member()',                            true,  'app_owner',     '^search_path=("")?$'),
      ('is_app_admin()',                                     true,  'app_owner',     '^search_path=("")?$'),
      ('leads_keep_milestones()',                            false, 'app_owner',     '^search_path=("")?$'),
      ('pipeline_auto_advance()',                            true,  'app_owner',     '^search_path="?public"?$'),
      ('refresh_lead_age_estimate()',                        false, 'app_owner',     '^search_path=("")?$'),
      ('reset_lead_gender_on_input_change()',                false, 'app_owner',     '^search_path=("")?$'),
      ('set_hypothesis_campaigns(bigint,text[])',            false, 'app_owner',     '^search_path="?public"?$'),
      ('touch_updated_at()',                                 false, 'app_owner',     '^search_path=("")?$')
    ) AS t(signature, secdef, owner, search_path_entry)
  LOOP
    SELECT p.prosecdef, r.rolname,
           (SELECT cfg FROM unnest(COALESCE(p.proconfig, '{}'::text[])) AS cfg WHERE cfg LIKE 'search\_path=%')
      INTO v_secdef, v_owner, v_config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'public'
      AND regexp_replace(p.oid::regprocedure::text, '^public\.', '') = expected.signature;

    IF NOT FOUND OR v_secdef IS NULL THEN
      RAISE EXCEPTION 'missing portable function %', expected.signature;
    END IF;
    IF v_secdef <> expected.secdef
       OR v_owner <> expected.owner
       OR v_config IS NULL
       OR v_config !~ expected.search_path_entry THEN
      RAISE EXCEPTION 'function % contract mismatch: secdef % (want %), owner % (want %), search_path % (want %)',
        expected.signature, v_secdef, expected.secdef, v_owner, expected.owner,
        v_config, expected.search_path_entry;
    END IF;
  END LOOP;
END
$$;

-- EXECUTE grants: exactly the source's final grant set, with the provider
-- service role mapped to app_runtime and the provider browser role mapped to
-- the read-only principal. Nothing is executable by PUBLIC, the AI sandbox or
-- the AI execution principal except the guard itself.
DO $$
DECLARE
  expected record;
  v_actual text[];
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('admin_update_team_member(bigint,text,text,boolean)', ARRAY['app_runtime']),
      ('ai_execute_sql(text)',                               ARRAY['app_system']),
      ('apply_follow_up_action(text,text,text,text,bigint,uuid,bigint,date,text)', ARRAY['app_runtime']),
      ('archive_follow_up_after_last_lead()',                ARRAY['app_runtime']),
      ('delete_manual_message(bigint)',                      ARRAY['app_runtime']),
      ('is_active_team_member()',                            ARRAY['app_readonly', 'app_runtime']),
      ('is_app_admin()',                                     ARRAY['app_readonly', 'app_runtime']),
      ('leads_keep_milestones()',                            ARRAY[]::text[]),
      ('pipeline_auto_advance()',                            ARRAY['app_runtime']),
      ('refresh_lead_age_estimate()',                        ARRAY[]::text[]),
      ('reset_lead_gender_on_input_change()',                ARRAY[]::text[]),
      ('set_hypothesis_campaigns(bigint,text[])',            ARRAY['app_runtime']),
      ('touch_updated_at()',                                 ARRAY[]::text[])
    ) AS t(signature, grantees)
  LOOP
    SELECT COALESCE(array_agg(DISTINCT g.rolname ORDER BY g.rolname), ARRAY[]::text[])
      INTO v_actual
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    JOIN pg_roles g ON g.oid = a.grantee
    WHERE n.nspname = 'public'
      AND regexp_replace(p.oid::regprocedure::text, '^public\.', '') = expected.signature
      AND a.privilege_type = 'EXECUTE'
      AND g.rolname NOT IN ('app_owner', 'app_ai_runner');

    IF v_actual IS DISTINCT FROM expected.grantees THEN
      RAISE EXCEPTION 'function % EXECUTE grants are % but should be %',
        expected.signature, v_actual, expected.grantees;
    END IF;
  END LOOP;
END
$$;

-- Privilege boundaries around the AI path.
DO $$
DECLARE
  v_bad text;
BEGIN
  -- The AI sandbox may not execute any function other than the guard it owns.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname <> 'ai_execute_sql'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND has_function_privilege('app_ai_runner', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'AI sandbox role can execute business functions: %', v_bad;
  END IF;

  -- Neither the runtime, the read-only nor any anonymous principal may reach
  -- the guard directly.
  IF has_function_privilege('app_runtime', 'public.ai_execute_sql(text)', 'EXECUTE')
     OR has_function_privilege('app_readonly', 'public.ai_execute_sql(text)', 'EXECUTE')
     OR has_function_privilege('app_migration', 'public.ai_execute_sql(text)', 'EXECUTE')
     OR has_function_privilege('app_machine', 'public.ai_execute_sql(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'AI SQL guard is reachable from a non-AI principal';
  END IF;

  -- The AI sandbox is SELECT-only everywhere: no write privilege on any
  -- relation and no sequence privilege that could seed one.
  SELECT string_agg(c.relname || ':' || priv, ', ') INTO v_bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS priv
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'v')
    AND has_table_privilege('app_ai_runner', c.oid, priv);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'AI sandbox role holds a write privilege: %', v_bad;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO v_bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'S'
    AND (has_sequence_privilege('app_ai_runner', c.oid, 'USAGE')
         OR has_sequence_privilege('app_ai_runner', c.oid, 'UPDATE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'AI sandbox role holds a sequence privilege: %', v_bad;
  END IF;

  -- The AI execution principal holds nothing except schema usage and the guard.
  SELECT string_agg(c.relname, ', ') INTO v_bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'v')
    AND has_table_privilege('app_system', c.oid, 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'AI execution principal can read tables directly: %', v_bad;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname <> 'ai_execute_sql'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND has_function_privilege('app_system', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'AI execution principal can execute business functions: %', v_bad;
  END IF;

  -- Schema-level boundary: the sandbox lost CREATE again after taking ownership
  -- of the guard, and no AI principal can create objects.
  IF has_schema_privilege('app_ai_runner', 'public', 'CREATE')
     OR has_schema_privilege('app_system', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'an AI principal retained CREATE on schema public';
  END IF;
  IF NOT has_schema_privilege('app_ai_runner', 'public', 'USAGE')
     OR NOT has_schema_privilege('app_system', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'an AI principal is missing USAGE on schema public';
  END IF;

  -- The canonical identity tables are outside the AI boundary entirely.
  IF has_table_privilege('app_ai_runner', 'public.users', 'SELECT')
     OR has_table_privilege('app_ai_runner', 'public.user_identities', 'SELECT') THEN
    RAISE EXCEPTION 'AI sandbox role can read canonical identity tables';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname IN ('users', 'user_identities')
      AND p.polroles @> ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'app_ai_runner')]::oid[]
  ) THEN
    RAISE EXCEPTION 'AI sandbox role has an identity table policy';
  END IF;
END
$$;

-- Column-level AI grants: the two tables the source restricted stay restricted,
-- so machine credentials in instances.config and member contact/role/identity
-- columns are unreachable from generated SQL.
DO $$
DECLARE
  v_team text[];
  v_instances text[];
  v_leaked text;
BEGIN
  SELECT COALESCE(array_agg(a.attname ORDER BY a.attname), ARRAY[]::text[]) INTO v_team
  FROM pg_attribute a
  WHERE a.attrelid = 'public.team_members'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('app_ai_runner', a.attrelid, a.attname, 'SELECT');

  SELECT COALESCE(array_agg(a.attname ORDER BY a.attname), ARRAY[]::text[]) INTO v_instances
  FROM pg_attribute a
  WHERE a.attrelid = 'public.instances'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('app_ai_runner', a.attrelid, a.attname, 'SELECT');

  IF v_team IS DISTINCT FROM ARRAY['active', 'created_at', 'id', 'name'] THEN
    RAISE EXCEPTION 'AI team_members column grants are %', v_team;
  END IF;
  IF v_instances IS DISTINCT FROM ARRAY['account_avatar', 'account_name', 'account_url',
                                        'agent_version', 'config_updated_at', 'created_at',
                                        'id', 'label', 'last_sync_at'] THEN
    RAISE EXCEPTION 'AI instances column grants are %', v_instances;
  END IF;

  SELECT string_agg(x.col, ', ') INTO v_leaked
  FROM (VALUES ('config')) AS x(col)
  WHERE has_column_privilege('app_ai_runner', 'public.instances'::regclass, x.col, 'SELECT');
  IF v_leaked IS NOT NULL THEN
    RAISE EXCEPTION 'AI sandbox role can read instances.%', v_leaked;
  END IF;
END
$$;

-- No provider schema, provider role or provider identity column was
-- reintroduced by the functions, triggers or the AI guard.
DO $$
DECLARE
  v_bad text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('auth', 'storage', 'supabase_migrations', 'extensions', 'graphql', 'realtime')) THEN
    RAISE EXCEPTION 'a provider schema exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'ai_sql_runner', 'supabase_admin', 'authenticator')) THEN
    RAISE EXCEPTION 'a provider role exists';
  END IF;

  -- MATERIALIZED keeps the schema/extension filter ahead of pg_get_functiondef,
  -- which errors on the aggregate entries the planner would otherwise reach.
  WITH portable AS MATERIALIZED (
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  )
  SELECT string_agg(portable.proname, ', ') INTO v_bad
  FROM portable
  WHERE pg_get_functiondef(portable.oid) ~* '(\yauth\.|\ystorage\.|supabase|postgrest|\yanon\y|\yauthenticated\y|service_role|ai_sql_runner)';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'provider marker inside function bodies: %', v_bad;
  END IF;
END
$$;

RESET ROLE;
SELECT 'portable functions, triggers and AI guard catalog assertions passed' AS result;
