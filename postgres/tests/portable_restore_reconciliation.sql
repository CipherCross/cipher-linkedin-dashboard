\set ON_ERROR_STOP on

-- Post-restore reconciliation.
--
-- The harness already proves the restored database is byte-identical to the
-- source at the catalog level, by diffing two portable_schema_inventory_snapshot
-- outputs. This file is the independent, hand-written second opinion: it states
-- the numbers and properties that must hold in absolute terms, so a restore that
-- happens to reproduce a *wrong* source is still caught, and so a failure names
-- the property rather than pointing at a diff hunk.
--
-- Run as app_migration; it enters app_owner only where the ledger has to be read.

SET ROLE app_owner;

DO $$
DECLARE
  actual bigint;
  expected bigint;
  detail text;
BEGIN
  --
  -- 1. Object inventory, in the terms S05, S06 and S07 established.
  --

  -- 25 business tables from S05 plus the two canonical identity tables S06 adds.
  SELECT count(*) INTO actual
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r';
  IF actual <> 27 THEN
    RAISE EXCEPTION 'expected 27 tables in public (25 business + users + user_identities), found %', actual;
  END IF;

  SELECT count(*) INTO actual
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relname NOT IN ('users', 'user_identities');
  IF actual <> 25 THEN
    RAISE EXCEPTION 'expected the 25 S05 business tables, found %', actual;
  END IF;

  SELECT count(*) INTO actual
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'v';
  IF actual <> 7 THEN
    RAISE EXCEPTION 'expected 7 views, found %', actual;
  END IF;

  -- 2. RLS: enabled on all 27, and never restored as FORCE.
  SELECT count(*) INTO actual
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity;
  IF actual <> 27 THEN
    RAISE EXCEPTION 'expected RLS enabled on 27 tables, found %', actual;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO detail
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity;
  IF detail IS NOT NULL THEN
    RAISE EXCEPTION 'RLS came back as FORCE on: %', detail;
  END IF;

  SELECT count(*) INTO actual
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public';
  IF actual <> 52 THEN
    RAISE EXCEPTION 'expected 52 policies, found %', actual;
  END IF;

  SELECT count(*) INTO actual
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND p.polname LIKE '%\_ai\_read';
  IF actual <> 25 THEN
    RAISE EXCEPTION 'expected 25 AI read policies, found %', actual;
  END IF;

  --
  -- 3. Functions and triggers. Extension members are excluded through
  --    pg_depend deptype = 'e' exactly as S07 does, so pgcrypto's functions can
  --    never be counted as part of the portable inventory.
  --
  SELECT count(*) INTO actual
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');
  -- 13 from S07, plus the 5 ledger step 004 added, plus the 1 step 005 added
  -- (identity_admin_invite_member_atomic). These figures are manifest-wide and
  -- move with every step that adds a function; left alone they fail on the next
  -- restore drill and the failure looks like corruption rather than an expected
  -- baseline change.
  -- The step-004 five are: the three identity admin write
  -- functions, the actor resolver and the roster read. The figure moved because
  -- the baseline genuinely gained functions, not because the check was relaxed.
  IF actual <> 19 THEN
    RAISE EXCEPTION 'expected 19 portable functions, found %', actual;
  END IF;

  SELECT count(*) INTO actual
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND EXISTS (SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');
  IF actual = 0 THEN
    RAISE EXCEPTION 'pgcrypto functions are missing from public after restore';
  END IF;

  SELECT count(*) INTO actual
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal;
  IF actual <> 12 THEN
    RAISE EXCEPTION 'expected 12 triggers, found %', actual;
  END IF;

  SELECT count(*) INTO actual
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled <> 'O';
  IF actual <> 0 THEN
    RAISE EXCEPTION '% trigger(s) came back disabled after restore', actual;
  END IF;

  -- SECURITY DEFINER count, and a pinned search_path on every function.
  SELECT count(*) INTO actual
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');
  -- 8 from S07, plus all 5 of step 004's and the 1 of step 005's, which are
  -- SECURITY DEFINER by design: they exist precisely to hold a privilege the
  -- calling role does not have.
  IF actual <> 14 THEN
    RAISE EXCEPTION 'expected 14 SECURITY DEFINER functions, found %', actual;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO detail
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND (p.proconfig IS NULL
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) AS cfg WHERE cfg LIKE 'search\_path=%'));
  IF detail IS NOT NULL THEN
    RAISE EXCEPTION 'functions lost their pinned search_path: %', detail;
  END IF;

  --
  -- 4. Indexes, constraints and identity columns.
  --
  SELECT count(*) INTO actual
    FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public';
  IF actual <> 75 THEN
    RAISE EXCEPTION 'expected 75 indexes in public, found %', actual;
  END IF;

  SELECT count(*) INTO actual
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public';
  IF actual <> 133 THEN
    RAISE EXCEPTION 'expected 133 constraints in public, found %', actual;
  END IF;

  SELECT count(*) INTO actual
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT con.convalidated;
  IF actual <> 0 THEN
    RAISE EXCEPTION '% constraint(s) came back NOT VALID after restore', actual;
  END IF;

  -- Every identity column must still be GENERATED ALWAYS ('a'), not BY DEFAULT.
  SELECT count(*) INTO actual
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT a.attisdropped AND a.attidentity = 'a';
  IF actual <> 13 THEN
    RAISE EXCEPTION 'expected 13 GENERATED ALWAYS AS IDENTITY columns, found %', actual;
  END IF;

  --
  -- 4b. The identity store survived the restore, with its own owner.
  --
  -- The inventory snapshot this file diffs is scoped to public and app_ledger, so
  -- the identity schema is outside the line-by-line comparison. These counts are
  -- deliberately here instead: a restore that silently arrives without the
  -- identity store, or with its tables owned by app_owner because the role was
  -- missing in the target cluster, is exactly the failure the control-plane
  -- prerequisite exists to prevent, and it must not pass quietly.
  --
  SELECT count(*) INTO actual
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'identity' AND c.relkind = 'r';
  IF actual <> 4 THEN
    RAISE EXCEPTION 'expected 4 identity store tables after restore, found %', actual;
  END IF;

  SELECT string_agg(format('%s(%s)', c.relname, pg_get_userbyid(c.relowner)), ', ' ORDER BY c.relname)
    INTO detail
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'identity' AND c.relkind = 'r'
     AND pg_get_userbyid(c.relowner) <> 'identity_store';
  IF detail IS NOT NULL THEN
    RAISE EXCEPTION 'identity store tables not owned by identity_store after restore: %', detail;
  END IF;

  IF pg_catalog.has_schema_privilege('app_runtime', 'identity', 'USAGE') THEN
    RAISE EXCEPTION 'app_runtime gained USAGE on schema identity across the restore';
  END IF;

  -- The backup principal's read of the store has to survive, or this restored
  -- tenant cannot itself be dumped. pg_restore replays those grants as app_owner
  -- rather than as their grantor identity_store, so without the restore window
  -- they are warnings that silently do nothing -- the same failure shape as the
  -- AI guard's ACL, and the reason the window covers both.
  IF NOT pg_catalog.has_schema_privilege('app_owner', 'identity', 'USAGE') THEN
    RAISE EXCEPTION 'app_owner lost USAGE on schema identity across the restore';
  END IF;

  SELECT count(*) INTO actual
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'identity' AND c.relkind = 'r'
     AND pg_catalog.has_table_privilege('app_owner', c.oid, 'SELECT');
  IF actual <> 4 THEN
    RAISE EXCEPTION 'app_owner can read only % of 4 identity store tables after restore', actual;
  END IF;

  --
  -- 5. Ownership.
  --
  SELECT string_agg(format('%s(%s)', c.relname, pg_get_userbyid(c.relowner)), ', ' ORDER BY c.relname)
    INTO detail
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'app_ledger')
     AND c.relkind IN ('r', 'v', 'S')
     AND pg_get_userbyid(c.relowner) <> 'app_owner';
  IF detail IS NOT NULL THEN
    RAISE EXCEPTION 'relations not owned by app_owner after restore: %', detail;
  END IF;

  -- The AI guard is the single deliberate exception: its owner is the sandbox.
  SELECT string_agg(format('%s(%s)', p.proname, pg_get_userbyid(p.proowner)), ', ' ORDER BY p.proname)
    INTO detail
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND pg_get_userbyid(p.proowner) <> CASE WHEN p.proname = 'ai_execute_sql'
                                             THEN 'app_ai_runner' ELSE 'app_owner' END;
  IF detail IS NOT NULL THEN
    RAISE EXCEPTION 'functions with unexpected ownership after restore: %', detail;
  END IF;

  SELECT count(*) INTO actual
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE pg_get_userbyid(c.relowner) = 'app_ai_runner';
  IF actual <> 0 THEN
    RAISE EXCEPTION 'the AI sandbox owns % relation(s) after restore; it must own only the guard function', actual;
  END IF;

  SELECT count(*) INTO actual
    FROM pg_proc p WHERE pg_get_userbyid(p.proowner) = 'app_ai_runner';
  IF actual <> 1 THEN
    RAISE EXCEPTION 'the AI sandbox owns % functions after restore, expected exactly the guard', actual;
  END IF;

  SELECT count(*) INTO actual
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'app_ledger')
     AND pg_get_userbyid(c.relowner) = 'app_migration';
  IF actual <> 0 THEN
    RAISE EXCEPTION 'the migration principal owns % object(s) after restore; it must own none', actual;
  END IF;

  --
  -- 6. The temporary CREATE grant the restore window opens must be gone, and
  --    the guard must not have fallen back to its default PUBLIC-executable ACL.
  --
  IF pg_catalog.has_schema_privilege('app_ai_runner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'app_ai_runner retains CREATE on schema public after restore';
  END IF;

  IF pg_catalog.has_function_privilege('public', 'public.ai_execute_sql(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the AI SQL guard is executable by PUBLIC after restore';
  END IF;

  IF NOT pg_catalog.has_function_privilege('app_system', 'public.ai_execute_sql(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'app_system lost EXECUTE on the AI SQL guard during restore';
  END IF;

  FOREACH detail IN ARRAY ARRAY['app_runtime', 'app_readonly', 'app_migration', 'app_machine']
  LOOP
    IF pg_catalog.has_function_privilege(detail, 'public.ai_execute_sql(text)', 'EXECUTE') THEN
      RAISE EXCEPTION '% can execute the AI SQL guard after restore', detail;
    END IF;
  END LOOP;

  -- app_system's entire privilege set is schema usage plus that one function.
  IF NOT pg_catalog.has_schema_privilege('app_system', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'app_system lost USAGE on schema public during restore';
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO detail
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'S')
     AND pg_catalog.has_table_privilege('app_system', c.oid, 'SELECT');
  IF detail IS NOT NULL THEN
    RAISE EXCEPTION 'app_system gained table access during restore: %', detail;
  END IF;

  --
  -- 7. Column-level grants. The AI sandbox is column-scoped; a restore that
  --    widened it to the whole table would be invisible in a table-level ACL.
  --
  SELECT string_agg(a.attname, ',' ORDER BY a.attname) INTO detail
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'team_members'
     AND a.attnum > 0 AND NOT a.attisdropped
     AND pg_catalog.has_column_privilege('app_ai_runner', c.oid, a.attnum, 'SELECT');
  IF detail IS NOT DISTINCT FROM NULL OR detail <> 'active,created_at,id,name' THEN
    RAISE EXCEPTION 'team_members AI column scope after restore is %, expected active,created_at,id,name',
                    coalesce(detail, '<none>');
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY a.attname) INTO detail
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'instances'
     AND a.attnum > 0 AND NOT a.attisdropped
     AND pg_catalog.has_column_privilege('app_ai_runner', c.oid, a.attnum, 'SELECT');
  IF detail IS NOT DISTINCT FROM NULL
     OR detail <> 'account_avatar,account_name,account_url,agent_version,config_updated_at,created_at,id,label,last_sync_at' THEN
    RAISE EXCEPTION 'instances AI column scope after restore is %', coalesce(detail, '<none>');
  END IF;

  IF pg_catalog.has_column_privilege('app_ai_runner', 'public.instances'::regclass, 'config', 'SELECT') THEN
    RAISE EXCEPTION 'the AI sandbox can read instances.config after restore';
  END IF;

  FOREACH detail IN ARRAY ARRAY['users', 'user_identities']
  LOOP
    IF pg_catalog.has_table_privilege('app_ai_runner', format('public.%I', detail)::regclass, 'SELECT') THEN
      RAISE EXCEPTION 'the AI sandbox can read % after restore', detail;
    END IF;
  END LOOP;

  --
  -- 8. Views must still be security_invoker, or every reader silently inherits
  --    the owner's rights and RLS stops applying to them.
  --
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO detail
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'v'
     AND coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions)
                    WHERE option_name = 'security_invoker'), 'false') <> 'true';
  IF detail IS NOT NULL THEN
    RAISE EXCEPTION 'views are no longer security_invoker after restore: %', detail;
  END IF;

  --
  -- 9. pgcrypto must be installed in public, where the UUID defaults expect it.
  --
  SELECT count(*) INTO actual
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pgcrypto' AND n.nspname = 'public';
  IF actual <> 1 THEN
    RAISE EXCEPTION 'pgcrypto is not installed in schema public after restore';
  END IF;

  --
  -- 10. Roles. Non-owner, non-superuser, non-BYPASSRLS runtime and AI roles.
  --
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO detail
    FROM pg_roles
   WHERE rolname LIKE 'app\_%' AND (rolsuper OR rolbypassrls);
  IF detail IS NOT NULL THEN
    RAISE EXCEPTION 'application roles gained superuser or BYPASSRLS: %', detail;
  END IF;

  SELECT count(*) INTO actual FROM pg_roles WHERE rolname LIKE 'app\_%' AND rolcanlogin;
  IF actual < 2 THEN
    RAISE EXCEPTION 'expected at least the two login principals, found %', actual;
  END IF;

  --
  -- 11. Provider surfaces must not have travelled in the dump.
  --
  IF EXISTS (SELECT 1 FROM pg_namespace
              WHERE nspname IN ('auth', 'storage', 'supabase_migrations', 'extensions', 'graphql', 'realtime')) THEN
    RAISE EXCEPTION 'a provider schema exists after restore';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname IN ('anon', 'authenticated', 'service_role', 'supabase_admin',
                                'authenticator', 'ai_sql_runner')) THEN
    RAISE EXCEPTION 'a provider role exists after restore';
  END IF;

  --
  -- 12. The ledger travelled with the database and still describes it.
  --
  SELECT count(*) INTO actual FROM app_ledger.applied_migration;
  IF actual <> 5 THEN
    RAISE EXCEPTION 'expected 5 ledger rows after restore, found %', actual;
  END IF;

  SELECT string_agg(artifact, ' -> ' ORDER BY applied_seq) INTO detail
    FROM app_ledger.applied_migration;
  IF detail <> '001_portable_business_baseline.sql -> 002_identity_roles_actor_rls.sql -> 003_functions_triggers_ai_guard.sql -> 004_identity_write_path_and_store.sql -> 005_identity_atomic_invite.sql' THEN
    RAISE EXCEPTION 'ledger order did not survive restore: %', detail;
  END IF;

  SELECT count(*) INTO actual FROM app_ledger.role_bootstrap;
  IF actual <> 1 THEN
    RAISE EXCEPTION 'expected the role-bootstrap dependency record after restore, found % rows', actual;
  END IF;

  -- The ledger must still be append-only after restore.
  BEGIN
    UPDATE app_ledger.applied_migration SET sha256 = repeat('0', 64) WHERE step = 1;
    RAISE EXCEPTION 'the restored ledger accepted an UPDATE';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

