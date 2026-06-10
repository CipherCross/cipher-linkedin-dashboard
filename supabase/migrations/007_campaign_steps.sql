-- Per-campaign outbound message sequence (steps) with send/reply aggregates,
-- populated by the sync agent's extract_steps (LH2 campaign_version_actions ->
-- actions -> action_configs, executions in action_result_messages).
--
-- step_index is 0-based position in the campaign's LATEST version sequence.
-- sent_count   = people who received this step's message
-- replied_count= people whose first reply is attributable to this step
--                (reply landed between this send and their next send)
-- current_count= people whose furthest-reached step is this one ("now here")
--
-- PRIVACY: template_body is the message copy and is anon-readable here, same
-- tradeoff as the messages table — lock down with Supabase Auth when ready.

create table if not exists campaign_steps (
  campaign_id   text not null references campaigns(id) on delete cascade,
  step_index    int  not null,
  step_label    text,
  step_type     text,
  template_body text,
  sent_count    int  not null default 0,
  replied_count int  not null default 0,
  current_count int  not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (campaign_id, step_index)
);

alter table campaign_steps enable row level security;

drop policy if exists "anon read campaign_steps" on campaign_steps;
create policy "anon read campaign_steps" on campaign_steps
  for select using (true);
