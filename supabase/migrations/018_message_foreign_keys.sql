-- messages foreign-key hygiene.
--
-- messages.instance_id had a plain FK with no ON DELETE CASCADE — inconsistent with
-- every other table (leads, events, campaigns, sync_runs all cascade), so deleting
-- an instance errors instead of cleaning up its messages. And messages.campaign_id
-- had NO foreign key at all, so orphan/garbage campaign ids could accumulate and the
-- campaign_reply_sentiment view groups on an unvalidated column.

alter table messages drop constraint if exists messages_instance_id_fkey;
alter table messages
  add constraint messages_instance_id_fkey
  foreign key (instance_id) references instances(id) on delete cascade;

-- Add the missing campaign_id FK. NOT VALID so the migration cannot fail on any
-- pre-existing orphan rows; it still enforces referential integrity for all new
-- writes. After cleaning up any orphans you can fully enforce it with:
--   alter table messages validate constraint messages_campaign_id_fkey;
alter table messages drop constraint if exists messages_campaign_id_fkey;
alter table messages
  add constraint messages_campaign_id_fkey
  foreign key (campaign_id) references campaigns(id) on delete cascade not valid;
