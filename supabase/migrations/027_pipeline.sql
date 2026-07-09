-- Manual CRM pipeline layer.
--
-- The automated funnel ends at replied_at. This migration adds a team-editable
-- pipeline ON TOP of it: a per-lead stage + substatus + assignment, timestamped
-- notes, and an append-only change history. The LH2 milestone funnel stays
-- untouched as ground truth (see CLAUDE.md).
--
-- Two things worth stating up front:
--
-- (a) NO GUARD TRIGGER NEEDED. The five new leads columns below are NEVER part
--     of the sync agent's upsert payload (it sends a fixed set of milestone/
--     profile columns). PostgREST `merge-duplicates` only overwrites the keys it
--     is given, so these columns survive every re-sync untouched. This is unlike
--     the milestone columns, which the agent DOES send (as NULL) and therefore
--     needed the leads_keep_milestones trigger in migration 026.
--
-- (b) CAMPAIGN DELETION CASCADES. leads FK-cascade from campaigns; lead_notes and
--     pipeline_events FK-cascade from leads. Deleting a campaign therefore drops
--     its pipeline history along with its leads. Accepted — history is only
--     meaningful while the lead exists.

-- Lightweight teammate directory (no auth; who-am-I is honor-system).
-- Deactivate via `active`, never delete — assignments/events reference the name.
create table if not exists team_members (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Pipeline columns on leads. Agent never sends these -> survive re-sync (see (a)).
alter table leads add column if not exists pipeline_stage            text;
alter table leads add column if not exists pipeline_substatus        text;
alter table leads add column if not exists lost_reason               text;
alter table leads add column if not exists pipeline_stage_changed_at timestamptz;
alter table leads add column if not exists assigned_to               bigint
  references team_members(id) on delete set null;

-- Flat backstop CHECKs. The valid stage<->substatus PAIRING is enforced in the
-- API layer (single write path); these only pin each column to its slug list.
-- drop-then-add so re-running the migration is safe (026 style).
alter table leads drop constraint if exists leads_pipeline_stage_check;
alter table leads add constraint leads_pipeline_stage_check check (
  pipeline_stage is null or pipeline_stage in (
    'first_contact','interested','neutral','negative','negotiations_call',
    'call_booked','call_done','proposal_in_progress','proposal_presented',
    'client','lost'
  )
);

alter table leads drop constraint if exists leads_pipeline_substatus_check;
alter table leads add constraint leads_pipeline_substatus_check check (
  pipeline_substatus is null or pipeline_substatus in (
    'soft_no','hard_no','lost','proposal','later','not_a_fit',
    'waiting_decision','contract','needs_changes'
  )
);

-- Board/assignment queries hit only leads that are in the pipeline / assigned.
create index if not exists leads_pipeline_stage_idx
  on leads (pipeline_stage) where pipeline_stage is not null;
create index if not exists leads_assigned_to_idx
  on leads (assigned_to) where assigned_to is not null;

-- Per-lead timestamped notes.
create table if not exists lead_notes (
  id         bigint generated always as identity primary key,
  lead_id    uuid not null references leads(id) on delete cascade,
  author     text,
  body       text not null,
  created_at timestamptz default now()
);

create index if not exists lead_notes_lead_idx
  on lead_notes (lead_id, created_at desc);

-- Append-only audit log of stage/assignment changes. actor = teammate name or
-- 'auto' (the auto-advance RPC in 028). Only the columns relevant to `kind` are
-- populated per row.
create table if not exists pipeline_events (
  id             bigint generated always as identity primary key,
  lead_id        uuid not null references leads(id) on delete cascade,
  kind           text not null check (kind in ('stage','assignment')),
  actor          text not null default 'unknown',
  from_stage     text,
  to_stage       text,
  from_substatus text,
  to_substatus   text,
  from_assignee  text,
  to_assignee    text,
  lost_reason    text,
  occurred_at    timestamptz not null default now()
);

create index if not exists pipeline_events_lead_idx
  on pipeline_events (lead_id, occurred_at);
create index if not exists pipeline_events_time_idx
  on pipeline_events (occurred_at);

-- RLS: read-only-open, matching the rest of the schema. The anon frontend reads
-- these tables directly; all writes go through the service-role key (Vercel
-- /api/pipeline + the 028 RPC), which bypasses RLS.
alter table team_members    enable row level security;
alter table lead_notes      enable row level security;
alter table pipeline_events enable row level security;

drop policy if exists "read team_members"    on team_members;
create policy "read team_members"    on team_members    for select using (true);
drop policy if exists "read lead_notes"       on lead_notes;
create policy "read lead_notes"       on lead_notes       for select using (true);
drop policy if exists "read pipeline_events"  on pipeline_events;
create policy "read pipeline_events"  on pipeline_events  for select using (true);
