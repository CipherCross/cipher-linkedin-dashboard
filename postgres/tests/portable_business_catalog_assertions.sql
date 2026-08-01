\set ON_ERROR_STOP on

DO $$
DECLARE
  v_tables integer;
  v_views integer;
  v_indexes integer;
  v_explicit_indexes integer;
  v_constraints integer;
  v_checks integer;
  v_primary_keys integer;
  v_unique integer;
  v_foreign_keys integer;
  v_identities integer;
  v_security_invoker_views integer;
  v_rls_tables integer;
  v_nulls_not_distinct integer;
  v_provider_roles integer;
  v_provider_schemas integer;
  v_view_names text[];
  v_expected_view_names text[] := ARRAY[
    'campaign_metrics',
    'campaign_reply_intent',
    'campaign_reply_sentiment',
    'conversation_latest_message',
    'conversation_reply_intent',
    'daily_activity',
    'pipeline_metrics'
  ];
BEGIN
  SELECT count(*) INTO v_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r';

  SELECT count(*) INTO v_views
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'v';

  SELECT count(*) INTO v_indexes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'i';

  SELECT count(*) INTO v_explicit_indexes
  FROM pg_class i
  JOIN pg_namespace n ON n.oid = i.relnamespace
  WHERE n.nspname = 'public'
    AND i.relkind = 'i'
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint con WHERE con.conindid = i.oid
    );

  SELECT count(*) INTO v_constraints
  FROM pg_constraint con
  JOIN pg_namespace n ON n.oid = con.connamespace
  WHERE n.nspname = 'public';

  SELECT count(*) FILTER (WHERE contype = 'c'),
         count(*) FILTER (WHERE contype = 'p'),
         count(*) FILTER (WHERE contype = 'u'),
         count(*) FILTER (WHERE contype = 'f')
    INTO v_checks, v_primary_keys, v_unique, v_foreign_keys
  FROM pg_constraint con
  JOIN pg_namespace n ON n.oid = con.connamespace
  WHERE n.nspname = 'public';

  SELECT count(*) INTO v_identities
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attidentity = 'a';

  SELECT count(*) INTO v_security_invoker_views
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'v'
    AND c.reloptions @> ARRAY['security_invoker=true'];

  SELECT count(*) INTO v_rls_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity;

  SELECT count(*) INTO v_nulls_not_distinct
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND i.indnullsnotdistinct;

  SELECT count(*) INTO v_provider_roles
  FROM pg_roles
  WHERE rolname IN ('anon', 'authenticated', 'service_role', 'ai_sql_runner');

  SELECT count(*) INTO v_provider_schemas
  FROM pg_namespace
  WHERE nspname IN ('auth', 'storage', 'supabase_migrations');

  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_view_names
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'v';

  IF v_tables <> 25 OR v_views <> 7 OR v_indexes <> 71 OR v_explicit_indexes <> 37
     OR v_constraints <> 125 OR v_checks <> 63 OR v_primary_keys <> 25
     OR v_unique <> 9 OR v_foreign_keys <> 28 OR v_identities <> 13
     OR v_security_invoker_views <> 7 OR v_rls_tables <> 0
     OR v_nulls_not_distinct <> 2 OR v_provider_roles <> 0 OR v_provider_schemas <> 0
     OR v_view_names IS DISTINCT FROM v_expected_view_names THEN
    RAISE EXCEPTION 'portable business catalog mismatch: tables %, views %, indexes %/% constraints % (checks %, pks %, unique %, fks %), identities %, security_invoker views %, rls tables %, nulls-not-distinct %, provider roles %, provider schemas %, view names %',
      v_tables, v_views, v_indexes, v_explicit_indexes, v_constraints, v_checks,
      v_primary_keys, v_unique, v_foreign_keys, v_identities, v_security_invoker_views,
      v_rls_tables, v_nulls_not_distinct, v_provider_roles, v_provider_schemas, v_view_names;
  END IF;
END
$$;

SELECT 'portable business catalog assertions passed' AS result;
