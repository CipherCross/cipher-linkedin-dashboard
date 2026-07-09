-- Stop daily_activity double-counting corrected milestones.
--
-- The events table's unique key was (instance_id, campaign_id, profile_url,
-- event_type, occurred_at) — occurred_at is PART of the key. The sync agent emits
-- exactly one event per lead milestone (invite_sent/invite_accepted/message_sent/
-- reply_received) with occurred_at = that milestone's timestamp, and upserts
-- on_conflict on those five columns. So when LH2 later CORRECTS a milestone
-- timestamp, the upsert's conflict target no longer matches the stale row (its
-- occurred_at differs), a NEW row is inserted, and BOTH rows survive. daily_activity
-- (group by day, instance, event_type over events) then counts the milestone twice.
--
-- Fix: drop occurred_at from the identity. One event per
-- (instance_id, campaign_id, profile_url, event_type); occurred_at becomes a mutable
-- payload column. The agent's on_conflict key is being changed to the same 4 columns
-- in the SAME release, so a re-sync of a corrected milestone now UPDATES the existing
-- event's occurred_at in place instead of inserting a duplicate.
--
-- ---------------------------------------------------------------------------------
-- DEPLOY-ORDERING CAVEAT (read before pushing):
--   Push this migration FIRST, then deploy the matching agent PROMPTLY. Between the
--   two, an OLD agent still upserts events on_conflict on the 5-column key. That key
--   no longer exists after step (2), and PostgREST's on_conflict requires the named
--   columns to back a real unique/exclusion constraint — so the events push of any
--   sync in that window ERRORS. Earlier tables in the same sync (campaigns, leads,
--   messages) are pushed and committed before events, so they still land; only the
--   events push of an old agent fails, loudly, and the next sync from the updated
--   agent heals it. A short window is acceptable; keep it short.
-- ---------------------------------------------------------------------------------

-- (1) Dedupe existing rows down to one per (instance_id, campaign_id, profile_url,
-- event_type). Preference order: keep the row whose occurred_at still matches the
-- lead's CURRENT corresponding milestone (that's the value the updated agent would
-- upsert to), else the EARLIEST occurred_at, with events.id as the final
-- deterministic tiebreaker. Leads join is on (campaign_id, profile_url) — leads is
-- unique on that pair, so at most one lead matches; a NULL campaign_id/profile_url
-- event matches no lead (left join) and falls through to earliest-wins.
with ranked as (
  select
    e.id,
    row_number() over (
      partition by e.instance_id, e.campaign_id, e.profile_url, e.event_type
      order by
        -- 0 = occurred_at matches the current lead milestone (preferred), 1 = not.
        (case
           when e.event_type = 'invite_sent'     and e.occurred_at = l.invited_at       then 0
           when e.event_type = 'invite_accepted' and e.occurred_at = l.connected_at     then 0
           when e.event_type = 'message_sent'    and e.occurred_at = l.first_message_at then 0
           when e.event_type = 'reply_received'  and e.occurred_at = l.replied_at       then 0
           else 1
         end) asc,
        e.occurred_at asc,   -- else keep the earliest recorded occurrence
        e.id          asc    -- deterministic final tiebreaker
    ) as rn
  from events e
  left join leads l
    on l.campaign_id = e.campaign_id
   and l.profile_url = e.profile_url
)
delete from events
where id in (select id from ranked where rn > 1);

-- (2) Drop the old 5-column unique constraint. Its auto-generated name is truncated
-- to 63 chars and easy to mis-guess, so find it by matching its column set (order-
-- independent) in pg_constraint and drop by the real name.
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  where con.conrelid = 'public.events'::regclass
    and con.contype = 'u'
    and (
      select array_agg(att.attname::text order by att.attname::text)
      from unnest(con.conkey) as k(attnum)
      join pg_attribute att
        on att.attrelid = con.conrelid and att.attnum = k.attnum
    ) = array['campaign_id','event_type','instance_id','occurred_at','profile_url']::text[];

  if cname is not null then
    execute format('alter table events drop constraint %I', cname);
  end if;
end $$;

-- (3) Add the new 4-column identity. NULLS NOT DISTINCT (PG15+) so rows with a NULL
-- campaign_id or profile_url still dedupe against each other — the old key used the
-- default NULLS DISTINCT, which let NULL-scoped events escape the unique constraint
-- and accumulate. drop-then-add for rerunnability.
alter table events drop constraint if exists events_identity_key;
alter table events
  add constraint events_identity_key
  unique nulls not distinct (instance_id, campaign_id, profile_url, event_type);
