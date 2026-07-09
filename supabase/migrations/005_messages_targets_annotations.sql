-- Reply texts (synced via the optional mapping.messages query), manual chart
-- annotations (`agent.py annotate`), and per-account weekly invite targets.
--
-- PRIVACY NOTE: like the rest of the schema these tables are anon-readable,
-- so reply contents become visible to anyone holding the publishable key.
-- Lock down with Supabase Auth (see README security notes) if that matters.

create table if not exists messages (
  id bigint generated always as identity primary key,
  instance_id text not null references instances(id),
  campaign_id text,
  profile_url text not null,
  direction text not null default 'in',
  body text,
  sent_at timestamptz not null,
  unique (instance_id, profile_url, direction, sent_at)
);

create table if not exists annotations (
  id bigint generated always as identity primary key,
  instance_id text,        -- null = applies to all accounts
  campaign_id text,        -- null = applies to all campaigns
  note text not null,
  noted_at date not null default current_date,
  created_at timestamptz not null default now(),
  unique (note, noted_at)
);

alter table instances add column if not exists weekly_invite_target int;

alter table messages enable row level security;
alter table annotations enable row level security;
drop policy if exists "messages are readable" on messages;
create policy "messages are readable" on messages for select using (true);
drop policy if exists "annotations are readable" on annotations;
create policy "annotations are readable" on annotations for select using (true);
