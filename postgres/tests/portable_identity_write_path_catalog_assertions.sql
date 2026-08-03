\set ON_ERROR_STOP on

-- Catalog assertions for ledger step 004: the identity write path, the actor
-- resolver, the roster read and the identity store schema.
--
-- Run by the migration principal against a database that has received steps
-- 001..004. These are structural facts -- ownership, ACLs, search_path pinning,
-- schema isolation and types. The privilege DENIALS that actually matter are
-- proved behaviourally, from a real app_runtime session, in
-- portable_identity_write_path_behavior_assertions.sql; a grant statement is not
-- evidence that an ordinary member cannot reach a function.

DO $$
DECLARE
  v_new_functions text[] := ARRAY[
    'identity_admin_invite_member',
    'identity_admin_set_member_active',
    'identity_admin_set_member_role',
    'identity_resolve_actor',
    'team_roster'
  ];
  v_fn text;
  v_oid oid;
  v_public_functions integer;
  v_secdef integer;
  v_owner text;
  v_config text[];
  v_identity_tables text[];
  v_identity_owner text;
  v_store_login boolean;
  v_store_super boolean;
  v_store_bypass boolean;
  v_store_createrole boolean;
  v_user_id_type text;
  v_cross_fks integer;
  v_identity_policies integer;
  v_col_count integer;
  v_role text;
  v_guard_oid oid;
  v_account_oid oid;
