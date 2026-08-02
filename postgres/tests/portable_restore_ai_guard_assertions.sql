\set ON_ERROR_STOP on

-- Post-restore AI SQL guard assertions.
--
-- Invoked as the test-only app_ai_client login, which switches explicitly to
-- app_system — the one principal the contract allows to execute the guard.
-- The full 39-case rejection matrix belongs to S07 and is replayed unchanged by
-- its own clean-room; this file proves the guard still behaves as a guard after
-- travelling through pg_dump and pg_restore into a different cluster.

SET ROLE app_system;

-- Accepts a plain SELECT and a WITH, and returns a JSON array.
SELECT 1 / CASE WHEN public.ai_execute_sql('select 1 as n') = '[{"n": 1}]'::jsonb
                THEN 1 ELSE 0 END AS guard_accepts_select;

SELECT 1 / CASE WHEN public.ai_execute_sql('with x as (select 2 as n) select n from x')
                     = '[{"n": 2}]'::jsonb
                THEN 1 ELSE 0 END AS guard_accepts_with;

-- Reads a business table through the SELECT-only sandbox.
SELECT 1 / CASE WHEN jsonb_array_length(
                       public.ai_execute_sql('select id from public.leads order by id')) = 3
                THEN 1 ELSE 0 END AS guard_reads_business_data;

-- Rejects mutation, DDL and multi-statement input, and still refuses the
-- columns and tables that are outside the AI boundary.
DO $$
DECLARE
  rejected text[] := ARRAY[
    'insert into public.annotations (note) values (''x'')',
    'update public.leads set full_name = ''x''',
    'delete from public.leads',
    'truncate public.leads',
    'create table public.should_not_exist (id int)',
    'drop table public.leads',
    'grant select on public.leads to app_runtime',
    'select 1; select 2',
    'select 1; drop table public.leads',
    'with moved as (delete from public.leads returning *) select * from moved',
    'select * from public.leads for update',
    'set role app_owner'
  ];
  candidate text;
BEGIN
  FOREACH candidate IN ARRAY rejected
  LOOP
    BEGIN
      PERFORM public.ai_execute_sql(candidate);
      RAISE EXCEPTION 'AI guard accepted forbidden input after restore: %', candidate;
    EXCEPTION
      WHEN raise_exception THEN
        IF SQLERRM LIKE 'AI guard accepted forbidden input after restore:%' THEN
          RAISE;
        END IF;
      WHEN insufficient_privilege THEN NULL;
      WHEN syntax_error_or_access_rule_violation THEN NULL;
      WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;

  -- The column-scoped grants must have survived: instances.config and the
  -- withheld team_members columns stay unreachable, and the identity tables
  -- have no AI grant at all.
  FOREACH candidate IN ARRAY ARRAY[
    'select config from public.instances',
    'select email from public.team_members',
    'select user_id from public.team_members',
    'select id from public.users',
    'select provider_subject from public.user_identities'
  ]
  LOOP
    BEGIN
      PERFORM public.ai_execute_sql(candidate);
      RAISE EXCEPTION 'AI guard reached data outside its boundary after restore: %', candidate;
    EXCEPTION
      WHEN raise_exception THEN
        IF SQLERRM LIKE 'AI guard reached data outside its boundary after restore:%' THEN
          RAISE;
        END IF;
      WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;

  -- The columns that ARE in scope still work.
  PERFORM public.ai_execute_sql('select id, name, active from public.team_members');
  PERFORM public.ai_execute_sql('select id, label from public.instances');
END
$$;

RESET ROLE;

SELECT 'post-restore AI SQL guard assertions passed' AS result;
