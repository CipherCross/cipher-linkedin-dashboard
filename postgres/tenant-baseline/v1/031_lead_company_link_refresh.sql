-- Step 031: re-derive the lead <-> Airtable company links in one definer call.
--
-- Step 030's link refresh ran as the caller. Under app_runtime every row of
-- leads, airtable_contacts and airtable_companies, and every inserted link,
-- re-evaluates the active-member RLS predicate -- a SECURITY DEFINER function
-- with its own search_path, so it is never inlined. On production (2026-11-12,
-- 9.2k people, 6.3k contacts) that was tens of thousands of calls and the
-- statement hit the runtime's 10 s timeout, so no lead was ever linked. The
-- same query as the owner takes ~0.1 s.
--
-- refresh_lead_company_links() authorizes its caller ONCE -- an active team
-- member, or the system actor the daily cron publishes -- and then runs the
-- step 030 rule as the owner: a person (instance_id, profile_url) links to the
-- company of the Airtable contact with the same linkedin_slug(); two matches
-- take the most recently modified contact; a 'manual' link is never touched;
-- nothing is deleted. It answers {leads, matched, changed, linked}.
--
-- Same shape as step 024's refresh_message_step_attribution: owned by
-- app_owner, EXECUTE revoked from PUBLIC, granted only to the two callers.
-- No table, grant or policy changes.

SET ROLE app_owner;

CREATE FUNCTION public.refresh_lead_company_links() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_result jsonb;
begin
  -- coalesce: with no actor published current_setting() is NULL, and
  -- NOT (false OR NULL) is NULL, which IF treats as false -- the check would
  -- pass. Every operand here must be a real boolean.
  if not (coalesce(public.is_active_team_member(), false)
          or coalesce(pg_catalog.current_setting('app.actor_id', true), '') = '00000000-0000-0000-0000-000000000000') then
    raise exception 'refresh_lead_company_links: an active team member or the system actor is required'
      using errcode = '42501';
  end if;

  with people as (
    select distinct l.instance_id, l.profile_url from public.leads l
  ), keyed as (
    select p.instance_id, p.profile_url, public.linkedin_slug(p.profile_url) as slug
      from people p
  ), matched as (
    select distinct on (k.instance_id, k.profile_url)
           k.instance_id, k.profile_url, c.base_key, c.company_record_id,
           c.record_id as contact_record_id
      from keyed k
      join public.airtable_contacts c on c.persona_slug = k.slug
      join public.airtable_companies co
        on co.base_key = c.base_key and co.record_id = c.company_record_id
     where k.slug is not null and c.company_record_id is not null
     order by k.instance_id, k.profile_url, c.airtable_modified desc nulls last,
              c.base_key, c.record_id
  ), written as (
    insert into public.lead_company_links as link
           (instance_id, profile_url, base_key, company_record_id, contact_record_id,
            method, linked_at)
    select m.instance_id, m.profile_url, m.base_key, m.company_record_id,
           m.contact_record_id, 'contact_slug', now()
      from matched m
    on conflict (instance_id, profile_url) do update set
      base_key = excluded.base_key, company_record_id = excluded.company_record_id,
      contact_record_id = excluded.contact_record_id, linked_at = now()
    where link.method = 'contact_slug'
      and (link.base_key, link.company_record_id, link.contact_record_id)
          is distinct from (excluded.base_key, excluded.company_record_id,
                            excluded.contact_record_id)
    returning 1
  )
  select jsonb_build_object(
           'leads', (select count(*) from people),
           'matched', (select count(*) from matched),
           'changed', (select count(*) from written),
           -- The statement's snapshot predates its own inserts, so count the
           -- union: every match ends up linked (or already was).
           'linked', (select count(*) from (
                        select instance_id, profile_url from public.lead_company_links
                        union
                        select instance_id, profile_url from matched) x))
    into v_result;
  return v_result;
end;
$$;

ALTER FUNCTION public.refresh_lead_company_links() OWNER TO app_owner;
REVOKE ALL ON FUNCTION public.refresh_lead_company_links() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_lead_company_links() TO app_runtime, app_system;

RESET ROLE;
