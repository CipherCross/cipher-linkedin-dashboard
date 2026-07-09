-- Bound the AI SQL guard's memory + tighten its grants.
--
-- Three problems in the state 021 left behind:
--
-- (A) UNBOUNDED RESULT MATERIALIZATION. jsonb_agg over the whole result set has no
--     size cap, so a cheap-to-plan but huge-to-materialize query like
--     `select generate_series(1, 1e8)` OOMs the backend BEFORE the 10s
--     statement_timeout can fire. Fix: wrap the caller's query in a hard
--     `limit 1000` subquery so jsonb_agg can never accumulate more than 1000 rows.
--     The API layer already truncates to 200 rows, so this cap is invisible to
--     legitimate use. A CTE / `with` query is legal inside a FROM subquery, so the
--     SELECT/WITH contract is unchanged.
--
-- (B) OVER-BROAD GRANTS. 021 did `grant select on all tables` + default privileges,
--     which exposes instances.config — free-form jsonb that may hold sensitive
--     values — to the AI, and silently grants SELECT on every FUTURE table too.
--     Fix: revoke the blanket grant on instances and re-grant column-level SELECT on
--     every column EXCEPT config; revoke the default privilege so new tables must be
--     granted explicitly. `select * from instances` will now ERROR for the AI, and
--     SCHEMA_DOC is being updated to spell out the allowed instances columns.
--
-- (C) LEGACY ai_readonly ROLE. 008/010 created role ai_readonly and did
--     `grant ai_readonly to service_role`; 021 superseded it with ai_sql_runner but
--     never cleaned it up, leaving a stray SELECT-everything role. Dropped below,
--     guarded so a fresh environment (role never existed) still applies cleanly.

-- (A) Recreate ai_execute_sql: identical to 021 except the execute now caps rows.
create or replace function public.ai_execute_sql(query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  query := regexp_replace(query, '[;\s]+$', '');

  if query !~* '^\s*(select|with)\y' then
    raise exception 'Only SELECT / WITH queries are allowed';
  end if;

  perform set_config('statement_timeout', '10000', true);

  -- No `set local role` here: this function is owned by ai_sql_runner (SELECT only)
  -- and runs SECURITY DEFINER, so it already executes with least privilege AND in a
  -- security-restricted context that blocks SET ROLE / set_config('role', ...).
  --
  -- The inner `limit 1000` bounds how many rows jsonb_agg can materialize, so a
  -- query that plans cheap but returns enormous output can't OOM the backend ahead
  -- of the statement_timeout. A `with`/CTE query is valid as the (%s) subquery.
  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) sub limit 1000) t',
    query)
    into result;

  return result;
end;
$$;

-- create-or-replace by the migration role can reset ownership, so re-assert the
-- least-privilege owner exactly as 021 did (grant CREATE for the transfer, revoke it
-- right after — the function persists; CREATE is only checked at ALTER OWNER time).
grant create on schema public to ai_sql_runner;
alter function public.ai_execute_sql(text) owner to ai_sql_runner;
revoke create on schema public from ai_sql_runner;

revoke execute on function public.ai_execute_sql(text) from public, anon, authenticated;
grant execute on function public.ai_execute_sql(text) to service_role;

-- (B) Column-scope instances so config is never visible to the AI role. Revoke the
-- blanket table grant first, then grant every column EXCEPT config. Any query that
-- selects config (including `select *`) now raises a permission error.
revoke select on table instances from ai_sql_runner;
grant select (
  id, label, last_sync_at, agent_version, created_at,
  account_name, account_url, account_avatar, config_updated_at
) on instances to ai_sql_runner;

-- Stop auto-granting SELECT on future tables: each new table must be granted to
-- ai_sql_runner explicitly, so a new table can never be silently exposed to the AI.
alter default privileges in schema public revoke select on tables from ai_sql_runner;

-- (C) Retire the superseded ai_readonly role. Guarded so it's a clean no-op where
-- the role was never created (fresh env). Order matters: strip its grants and the
-- service_role membership first, then `drop owned by` (which also clears any grants
-- it still holds across the DB), then finally drop the role itself.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ai_readonly') then
    -- Undo 010's membership so service_role no longer inherits this role.
    execute 'revoke ai_readonly from service_role';

    -- Best-effort strip of privileges. Each wrapped so a missing grant (already
    -- gone in some environments) doesn't abort the migration.
    begin execute 'revoke all on all tables in schema public from ai_readonly'; exception when others then null; end;
    begin execute 'revoke usage on schema public from ai_readonly'; exception when others then null; end;
    begin execute 'alter default privileges in schema public revoke select on tables from ai_readonly'; exception when others then null; end;

    -- drop owned by clears anything the above missed (grants, default privs owned by
    -- the role); required before drop role or Postgres refuses ("role ... cannot be
    -- dropped because some objects depend on it").
    execute 'drop owned by ai_readonly';
    execute 'drop role ai_readonly';
  end if;
end $$;
