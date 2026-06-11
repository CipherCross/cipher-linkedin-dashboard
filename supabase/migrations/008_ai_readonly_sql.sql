-- Read-only SQL execution for the AI chat layer (/api/chat, /api/mcp).
--
-- The serverless functions call public.ai_execute_sql(query) with the
-- service-role key. Safety is enforced in the database, not just the prompt:
--   * only SELECT/WITH statements are accepted,
--   * the query runs as the select-only role ai_readonly (set local role,
--     reverts at transaction end),
--   * statement_timeout caps runtime at 10s,
--   * EXECUTE on the function is revoked from anon/authenticated, so only
--     the service-role key (which bypasses RLS but still respects function
--     grants via PostgREST) can reach it.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ai_readonly') then
    create role ai_readonly nologin;
  end if;
end $$;

grant usage on schema public to ai_readonly;
grant select on all tables in schema public to ai_readonly;
alter default privileges in schema public grant select on tables to ai_readonly;

create or replace function public.ai_execute_sql(query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if query !~* '^\s*(select|with)\b' then
    raise exception 'Only SELECT / WITH queries are allowed';
  end if;

  perform set_config('statement_timeout', '10000', true);
  execute 'set local role ai_readonly';

  -- Wrapping in a subquery makes multi-statement injection a syntax error.
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', query)
    into result;

  return result;
end;
$$;

revoke execute on function public.ai_execute_sql(text) from public, anon, authenticated;
grant execute on function public.ai_execute_sql(text) to service_role;
