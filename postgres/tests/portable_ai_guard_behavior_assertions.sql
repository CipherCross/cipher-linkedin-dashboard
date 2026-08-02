\set ON_ERROR_STOP on

-- The clean-room invokes this file as the test-only app_ai_client login, whose
-- single capability is SET ROLE app_system. app_system is the server-owned AI
-- execution principal and holds nothing but USAGE on public plus EXECUTE on the
-- guard, so everything below is proven from the real AI posture rather than
-- from an owner or runtime session.
SET ROLE app_system;

SELECT 1 / CASE WHEN current_user = 'app_system' THEN 1 ELSE 0 END AS ai_execution_principal;

-- The principal cannot escalate out of the guard.
DO $$
BEGIN
  BEGIN
    EXECUTE 'SET ROLE app_owner';
    RAISE EXCEPTION 'the AI execution principal reached app_owner';
  EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value THEN NULL;
  END;
  BEGIN
    EXECUTE 'SET ROLE app_ai_runner';
    RAISE EXCEPTION 'the AI execution principal reached app_ai_runner directly';
  EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value THEN NULL;
  END;
  BEGIN
    EXECUTE 'SET ROLE app_runtime';
    RAISE EXCEPTION 'the AI execution principal reached app_runtime';
  EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value THEN NULL;
  END;
END
$$;

-- It also has no direct data path of its own; the guard is its whole surface.
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.leads;
    RAISE EXCEPTION 'the AI execution principal read a table directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.pipeline_auto_advance();
    RAISE EXCEPTION 'the AI execution principal executed a business function';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- ---------------------------------------------------------------------------
-- Accepted shapes.
-- ---------------------------------------------------------------------------

SELECT 1 / CASE WHEN jsonb_array_length(public.ai_execute_sql(
    'select id, full_name from leads order by id')) = 3
  THEN 1 ELSE 0 END AS plain_select_allowed;

