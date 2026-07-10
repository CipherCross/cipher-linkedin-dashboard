-- Slack reply notifications (/api/notify-replies): NULL notified_at on an
-- inbound sync row = announcement pending. Set when the reply was posted to
-- Slack OR deliberately skipped (stale / pre-feature) — bookkeeping only,
-- never a funnel signal.

alter table messages add column if not exists notified_at timestamptz;

-- Backfill ALL existing inbound rows so the endpoint's first run never replays
-- history into Slack. Disable the change-aware updated_at trigger (031) around
-- the backfill: this one-time bookkeeping write must not shove every inbound
-- message forward in the incremental-fetch timeline.
alter table messages disable trigger touch_messages_updated_at;
update messages set notified_at = now()
 where direction = 'in' and notified_at is null;
alter table messages enable trigger touch_messages_updated_at;

-- Fast poll for the pending set (matches the endpoint's exact predicate;
-- manual rows never notify — the SDR pasted them, so they've been seen).
create index if not exists messages_notify_pending_idx
  on messages (sent_at)
  where direction = 'in' and source = 'sync' and notified_at is null;
