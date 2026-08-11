\set ON_ERROR_STOP on

-- The `rls_role_boundaries` data smoke, for a LIVE tenant database.
--
-- WHY THIS IS NOT ONE OF THE CLEANROOM CATALOG ASSERTIONS
--
-- The four portable_*_catalog_assertions.sql artifacts are stage-scoped: each
-- belongs to the cleanroom harness that applies its own step and asserts EXACT
-- counts for the state right after it. portable_business_catalog_assertions.sql,
-- for instance, requires `tables = 25` and `rls_tables = 0`, which is true only
-- after step 001 and before 002 adds RLS. Run against a tenant at baseline 053
-- plus migration 054 they all fail by construction, and they additionally
-- require `provider_roles = 0` and `provider_schemas = 0`, which a managed
-- provider's own roles and schemas break on their own.
--
-- A cleanroom can assert exact counts because it owns the whole cluster. A live
-- smoke cannot, so this asserts INVARIANTS instead: properties that hold for the
-- finished schema, stay true as later steps are added, and say nothing about
-- objects the provider brought with it. It fails closed — every check raises.
--
-- Reads only the catalog, mutates nothing, and is safe to repeat.

DO $$
DECLARE
  v_public_tables integer;
  v_rls_tables integer;
  v_rls_missing text[];
  v_policy_count integer;
  v_unpolicied text[];
  v_privileged text[];
  v_non_owner_relations text[];
  v_migration_owned integer;
  v_public_acl_roles text[];
  v_expected_acl_roles text[] := ARRAY[
    'app_ai_runner', 'app_machine', 'app_owner', 'app_readonly', 'app_runtime', 'app_system'
  ];
  v_public_executable integer;
  v_ledger_present boolean;
  v_ledger_readable_by_runtime boolean;
