-- Split the AI briefing into two independent cadences and give the team a
-- durable, campaign-scoped place to explain operational context that metrics
-- cannot reveal (re-engagement batches, audience changes, temporary tests, etc.).

alter table campaigns
  add column if not exists briefing_context text,
  add column if not exists briefing_context_updated_at timestamptz;

alter table campaigns
  drop constraint if exists campaigns_briefing_context_length;

alter table campaigns
  add constraint campaigns_briefing_context_length
    check (briefing_context is null or char_length(briefing_context) <= 4000);

-- campaign_metrics is the frontend's campaign source. Append the context fields
-- without changing any funnel semantics or existing column order.
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
  round(100.0 * count(l.connected_at) filter (where l.invited_at is not null)
        / nullif(count(l.invited_at), 0), 1)          as acceptance_rate,
  round(100.0 * count(l.replied_at) filter (where l.connected_at is not null)
        / nullif(count(l.connected_at), 0), 1)        as reply_rate,
  max(l.last_action_at)                               as last_activity_at,
  c.briefing_context,
  c.briefing_context_updated_at
from campaigns c
left join leads l on l.campaign_id = c.id
group by c.id;

alter table briefings
  add column if not exists briefing_kind text not null default 'daily',
  add column if not exists period_start date,
  add column if not exists period_end date;

alter table briefings
  drop constraint if exists briefings_briefing_date_key;

alter table briefings
  drop constraint if exists briefings_briefing_kind_check;

alter table briefings
  add constraint briefings_briefing_kind_check
    check (briefing_kind in ('daily', 'weekly'));

alter table briefings
  drop constraint if exists briefings_date_kind_key;

alter table briefings
  add constraint briefings_date_kind_key
    unique (briefing_date, briefing_kind);

create index if not exists briefings_kind_date_idx
  on briefings (briefing_kind, briefing_date desc);

alter table briefing_jobs
  add column if not exists briefing_kind text not null default 'daily';

alter table briefing_jobs
  drop constraint if exists briefing_jobs_briefing_kind_check;

alter table briefing_jobs
  add constraint briefing_jobs_briefing_kind_check
    check (briefing_kind in ('daily', 'weekly'));

alter table briefing_jobs
  drop constraint if exists briefing_jobs_pkey;

alter table briefing_jobs
  add primary key (briefing_date, briefing_kind);

comment on column campaigns.briefing_context is
  'Team-provided operational background for AI briefings; context, not measured telemetry.';
comment on column briefings.briefing_kind is
  'daily = short weekday operational note; weekly = longer Monday review.';
comment on column briefings.briefing_date is
  'UTC run date for daily rows; Monday week key for weekly rows.';
