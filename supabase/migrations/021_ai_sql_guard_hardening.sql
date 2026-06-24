-- Harden the AI read-only SQL guard against role re-escalation.
--
-- 010 switched ai_execute_sql to SECURITY INVOKER and dropped to ai_readonly via
-- `set local role`. Because the RPC caller (service_role) is a MEMBER of ai_readonly
-- and an INVOKER function does not run in a security-restricted context, an injected
-- query can simply undo that drop:
--     select set_config('role','service_role', true), * from <table>
-- (a session may always return to its own session role). Reads are already open in
-- this single-tenant schema and the FROM-subquery wrapper blocks data-modifying
-- CTEs, so the impact is bounded TODAY — but the "runs as ai_readonly" guarantee is
-- illusory and would silently defeat any RLS added later (e.g. with auth).
--
-- Fix: own the function with a dedicated NOLOGIN, SELECT-only role and run it
-- SECURITY DEFINER. The body then needs no `set local role` (it already executes as
-- the least-privilege owner), and a SECURITY DEFINER function runs in a
-- security-restricted context where SET ROLE / set_config('role', ...) are BLOCKED —
-- closing the re-escalation. The SELECT/WITH regex guard, statement_timeout, and the
-- jsonb_agg subquery wrapper are all retained.
--
-- NOTE: this touches the role/grant model and interacts with any separate auth/RLS
-- work — deploy with `supabase db push` and smoke-test /api/chat (run a SELECT, then
-- confirm an INSERT/UPDATE is rejected) before relying on it.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ai_sql_runner') then
    create role ai_sql_runner nologin;
  end if;
end $$;

-- Ensure the migration role can hand ownership to ai_sql_runner (ALTER ... OWNER TO
-- requires being able to SET ROLE to the new owner). PG16+ grants the creator this
-- automatically; the explicit grant keeps the migration robust across role setups.
do $$
begin
  execute format('grant ai_sql_runner to %I', current_user);
exception when others then
  null;
end $$;

grant usage on schema public to ai_sql_runner;
grant select on all tables in schema public to ai_sql_runner;
alter default privileges in schema public grant select on tables to ai_sql_runner;

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
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', query)
    into result;

  return result;
end;
$$;

-- A role must hold CREATE on the schema to OWN an object in it. Grant it only for
-- the ownership transfer, then revoke — ai_sql_runner stays select-only afterwards
-- (the function persists; the CREATE check is enforced only at ALTER OWNER time).
grant create on schema public to ai_sql_runner;
alter function public.ai_execute_sql(text) owner to ai_sql_runner;
revoke create on schema public from ai_sql_runner;

revoke execute on function public.ai_execute_sql(text) from public, anon, authenticated;
grant execute on function public.ai_execute_sql(text) to service_role;
