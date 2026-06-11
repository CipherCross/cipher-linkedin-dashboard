-- Quality-of-life: models often terminate SQL with ';', which is a syntax
-- error inside the jsonb_agg subquery wrapper. Strip trailing semicolons.

create or replace function public.ai_execute_sql(query text)
returns jsonb
language plpgsql
security invoker
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
  execute 'set local role ai_readonly';

  -- Wrapping in a subquery makes multi-statement injection a syntax error.
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', query)
    into result;

  return result;
end;
$$;

revoke execute on function public.ai_execute_sql(text) from public, anon, authenticated;
grant execute on function public.ai_execute_sql(text) to service_role;