BEGIN
  -- 1. Every business table in public carries RLS. After step 002 this is a
  --    property of the schema, not a count, so it survives later steps.
  SELECT count(*) INTO v_public_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r';

  SELECT count(*), coalesce(array_agg(c.relname ORDER BY c.relname)
                            FILTER (WHERE NOT c.relrowsecurity), ARRAY[]::text[])
    INTO v_rls_tables, v_rls_missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity;

  SELECT coalesce(array_agg(c.relname ORDER BY c.relname), ARRAY[]::text[])
    INTO v_rls_missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;

  IF v_public_tables = 0 THEN
    RAISE EXCEPTION 'live rls boundary: public holds no tables, so the baseline is not applied';
  END IF;
  IF array_length(v_rls_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'live rls boundary: RLS is off on %', array_to_string(v_rls_missing, ', ');
  END IF;

  -- 2. Every RLS table actually has at least one policy. RLS with no policy
  --    denies everything, which is safe but would mean the tenant is unusable.
  SELECT coalesce(array_agg(c.relname ORDER BY c.relname), ARRAY[]::text[])
    INTO v_unpolicied
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);
  IF array_length(v_unpolicied, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'live rls boundary: no policy on %', array_to_string(v_unpolicied, ', ');
  END IF;

  SELECT count(*) INTO v_policy_count
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public';
  IF v_policy_count < v_public_tables THEN
    RAISE EXCEPTION 'live rls boundary: % policies for % tables', v_policy_count, v_public_tables;
  END IF;

  -- 3. No role in the seven-role contract may bypass RLS or be a superuser.
  --    This is the one check that must NOT be widened to every role in the
  --    cluster: a managed provider's own principals are outside our contract.
  SELECT coalesce(array_agg(rolname ORDER BY rolname), ARRAY[]::text[])
    INTO v_privileged
  FROM pg_roles
  WHERE rolname IN ('app_owner', 'app_migration', 'app_runtime', 'app_readonly',
                    'app_machine', 'app_system', 'app_ai_runner', 'identity_store')
    AND (rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb);
  IF array_length(v_privileged, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'live rls boundary: over-privileged role(s) %', array_to_string(v_privileged, ', ');
  END IF;

  -- 4. app_owner owns the business objects and app_migration owns nothing, so a
  --    dump/restore carries the same ownership graph.
  SELECT coalesce(array_agg(c.relname || ' owned by ' || r.rolname ORDER BY c.relname), ARRAY[]::text[])
    INTO v_non_owner_relations
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'S')
    AND r.rolname <> 'app_owner';
  IF array_length(v_non_owner_relations, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'live rls boundary: public objects not owned by app_owner: %',
      array_to_string(v_non_owner_relations, ', ');
  END IF;

  SELECT count(*) INTO v_migration_owned
  FROM pg_class c
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE r.rolname = 'app_migration';
  IF v_migration_owned <> 0 THEN
    RAISE EXCEPTION 'live rls boundary: app_migration owns % object(s)', v_migration_owned;
  END IF;

  -- 5. The public schema is reachable only by the contract's own roles. PUBLIC
  --    must not appear, which is what closes anonymous access.
  -- A NULL ACL means the built-in default, which on schema public still grants
  -- USAGE to PUBLIC, so it must be treated as a failure rather than as "empty".
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public' AND nspacl IS NOT NULL) THEN
    RAISE EXCEPTION 'live rls boundary: schema public carries the default ACL, so PUBLIC was never revoked';
  END IF;

  SELECT coalesce(array_agg(DISTINCT named.role_name ORDER BY named.role_name), ARRAY[]::text[])
    INTO v_public_acl_roles
  FROM pg_namespace n
  CROSS JOIN LATERAL aclexplode(n.nspacl) AS a
  CROSS JOIN LATERAL (
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS role_name
  ) AS named
  WHERE n.nspname = 'public';
  IF 'PUBLIC' = ANY(v_public_acl_roles) THEN
    RAISE EXCEPTION 'live rls boundary: PUBLIC still holds a grant on schema public';
  END IF;
  IF NOT (v_public_acl_roles <@ v_expected_acl_roles) THEN
    RAISE EXCEPTION 'live rls boundary: unexpected grantee on schema public: %',
      array_to_string(ARRAY(SELECT unnest(v_public_acl_roles) EXCEPT SELECT unnest(v_expected_acl_roles)), ', ');
  END IF;

  -- 6. No function in public is executable by PUBLIC, so the AI guard and the
  --    identity write path cannot be reached anonymously.
  -- Deliberately the same definition as
  -- portable_functions_triggers_ai_guard_catalog_assertions.sql: extension
  -- member functions are excluded, because pgcrypto ships its own PUBLIC EXECUTE
  -- defaults that step 002's revoke cannot remove, and a NULL proacl is resolved
  -- through acldefault() since the default for a function IS EXECUTE to PUBLIC.
  -- Keeping one definition is what stops the live smoke and the cleanroom
  -- assertion from disagreeing about the same property.
  SELECT count(*) INTO v_public_executable
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND EXISTS (
      SELECT 1
      FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    );
  IF v_public_executable <> 0 THEN
    RAISE EXCEPTION 'live rls boundary: % function(s) in public are executable by PUBLIC', v_public_executable;
  END IF;

  -- 7. The migration ledger exists and is not readable by the runtime role. The
  --    ledger is control-plane state; the application must never see it.
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app_ledger' AND c.relname = 'applied_migration'
  ) INTO v_ledger_present;
  IF NOT v_ledger_present THEN
    RAISE EXCEPTION 'live rls boundary: the migration ledger is absent';
  END IF;

  SELECT has_schema_privilege('app_runtime', 'app_ledger', 'USAGE')
    INTO v_ledger_readable_by_runtime;
  IF v_ledger_readable_by_runtime THEN
    RAISE EXCEPTION 'live rls boundary: app_runtime can reach the migration ledger';
  END IF;

  RAISE NOTICE 'live rls boundary ok: % tables, all with RLS and at least one of % policies',
    v_public_tables, v_policy_count;
END
$$;
