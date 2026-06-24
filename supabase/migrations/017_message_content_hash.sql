-- Messages identity fix.
--
-- The unique key (instance_id, profile_url, direction, sent_at) used the
-- ACTION-RUN timestamp (action_results.created_at), not the true message time. Two
-- genuinely different messages recorded in a single CheckForReplies run therefore
-- share one sent_at and collide on that key: a batch upsert either silently
-- overwrites one message (data loss) or aborts the whole messages push with
-- "ON CONFLICT ... cannot affect row a second time". Adding content_hash (md5 of
-- body) to the key means distinct bodies never collide. The sync agent now sends
-- content_hash and de-dupes each batch (agent v1.7.2+; see content_hash() and
-- dedupe_messages() in sync-agent/agent.py).

alter table messages
  add column if not exists content_hash text not null default '';

-- Backfill existing rows: md5 of the body (NULL/empty body -> md5('')).
update messages set content_hash = md5(coalesce(body, '')) where content_hash = '';

-- Collapse any rows that would violate the new key, keeping the earliest id
-- (mirrors the earliest-wins rule in 015). After 015 this is normally a no-op.
delete from messages a
using messages b
where a.instance_id  = b.instance_id
  and a.profile_url  = b.profile_url
  and a.direction    = b.direction
  and a.sent_at      = b.sent_at
  and a.content_hash = b.content_hash
  and a.id > b.id;

-- Swap the unique constraint to include content_hash.
alter table messages drop constraint if exists messages_instance_id_profile_url_direction_sent_at_key;
alter table messages drop constraint if exists messages_identity_key;
alter table messages
  add constraint messages_identity_key
  unique (instance_id, profile_url, direction, sent_at, content_hash);
