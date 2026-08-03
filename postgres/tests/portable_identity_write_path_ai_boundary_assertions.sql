\set ON_ERROR_STOP on

-- Behaviour assertions run by the clean room as the test-only app_ai_client
-- login, which can do nothing except SET ROLE app_system -- the one principal
-- permitted to execute the SELECT-only AI SQL guard.
--
-- Step 004 introduces five SECURITY DEFINER functions, three of which write the
-- canonical identity tables. A SECURITY DEFINER function that can write is
-- exactly what the AI guard exists to keep generated SQL away from, and the guard
-- allows any SELECT -- including a SELECT whose target list calls a function. So
-- the separation cannot rest on the guard's statement filter. It rests on the ACL:
-- app_ai_runner, the role the guard executes as, holds EXECUTE on nothing from
-- step 004.
--
-- This file proves that from the only session that can reach the guard at all.

SET ROLE app_system;

-- The guard itself still works, so a failure below is a denial and not a broken
-- guard.
SELECT 1 / CASE WHEN public.ai_execute_sql('select 1 as ok') = '[{"ok": 1}]'::jsonb
                THEN 1 ELSE 0 END AS guard_still_functions;

-- The ACL, measured from inside the sandbox itself.
--
-- This assertion exists because of a mutation check. Calling a write function
-- through the guard and catching insufficient_privilege is NOT sufficient
-- evidence: the write functions also refuse a caller that is not an admin actor,
-- and they do it with the same SQLSTATE 42501. So when EXECUTE was deliberately
-- granted to app_ai_runner, the call-based tests below still passed -- the guard
-- did reach the function, and the function's own gate turned it away. That is
-- defence in depth and it is welcome, but it means the call tests alone cannot
-- tell "the sandbox has no grant" from "the gate refused it". This one can, and
-- it is the assertion that fails if the grant is ever widened.
SELECT 1 / CASE WHEN public.ai_execute_sql($q$
    select bool_or(pg_catalog.has_function_privilege('app_ai_runner', p.oid, 'EXECUTE')) as reachable
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('identity_admin_invite_member', 'identity_admin_set_member_active',
                         'identity_admin_set_member_role', 'identity_resolve_actor', 'team_roster')
  $q$) = '[{"reachable": false}]'::jsonb
                THEN 1 ELSE 0 END AS sandbox_holds_no_execute_on_step_004;

-- Same measurement for the store: no schema usage means no table is nameable.
SELECT 1 / CASE WHEN public.ai_execute_sql($q$
    select pg_catalog.has_schema_privilege('app_ai_runner', 'identity', 'USAGE') as reachable
  $q$) = '[{"reachable": false}]'::jsonb
                THEN 1 ELSE 0 END AS sandbox_cannot_see_the_identity_schema;

DO $$
BEGIN
  -- The three write functions, reached the way generated SQL would reach them.
  BEGIN
    PERFORM public.ai_execute_sql(
      $q$select public.identity_admin_invite_member('ai@example.test', 'AI', 'admin', 'fixture', 'ai-subject')$q$);
    RAISE EXCEPTION 'the AI guard reached identity_admin_invite_member';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.ai_execute_sql(
      $q$select public.identity_admin_set_member_active('00000000-0000-0000-0000-000000000002'::uuid, false)$q$);
    RAISE EXCEPTION 'the AI guard reached identity_admin_set_member_active';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.ai_execute_sql(
      $q$select public.identity_admin_set_member_role('00000000-0000-0000-0000-000000000002'::uuid, 'member')$q$);
    RAISE EXCEPTION 'the AI guard reached identity_admin_set_member_role';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- The two read functions are refused as well. Neither is a write path, but the
  -- resolver would hand generated SQL a canonical actor id and the roster read
  -- would hand it the member email addresses that the AI sandbox's own
  -- column-level grant on team_members deliberately withholds.
  BEGIN
    PERFORM public.ai_execute_sql($q$select * from public.identity_resolve_actor('fixture', 'subject-one')$q$);
    RAISE EXCEPTION 'the AI guard reached identity_resolve_actor';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.ai_execute_sql($q$select * from public.team_roster()$q$);
    RAISE EXCEPTION 'the AI guard reached team_roster';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- And the identity store is invisible to it: no USAGE on the schema.
  BEGIN
    PERFORM public.ai_execute_sql($q$select count(*) from identity."user"$q$);
    RAISE EXCEPTION 'the AI guard read the identity store';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.ai_execute_sql($q$select "password" from identity."account"$q$);
    RAISE EXCEPTION 'the AI guard read the identity store password hash';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- The guard's own statement filter is unchanged and still refuses anything but
  -- a single SELECT/WITH, so neither surface was loosened to make room for 004.
  BEGIN
    PERFORM public.ai_execute_sql('update public.leads set full_name = null');
    RAISE EXCEPTION 'the AI guard accepted an UPDATE';
  EXCEPTION WHEN others THEN
    IF sqlstate = '42501' THEN
      RAISE EXCEPTION 'the AI guard refused an UPDATE for the wrong reason';
    END IF;
  END;
END
$$;

RESET ROLE;
SELECT 'portable identity write path AI boundary assertions passed' AS result;
