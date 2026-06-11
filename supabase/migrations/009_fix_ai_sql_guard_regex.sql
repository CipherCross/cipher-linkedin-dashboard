-- Fix the SELECT/WITH guard in ai_execute_sql: in Postgres regexes \b matches
-- a literal backspace character (word boundary is \y), so the 008 version
-- rejected every query. Same function otherwise.

create or replace function public.ai_execute_sql(query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if query !~* '^\s*(select|with)\y' then
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
