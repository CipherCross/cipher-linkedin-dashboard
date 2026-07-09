-- Single global playbook. One free-form Markdown document that grounds the AI
-- conversation coach (/api/coach) for EVERY account — the single source of truth
-- for product, voice, do's/don'ts and call-to-action. Replaces the old
-- per-instance structured playbook that lived under instances.config.playbook.
--
-- Edited from the dashboard's Playbook page; written by /api/playbook with the
-- service-role key (bypasses RLS). The coach reads it server-side, the page
-- reads it with the anon key — so it's anon-readable like the rest of the data.

-- Singleton: the `id` boolean PK with a `check (id)` constraint allows only the
-- single row id=true, so every write upserts the same row.
create table if not exists playbook (
  id         boolean primary key default true,
  content    text not null default '',
  updated_at timestamptz not null default now(),
  constraint playbook_singleton check (id)
);

-- Seed the one row so the page/coach always have something to read.
insert into playbook (id, content) values (true, '') on conflict (id) do nothing;

alter table playbook enable row level security;
drop policy if exists "read playbook" on playbook;
create policy "read playbook" on playbook for select using (true);

-- Drop the now-defunct per-instance structured playbook so no stale copy can
-- shadow the global doc (the agent and coach no longer read it).
update instances set config = config - 'playbook' where config ? 'playbook';