BEGIN
  --
  -- The five functions exist exactly once each, in public, owned by app_owner,
  -- SECURITY DEFINER, with an explicitly empty search_path.
  --
  FOREACH v_fn IN ARRAY v_new_functions
  LOOP
    SELECT p.oid, r.rolname, p.proconfig
      INTO v_oid, v_owner, v_config
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'public' AND p.proname = v_fn;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'step 004 function public.% is missing', v_fn;
    END IF;
    IF v_owner <> 'app_owner' THEN
      RAISE EXCEPTION 'public.% is owned by % rather than app_owner', v_fn, v_owner;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
      RAISE EXCEPTION 'public.% is not SECURITY DEFINER', v_fn;
    END IF;
    -- SET search_path TO '' is stored as search_path="" -- the empty string is a
    -- quoted GUC value, not an absent one. Both spellings are accepted here and
    -- nothing else is: an unpinned or non-empty search_path on a SECURITY
    -- DEFINER function is the classic hijack surface.
    IF v_config IS NULL
       OR NOT EXISTS (SELECT 1 FROM unnest(v_config) AS cfg
                       WHERE cfg IN ('search_path=', 'search_path=""')) THEN
      RAISE EXCEPTION 'public.% does not pin an empty search_path (proconfig %)',
        v_fn, coalesce(v_config::text, '<null>');
    END IF;

    -- PUBLIC executes nothing, ever.
    IF pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'PUBLIC holds EXECUTE on public.%', v_fn;
    END IF;

    -- The runtime principal is the only grantee.
    IF NOT pg_catalog.has_function_privilege('app_runtime', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'app_runtime lacks EXECUTE on public.%', v_fn;
    END IF;

    --
    -- The AI surface and the write surface stay separate. app_ai_runner is the
    -- role the SELECT-only guard executes as; app_system is the only role that
    -- may execute the guard. Neither may execute anything from step 004, so a
    -- generated SELECT that calls one of these functions fails closed instead of
    -- becoming a write path.
    --
    FOREACH v_role IN ARRAY ARRAY['app_ai_runner', 'app_system', 'app_readonly',
                                  'app_machine', 'identity_store']
    LOOP
      IF pg_catalog.has_function_privilege(v_role, v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION '% holds EXECUTE on public.%, which must be app_runtime only',
          v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;

  --
  -- Function inventory. S07 published 13 portable functions in public and the
  -- AI guard is one of them. Step 004 adds exactly five. A later session that
  -- changes this number must change it here too, deliberately.
  --
  SELECT count(*) INTO v_public_functions
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
    );
  IF v_public_functions <> 18 THEN
    RAISE EXCEPTION 'expected 18 non-extension functions in public after step 004 (13 + 5), found %',
      v_public_functions;
  END IF;

  SELECT count(*) INTO v_secdef
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
    );
  IF v_secdef <> 13 THEN
    RAISE EXCEPTION 'expected 13 SECURITY DEFINER functions in public after step 004 (8 + 5), found %',
      v_secdef;
  END IF;

  --
  -- The AI SQL guard is untouched: still owned by app_ai_runner, still executable
  -- by app_system alone.
  --
  IF (SELECT r.rolname FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_roles r ON r.oid = p.proowner
       WHERE n.nspname = 'public' AND p.proname = 'ai_execute_sql') <> 'app_ai_runner' THEN
    RAISE EXCEPTION 'the AI SQL guard is no longer owned by app_ai_runner';
  END IF;
  -- Object identities are resolved from the catalog rather than by name. The
  -- migration principal has no USAGE on public and none on identity, so a
  -- 'schema.object' text argument would fail to resolve rather than answer the
  -- privilege question -- which would look like a passing assertion in a file
  -- written slightly differently.
  SELECT p.oid INTO v_guard_oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ai_execute_sql';
  IF pg_catalog.has_function_privilege('app_runtime', v_guard_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'app_runtime gained EXECUTE on the AI SQL guard';
  END IF;

  --
  -- The identity store schema: four tables, owned by identity_store, isolated in
  -- both directions.
  --
  SELECT r.rolname INTO v_identity_owner
  FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
  WHERE n.nspname = 'identity';
  IF v_identity_owner IS NULL THEN
    RAISE EXCEPTION 'the identity schema is missing';
  END IF;
  IF v_identity_owner <> 'identity_store' THEN
    RAISE EXCEPTION 'schema identity is owned by % rather than identity_store', v_identity_owner;
  END IF;

  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_identity_tables
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'identity' AND c.relkind = 'r';
  IF v_identity_tables IS DISTINCT FROM ARRAY['account', 'session', 'user', 'verification'] THEN
    RAISE EXCEPTION 'unexpected identity table set: %', coalesce(v_identity_tables::text, '<none>');
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'identity' AND c.relkind = 'r' AND r.rolname <> 'identity_store'
  ) THEN
    RAISE EXCEPTION 'an identity table is owned by a role other than identity_store';
  END IF;

  -- No product role may reach the store, and PUBLIC may not either.
  SELECT c.oid INTO v_account_oid
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'identity' AND c.relname = 'account';

  FOREACH v_role IN ARRAY ARRAY['public', 'app_runtime', 'app_readonly',
                                'app_machine', 'app_system', 'app_ai_runner']
  LOOP
    IF pg_catalog.has_schema_privilege(v_role, 'identity', 'USAGE') THEN
      RAISE EXCEPTION '% holds USAGE on schema identity', v_role;
    END IF;
    IF pg_catalog.has_table_privilege(v_role, v_account_oid, 'SELECT') THEN
      RAISE EXCEPTION '% holds SELECT on identity.account, which holds the password hash', v_role;
    END IF;
  END LOOP;

  -- And the store may not reach the business schema. USAGE on public is granted
  -- to app_runtime, app_readonly, app_ai_runner and app_system only.
  IF pg_catalog.has_schema_privilege('identity_store', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'identity_store holds USAGE on schema public';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
      AND pg_catalog.has_table_privilege('identity_store', c.oid, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'identity_store holds SELECT on a relation in the business schema';
  END IF;

  SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole
    INTO v_store_login, v_store_super, v_store_bypass, v_store_createrole
  FROM pg_roles WHERE rolname = 'identity_store';
  IF v_store_super OR v_store_bypass OR v_store_createrole THEN
    RAISE EXCEPTION 'identity_store must not be superuser, BYPASSRLS or CREATEROLE';
  END IF;
  IF NOT v_store_login THEN
    RAISE EXCEPTION 'identity_store must be able to log in; the identity service connects as itself';
  END IF;

  --
  -- The store stays subordinate. user.id is text, so it cannot be joined to the
  -- uuid canonical id; the rejected canonicalUserId column is absent; and there
  -- is no foreign key in either direction between identity and public.
  --
  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) INTO v_user_id_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'identity' AND c.relname = 'user' AND a.attname = 'id';
  IF v_user_id_type <> 'text' THEN
    RAISE EXCEPTION 'identity."user".id must remain text (a provider subject), found %', v_user_id_type;
  END IF;

  SELECT count(*) INTO v_col_count
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'identity' AND c.relname = 'user'
    AND a.attname = 'canonicalUserId' AND NOT a.attisdropped;
  IF v_col_count <> 0 THEN
    RAISE EXCEPTION 'the rejected canonicalUserId proposal column is present in the baseline';
  END IF;

  SELECT count(*) INTO v_cross_fks
  FROM pg_constraint con
  JOIN pg_class src ON src.oid = con.conrelid
  JOIN pg_namespace sn ON sn.oid = src.relnamespace
  JOIN pg_class tgt ON tgt.oid = con.confrelid
  JOIN pg_namespace tn ON tn.oid = tgt.relnamespace
  WHERE con.contype = 'f'
    AND ((sn.nspname = 'identity' AND tn.nspname <> 'identity')
      OR (tn.nspname = 'identity' AND sn.nspname <> 'identity'));
  IF v_cross_fks <> 0 THEN
    RAISE EXCEPTION 'found % foreign key(s) crossing the identity/public boundary', v_cross_fks;
  END IF;

  -- No RLS in the store: the owner is the only principal with any privilege, and
  -- a policy evaluated for the table owner does nothing. Recorded so a later
  -- session that adds one has to say why.
  SELECT count(*) INTO v_identity_policies
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'identity';
  IF v_identity_policies <> 0 THEN
    RAISE EXCEPTION 'unexpected RLS policy in the identity schema';
  END IF;

  RAISE NOTICE 'identity write path catalog assertions passed: 18 functions in public, 13 SECURITY DEFINER, identity schema owned by identity_store';
END
$$;

SELECT 'portable identity write path, resolver, roster and store catalog assertions passed' AS result;