--
-- 13. Identity sequences hand out fresh values rather than colliding with
--     restored rows. Rolled back so the evidence database stays untouched.
--
BEGIN;
DO $$
DECLARE
  max_existing bigint;
  fresh bigint;
  probe_user uuid;
BEGIN
  SELECT max(id) INTO max_existing FROM public.team_members;
  INSERT INTO public.users (active) VALUES (true) RETURNING id INTO probe_user;
  INSERT INTO public.team_members (name, active, role, user_id)
  VALUES ('sequence probe', true, 'member', probe_user)
  RETURNING id INTO fresh;
  IF fresh <= max_existing THEN
    RAISE EXCEPTION 'team_members identity restarted: new id % is not above existing max %', fresh, max_existing;
  END IF;

  SELECT max(id) INTO max_existing FROM public.messages;
  INSERT INTO public.messages (instance_id, campaign_id, profile_url, direction, body, sent_at, content_hash, source)
  VALUES ('notebook-test', 'notebook-test:1', 'https://example.test/in/alpha', 'in',
          'sequence probe', '2026-03-01 00:00:00+00', 'sequence-probe', 'manual')
  RETURNING id INTO fresh;
  IF fresh <= max_existing THEN
    RAISE EXCEPTION 'messages identity restarted: new id % is not above existing max %', fresh, max_existing;
  END IF;
END
$$;
ROLLBACK;

RESET ROLE;

SELECT 'post-restore reconciliation passed' AS result;
