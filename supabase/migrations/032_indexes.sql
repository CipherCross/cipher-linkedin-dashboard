-- Supporting indexes for hot query paths + validate the messages campaign FK.
--
-- All indexes are `create index if not exists` for rerunnability. NB: no
-- `create index concurrently` — `supabase db push` runs the migration inside a
-- transaction, and CONCURRENTLY cannot run in one. These tables are small enough
-- that a brief lock at push time is fine.

-- campaign_reply_sentiment (012) groups classified inbound messages by campaign_id.
-- Partial on the classified rows keeps the index tiny (most messages are unclassified
-- outbound or as-yet-unclassified inbound).
create index if not exists messages_campaign_sentiment_idx
  on messages (campaign_id)
  where sentiment is not null;

-- pipeline_auto_advance (028/033) does distinct-on over classified inbound replies
-- ordered by (instance_id, campaign_id, profile_url, sent_at desc). This composite
-- matches the DISTINCT ON prefix + ORDER BY so the scan is index-only-ish, no sort.
create index if not exists messages_inbound_sentiment_idx
  on messages (instance_id, campaign_id, profile_url, sent_at desc)
  where direction = 'in' and sentiment is not null;

-- leadKey joins (instance_id, profile_url) are everywhere (CLAUDE.md convention);
-- leads only had single-column indexes on instance_id and campaign_id (001).
create index if not exists leads_instance_profile_idx
  on leads (instance_id, profile_url);

-- Incremental fetch (see 031): the frontend polls "rows changed since <ts>".
create index if not exists leads_updated_at_idx    on leads    (updated_at);
create index if not exists messages_updated_at_idx on messages (updated_at);

-- Finally validate the messages -> campaigns FK that 018 added NOT VALID and nobody
-- ever validated. Guarded: only run VALIDATE when the constraint exists AND is still
-- unvalidated, so this is a no-op on fresh environments (where 018's constraint may
-- already be valid or absent) and on reruns. VALIDATE takes a SHARE UPDATE EXCLUSIVE
-- lock and scans existing rows; it errors if any orphan messages.campaign_id remain,
-- surfacing the data problem loudly rather than silently leaving the FK unenforced.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'messages_campaign_id_fkey'
      and conrelid = 'public.messages'::regclass
      and not convalidated
  ) then
    alter table messages validate constraint messages_campaign_id_fkey;
  end if;
end $$;
