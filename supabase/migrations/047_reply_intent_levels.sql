-- Commercial reply intent is orthogonal to sentiment:
--   P1 = polite positive acknowledgement
--   P2 = substantive problem interest / qualifying questions
--   P3 = concrete buying intent / next-step readiness
--
-- Keep sentiment intact: a reply can be an objection AND P3 ("too expensive,
-- but let's discuss it on a call"). Intent metadata is separate so manual
-- sentiment corrections survive the historical intent backfill.

alter table messages
  add column if not exists intent_level text
    check (intent_level in ('p1', 'p2', 'p3')),
  add column if not exists intent_reason text,
  add column if not exists intent_classified_at timestamptz,
  add column if not exists intent_classified_model text,
  add column if not exists intent_taxonomy_version text;

-- The classifier repeatedly drains rows not evaluated under the current
-- taxonomy. NULL is a valid intent result, so version (not intent_level) is the
-- authoritative "processed" marker.
create index if not exists messages_intent_backlog_idx
  on messages (sent_at desc)
  where direction = 'in'
    and coalesce(sentiment, '') <> 'auto'
    and coalesce(intent_taxonomy_version, '') <> 'p123-v1';

create or replace view campaign_reply_intent as
select campaign_id, intent_level, count(*) as cnt
from messages
where direction = 'in'
  and intent_level is not null
group by campaign_id, intent_level;

-- One durable row per LinkedIn conversation. first_p3_at/campaign_id fix the
-- cohort and attribution at the moment buying intent first appears; a later P1
-- acknowledgement cannot erase it.
create or replace view conversation_reply_intent as
with ranked as (
  select
    instance_id,
    profile_url,
    campaign_id,
    sent_at,
    intent_level,
    row_number() over (
      partition by instance_id, profile_url
      order by
        case intent_level when 'p3' then 3 when 'p2' then 2 when 'p1' then 1 else 0 end desc,
        sent_at asc,
        id asc
    ) as highest_rn,
    row_number() over (
      partition by instance_id, profile_url, intent_level
      order by sent_at asc, id asc
    ) as level_rn
  from messages
  where direction = 'in'
    and intent_level is not null
),
milestones as (
  select
    instance_id,
    profile_url,
    max(intent_level) filter (where highest_rn = 1) as highest_intent,
    min(sent_at) filter (where intent_level = 'p1') as first_p1_at,
    min(sent_at) filter (where intent_level = 'p2') as first_p2_at,
    min(sent_at) filter (where intent_level = 'p3') as first_p3_at,
    max(campaign_id) filter (where intent_level = 'p3' and level_rn = 1) as first_p3_campaign_id
  from ranked
  group by instance_id, profile_url
)
select
  mi.instance_id,
  mi.profile_url,
  mi.highest_intent,
  mi.first_p1_at,
  mi.first_p2_at,
  mi.first_p3_at,
  mi.first_p3_campaign_id,
  max(m.sent_at) filter (
    where m.direction = 'out' and m.sent_at > mi.first_p3_at
  ) as last_out_after_p3_at,
  max(m.sent_at) filter (
    where m.direction = 'in' and m.sent_at > mi.first_p3_at
  ) as last_in_after_p3_at
from milestones mi
left join messages m
  on m.instance_id = mi.instance_id
 and m.profile_url = mi.profile_url
group by
  mi.instance_id,
  mi.profile_url,
  mi.highest_intent,
  mi.first_p1_at,
  mi.first_p2_at,
  mi.first_p3_at,
  mi.first_p3_campaign_id;

comment on column messages.intent_level is
  'Commercial reply intent: p1 polite positive, p2 problem interest, p3 buying intent; independent of sentiment.';
comment on column messages.intent_taxonomy_version is
  'Version of the intent rubric applied. Non-null even when intent_level is NULL.';
