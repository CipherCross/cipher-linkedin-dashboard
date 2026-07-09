-- Auto-advance: promote freshly-replied leads into the pipeline from the
-- sentiment of their latest classified inbound reply.
--
-- Set-based and idempotent. Called (42883-tolerant) at the end of classify.ts
-- (cron + Replies button) and reclassify.ts, and doubles as the launch backfill.
-- It NEVER downgrades a manual setting: it only touches leads whose pipeline_stage
-- is NULL or still at the rank-0 'first_contact', so anything a human has moved
-- forward (or set to client/lost) is left alone. A second run advances 0 rows.
--
-- Note on message columns (verified against migrations 005/012): inbound rows use
-- direction = 'in' (NOT 'inbound'), the classifier writes `sentiment`, and the
-- message time is `sent_at`. The lead<->message join key is (instance_id,
-- profile_url) per the CLAUDE.md leadKey convention.

create or replace function public.pipeline_auto_advance() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  with latest_sentiment as (
    -- One row per lead ROW: the sentiment of its most recent real inbound reply.
    -- Scoped by (instance_id, campaign_id, profile_url) because pipeline status is
    -- per lead row (campaign_id, profile_url) — the same person reached from two
    -- campaigns of one instance must NOT have campaign A triaged from campaign B's
    -- reply. (A message with a NULL campaign_id can't be attributed to a campaign
    -- row and so advances nothing, which is the correct conservative behaviour.)
    -- 'auto' (out-of-office / autoresponder) is skipped, not a real reply.
    select distinct on (instance_id, campaign_id, profile_url)
      instance_id, campaign_id, profile_url, sentiment
    from messages
    where direction = 'in'
      and sentiment is not null
      and sentiment <> 'auto'
    order by instance_id, campaign_id, profile_url, sent_at desc
  ),
  targets as (
    -- Snapshot the pre-update stage here (a plain SELECT CTE sees leads as of the
    -- statement snapshot) so the event's from_stage is the OLD value; an
    -- UPDATE ... RETURNING would only expose the new pipeline_stage.
    select
      l.id,
      l.pipeline_stage as from_stage,
      case ls.sentiment
        when 'positive' then 'interested'
        when 'negative' then 'negative'
        else 'neutral'                      -- neutral/objection/referral/...
      end as to_stage
    from leads l
    join latest_sentiment ls
      on l.instance_id = ls.instance_id
     and l.campaign_id = ls.campaign_id
     and l.profile_url = ls.profile_url
    where l.replied_at is not null
      and (l.pipeline_stage is null or l.pipeline_stage = 'first_contact')
  ),
  updated as (
    update leads l
    set pipeline_stage            = t.to_stage,
        pipeline_stage_changed_at = now()
    from targets t
    where l.id = t.id
    returning l.id
  ),
  logged as (
    -- Data-modifying CTEs run to completion even when unreferenced by the main
    -- query, so this always fires for every target row.
    insert into pipeline_events (lead_id, kind, actor, from_stage, to_stage, occurred_at)
    select t.id, 'stage', 'auto', t.from_stage, t.to_stage, now()
    from targets t
    returning 1
  )
  select count(*) into updated_count from updated;

  return updated_count;
end;
$$;

-- Service-role / RPC only. Mirrors the grant model of ai_execute_sql (021).
revoke all on function public.pipeline_auto_advance() from public, anon, authenticated;
grant execute on function public.pipeline_auto_advance() to service_role;

-- Stage x substatus x campaign rollup for the pipeline UI and the AI layer:
-- current counts, oldest-in-stage, and how many rows have sat >14 days.
create or replace view pipeline_metrics as
select
  campaign_id,
  instance_id,
  pipeline_stage,
  pipeline_substatus,
  count(*)                                                                as leads,
  min(pipeline_stage_changed_at)                                          as oldest_in_stage,
  count(*) filter (where pipeline_stage_changed_at < now() - interval '14 days') as stale_14d
from leads
where pipeline_stage is not null
group by 1, 2, 3, 4;
