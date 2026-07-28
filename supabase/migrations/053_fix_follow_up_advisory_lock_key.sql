-- PostgreSQL text values cannot contain a NUL byte. Migration 046 attempted to
-- delimit the two parts of a conversation key with chr(0) before hashing it for
-- an advisory lock, so every follow-up mutation (and final-lead cleanup) failed
-- with "null character not permitted".
--
-- A JSON array gives the lock hash an unambiguous, NUL-free representation while
-- preserving the existing function bodies, permissions, and security settings.
do $migration$
declare
  function_definition text;
  fixed_definition text;
begin
  function_definition := pg_get_functiondef(
    'public.apply_follow_up_action(text,text,text,text,bigint,uuid,bigint,date,text)'::regprocedure
  );
  fixed_definition := replace(
    function_definition,
    'hashtextextended(p_instance_id || chr(0) || p_profile_url, 0)',
    'hashtextextended(jsonb_build_array(p_instance_id, p_profile_url)::text, 0)'
  );

  if fixed_definition <> function_definition then
    execute fixed_definition;
  elsif position(
    'hashtextextended(jsonb_build_array(p_instance_id, p_profile_url)::text, 0)'
    in function_definition
  ) = 0 then
    raise exception 'Unexpected apply_follow_up_action definition; advisory lock was not updated';
  end if;

  function_definition := pg_get_functiondef(
    'public.archive_follow_up_after_last_lead()'::regprocedure
  );
  fixed_definition := replace(
    function_definition,
    'hashtextextended(old.instance_id || chr(0) || old.profile_url, 0)',
    'hashtextextended(jsonb_build_array(old.instance_id, old.profile_url)::text, 0)'
  );

  if fixed_definition <> function_definition then
    execute fixed_definition;
  elsif position(
    'hashtextextended(jsonb_build_array(old.instance_id, old.profile_url)::text, 0)'
    in function_definition
  ) = 0 then
    raise exception 'Unexpected archive_follow_up_after_last_lead definition; advisory lock was not updated';
  end if;
end
$migration$;
