-- LinkedIn campaign dashboard schema
-- Run via: supabase db push, or paste into the Supabase SQL editor.

create extension if not exists pgcrypto;

-- One row per Linked Helper 2 instance (you have 3 notebooks = 3 instances).
create table if not exists instances (
  id            text primary key,           -- stable key you choose, e.g. "notebook-kyiv"
  label         text not null default '',
  last_sync_at  timestamptz,
  agent_version text,
  created_at    timestamptz not null default now()
);

create table if not exists campaigns (
  id             text primary key,          -- "<instance_id>:<lh_campaign_id>"
  instance_id    text not null references instances(id) on delete cascade,
  lh_campaign_id text not null,
  name           text not null,
  status         text not null default 'active',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (instance_id, lh_campaign_id)
);

-- One row per person per campaign. The sync agent upserts these; the
-- timestamp columns drive the funnel metrics.
create table if not exists leads (
  id               uuid primary key default gen_random_uuid(),
  instance_id      text not null references instances(id) on delete cascade,
  campaign_id      text not null references campaigns(id) on delete cascade,
  profile_url      text not null,
  full_name        text,
  headline         text,
  company          text,
  status           text,                    -- raw LH2 status string
  invited_at       timestamptz,
  connected_at     timestamptz,
  first_message_at timestamptz,
  replied_at       timestamptz,
  last_action_at   timestamptz,
  raw              jsonb,
  updated_at       timestamptz not null default now(),
  unique (campaign_id, profile_url)
);

create index if not exists leads_instance_idx on leads (instance_id);
create index if not exists leads_campaign_idx on leads (campaign_id);

-- Append-only action log, used for the daily-activity chart.
create table if not exists events (
  id          bigint generated always as identity primary key,
  instance_id text not null references instances(id) on delete cascade,
  campaign_id text references campaigns(id) on delete cascade,
  profile_url text,
  event_type  text not null,                -- invite_sent | invite_accepted | message_sent | reply_received | ...
  occurred_at timestamptz not null,
  raw         jsonb,
  unique (instance_id, campaign_id, profile_url, event_type, occurred_at)
);

create index if not exists events_time_idx on events (occurred_at);

create table if not exists sync_runs (
  id            uuid primary key default gen_random_uuid(),
  instance_id   text not null references instances(id) on delete cascade,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',  -- running | ok | error
  rows_upserted integer not null default 0,
  error         text
);

-- Funnel metrics per campaign, consumed directly by the frontend.
create or replace view campaign_metrics as
select
  c.id            as campaign_id,
  c.name          as campaign_name,
  c.instance_id,
  c.status,
  count(l.id)                                         as total_leads,
  count(l.invited_at)                                 as invites_sent,
  count(l.connected_at)                               as accepted,
  count(l.replied_at)                                 as replies,
  round(100.0 * count(l.connected_at) / nullif(count(l.invited_at), 0), 1) as acceptance_rate,
  round(100.0 * count(l.replied_at)  / nullif(count(l.connected_at), 0), 1) as reply_rate,
  max(l.last_action_at)                               as last_activity_at
from campaigns c
left join leads l on l.campaign_id = c.id
group by c.id;

create or replace view daily_activity as
select
  date_trunc('day', occurred_at)::date as day,
  instance_id,
  event_type,
  count(*) as cnt
from events
group by 1, 2, 3;

-- RLS: dashboard reads with the anon key; only the sync agent (service-role
-- key, which bypasses RLS) can write. Tighten to authenticated-only once you
-- enable Supabase Auth for the team.
alter table instances  enable row level security;
alter table campaigns  enable row level security;
alter table leads      enable row level security;
alter table events     enable row level security;
alter table sync_runs  enable row level security;

create policy "read instances"  on instances  for select using (true);
create policy "read campaigns"  on campaigns  for select using (true);
create policy "read leads"      on leads      for select using (true);
create policy "read events"     on events     for select using (true);
create policy "read sync_runs"  on sync_runs  for select using (true);
