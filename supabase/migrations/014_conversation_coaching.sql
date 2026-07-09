-- AI conversation coaching. A layer on top of reply classification (012): instead
-- of labelling the latest inbound reply, the coach reads the whole negotiation and
-- tells the SDR what they did wrong, how to respond now, and what to fix going
-- forward. Generated on demand by /api/coach (Sonnet per conversation, Opus for the
-- per-account digest); the service-role client writes, the dashboard reads anon.
--
-- PRIVACY NOTE: like messages/annotations these rows are anon-readable, so coaching
-- text is visible to anyone holding the publishable key. Lock down with Supabase
-- Auth (see README) if that matters.

-- One row per conversation, keyed by the same (instance_id, profile_url) pair that
-- identifies a thread everywhere else (leadKey / ConversationDrawer). last_msg_marker
-- lets /api/coach skip regenerating an unchanged thread (the on-demand cost guard).
create table if not exists conversation_coaching (
  instance_id     text not null references instances(id) on delete cascade,
  profile_url     text not null,
  next_action     text,                          -- reply | wait | book_call | refer | close | none
  issues          jsonb not null default '[]',   -- [{kind,severity,quote,fix}]
  tips            jsonb not null default '[]',    -- ["Answer the price question first", ...]
  summary         text,
  last_msg_marker text,                           -- "<latest sent_at>|<msg count>" staleness marker
  coached_at      timestamptz,
  model           text,
  primary key (instance_id, profile_url)
);

-- One rolled-up self-correction digest per SDR (= per instance/account).
create table if not exists coaching_digest (
  instance_id text primary key references instances(id) on delete cascade,
  summary     text,
  patterns    jsonb not null default '[]',        -- [{issue, count, advice}]
  computed_at timestamptz,
  model       text
);

alter table conversation_coaching enable row level security;
alter table coaching_digest        enable row level security;
drop policy if exists "conversation_coaching is readable" on conversation_coaching;
create policy "conversation_coaching is readable" on conversation_coaching for select using (true);
drop policy if exists "coaching_digest is readable"       on coaching_digest;
create policy "coaching_digest is readable"       on coaching_digest        for select using (true);