SELECT 1 / CASE WHEN public.ai_execute_sql(
    'with recent as (select profile_url, sent_at from messages where direction = ''in'')
     select count(*) as n from recent') = '[{"n": 3}]'::jsonb
  THEN 1 ELSE 0 END AS with_statement_allowed;

-- Views resolve through the same SELECT-only sandbox.
SELECT 1 / CASE WHEN public.ai_execute_sql('select * from campaign_metrics') <> '[]'::jsonb
  THEN 1 ELSE 0 END AS view_select_allowed;

-- An empty result set is an empty array, never NULL.
SELECT 1 / CASE WHEN public.ai_execute_sql(
    'select id from leads where full_name = ''nobody''') = '[]'::jsonb
  THEN 1 ELSE 0 END AS empty_result_is_json_array;

-- A single trailing terminator and trailing whitespace stay acceptable.
SELECT 1 / CASE WHEN public.ai_execute_sql('select 1 as one;   ') = '[{"one": 1}]'::jsonb
  THEN 1 ELSE 0 END AS trailing_terminator_tolerated;

-- Comments and literals that merely mention a terminator or a keyword are not
-- statements, so they must not be rejected.
SELECT 1 / CASE WHEN public.ai_execute_sql(
    '-- leading note; still one statement
     select ''a;b'' as text_with_terminator /* trailing note; here too */') =
    '[{"text_with_terminator": "a;b"}]'::jsonb
  THEN 1 ELSE 0 END AS literals_and_comments_are_not_statements;

SELECT 1 / CASE WHEN public.ai_execute_sql(
    'select count(*) as n from leads where full_name = ''delete from leads''') =
    '[{"n": 0}]'::jsonb
  THEN 1 ELSE 0 END AS keyword_inside_literal_allowed;

-- The 1000 row materialisation cap and the 10 second statement timeout are the
-- source contract and are still applied inside the guard.
SELECT 1 / CASE WHEN jsonb_array_length(public.ai_execute_sql(
    'select g from generate_series(1, 5000) as g')) = 1000
  THEN 1 ELSE 0 END AS row_cap_enforced;

-- The column is deliberately not named `t` or `sub`: those are the wrapper's own
-- aliases in the source result shape, and a user column of the same name shadows
-- them. That quirk is inherited verbatim and is not re-tested here.
SELECT 1 / CASE WHEN public.ai_execute_sql(
    'select current_setting(''statement_timeout'') as timeout_setting') =
    '[{"timeout_setting": "10s"}]'::jsonb
  THEN 1 ELSE 0 END AS statement_timeout_applied_inside_guard;

-- The 10 second limit is real, but PostgreSQL arms statement_timeout when the
-- outer statement begins, so a value the guard sets on itself cannot abort a
-- call that is already running. The server-owned AI path therefore arms the
-- limit per transaction. Both halves of that contract are pinned here.

-- (a) With the caller-armed limit the guard is bounded at 10 seconds.
BEGIN;
SET LOCAL statement_timeout = '10s';
DO $$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_elapsed interval;
BEGIN
  BEGIN
    PERFORM public.ai_execute_sql('select pg_sleep(14) as slept');
    RAISE EXCEPTION 'a long running query was not aborted by the 10 second limit';
  EXCEPTION WHEN query_canceled THEN
    v_elapsed := clock_timestamp() - v_started;
    IF v_elapsed > interval '13 seconds' THEN
      RAISE EXCEPTION 'the 10 second limit only aborted after %', v_elapsed;
    END IF;
  END;
END
$$;
ROLLBACK;
SELECT 'caller-armed statement timeout bounds the guard at 10s' AS timeout_enforced;

-- (b) Boundary pin: without that caller-armed limit the call is not aborted by
-- the guard's own setting. If PostgreSQL ever starts re-arming the timer on a
-- mid-statement change this assertion fails, which is the signal to revisit the
-- S07 contract note rather than a silent behaviour change.
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.ai_execute_sql('select pg_sleep(12) as slept');
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'the unbounded call returned nothing';
  END IF;
EXCEPTION WHEN query_canceled THEN
  RAISE EXCEPTION 'the in-function limit now aborts on its own; update the S07 timeout contract note';
END
$$;
SELECT 'in-function timeout alone does not abort the running call' AS timeout_boundary_pinned;

-- ---------------------------------------------------------------------------
-- Rejected shapes. Each expected rejection is caught so the next case runs.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad_sql text;
  v_result jsonb;
BEGIN
  FOREACH bad_sql IN ARRAY ARRAY[
    -- empty, blank and malformed input
    '',
    '   ',
    E'\n\t ',
    '-- only a comment',
    '/* only a block comment */',
    'select ''unterminated',
    'select 1 /* unterminated',
    'not a query at all',
    '1',
    ';',
    ';;',
    -- statements that are not SELECT/WITH
    'insert into leads (instance_id, campaign_id, profile_url) values (''x'', ''y'', ''z'')',
    'update leads set full_name = ''x''',
    'delete from leads',
    'merge into leads l using leads s on l.id = s.id when matched then do nothing',
    'truncate table leads',
    'create table ai_probe (id int)',
    'alter table leads add column probe int',
    'drop table leads',
    'grant select on leads to app_runtime',
    'revoke select on leads from app_ai_runner',
    'copy leads to stdout',
    'do $do$ begin end $do$',
    'call pipeline_auto_advance()',
    'vacuum leads',
    'set role app_owner',
    'reset role',
    'begin',
    'commit',
    -- multi-statement input, including the terminator hidden behind a comment
    'select 1; select 2',
    'select 1 ; drop table leads',
    'select 1; insert into leads (instance_id, campaign_id, profile_url) values (''x'', ''y'', ''z'')',
    'select 1 -- note
     ; select 2',
    'select 1; select 2;',
    -- SELECT-rooted statements that still write, lock or leave the session
    'with moved as (insert into leads (instance_id, campaign_id, profile_url) values (''x'', ''y'', ''z'') returning id) select * from moved',
    'with gone as (delete from leads returning id) select * from gone',
    'with bumped as (update leads set full_name = ''x'' returning id) select * from bumped',
    'select * from leads for update',
    'select id into ai_probe from leads',
    -- escape and unicode literals would reintroduce backslash escaping
    'select E''a;b'' as x',
    'select U&''a'' as x'
  ]
  LOOP
    BEGIN
      v_result := public.ai_execute_sql(bad_sql);
      RAISE EXCEPTION 'AI SQL guard accepted rejected input %L and returned %', bad_sql, v_result;
    EXCEPTION
      WHEN invalid_parameter_value THEN NULL;   -- the guard's own 22023 refusal
    END;
  END LOOP;
END
$$;

-- NULL input fails closed on the same path.
DO $$
BEGIN
  BEGIN
    PERFORM public.ai_execute_sql(NULL);
    RAISE EXCEPTION 'AI SQL guard accepted a NULL statement';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END
$$;

-- ---------------------------------------------------------------------------
-- Privilege boundaries observed from inside the guard.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- The sandbox is SELECT-only, so even a syntactically accepted read of a
  -- withheld column or table fails on privileges rather than leaking data.
  BEGIN
    v_result := public.ai_execute_sql('select config from instances');
    RAISE EXCEPTION 'the guard exposed instances.config: %', v_result;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    v_result := public.ai_execute_sql('select email, role from team_members');
    RAISE EXCEPTION 'the guard exposed withheld team_members columns: %', v_result;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    v_result := public.ai_execute_sql('select id from users');
    RAISE EXCEPTION 'the guard exposed the canonical users table: %', v_result;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    v_result := public.ai_execute_sql('select user_id, provider from user_identities');
    RAISE EXCEPTION 'the guard exposed provider identity mappings: %', v_result;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- A SECURITY DEFINER business function is not reachable from generated SQL,
  -- so a SELECT cannot become a write path through a function call.
  BEGIN
    v_result := public.ai_execute_sql('select public.pipeline_auto_advance() as advanced');
    RAISE EXCEPTION 'the guard executed a SECURITY DEFINER business function: %', v_result;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    v_result := public.ai_execute_sql('select public.delete_manual_message(0) as deleted');
    RAISE EXCEPTION 'the guard executed the manual message delete path: %', v_result;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- The guard runs in a security-restricted context, so it cannot change role.
  BEGIN
    v_result := public.ai_execute_sql('select set_config(''role'', ''app_owner'', true) as r');
    RAISE EXCEPTION 'the guard changed role from inside a query: %', v_result;
  EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value OR wrong_object_type THEN NULL;
  END;
END
$$;

-- The permitted columns of the two restricted tables are still readable, so the
-- restriction is column-scoped rather than a blanket denial.
SELECT 1 / CASE WHEN public.ai_execute_sql(
    'select count(*) as n from team_members where active') = '[{"n": 2}]'::jsonb
  THEN 1 ELSE 0 END AS permitted_team_member_columns_readable;

SELECT 1 / CASE WHEN public.ai_execute_sql(
    'select id, label from instances') = '[{"id": "notebook-test", "label": "Test notebook"}]'::jsonb
  THEN 1 ELSE 0 END AS permitted_instance_columns_readable;

RESET ROLE;
SELECT 'portable SELECT-only AI SQL guard assertions passed' AS result;
