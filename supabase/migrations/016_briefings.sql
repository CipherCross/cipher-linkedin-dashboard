-- Morning Briefing: a daily, AI-generated digest of the whole pipeline. The
-- server function /api/briefing reuses the chat copilot's agentic SQL loop to
-- investigate the data on its own, then stores the result here (one row per day)
-- and posts it to Slack. The dashboard reads the latest row for the Overview card.
--
-- PRIVACY: like messages/coaching this row is anon-readable, so the briefing text
-- (which may quote campaign/account specifics) is visible to anyone holding the
-- publishable key. Lock down with Supabase Auth (see README) if that matters.

create table if not exists briefings (
  id            uuid primary key default gen_random_uuid(),
  briefing_date date not null unique,          -- one briefing per day; upsert target
  headline      text,
  summary       text,
  sections      jsonb not null default '[]',   -- [{title, body}]   the narrative body
  actions       jsonb not null default '[]',   -- [{text, priority}] the 3 things to do today
  risks         jsonb not null default '[]',   -- [{kind, severity, text}] at-risk callouts
  model         text,
  created_at    timestamptz not null default now()
);

create index if not exists briefings_date_idx on briefings (briefing_date desc);

-- The dashboard reads with the anon key; only /api/briefing (service-role, which
-- bypasses RLS) writes. Tighten to authenticated-only once Supabase Auth is on.
alter table briefings enable row level security;
create policy "read briefings" on briefings for select using (true);
