-- Step 025: the CRM pipeline stops repeating reply sentiment.
--
-- The pipeline offered 'interested', 'neutral' and 'negative' stages: the same
-- words the manual reply review (step 017) records as sentiment.  They date
-- from the retired pipeline_auto_advance, which copied sentiment into the
-- stage.  SDRs saw both on one row and could not tell which to trust.  The
-- reply review keeps sentiment; the pipeline now records only progress:
--
--   interested, neutral -> replied   (one neutral "Replied" stage, rank 1)
--   negative            -> lost      (lost_reason 'Negative reply', plus the
--                                     old soft/hard-no substatus when set)
--
-- The stage CHECK is widened, not narrowed: the old three slugs stay allowed
-- so the build deployed before this step keeps working during rollout.  The
-- application no longer writes them; a later step drops them from the CHECK.
-- pipeline_events history is left as recorded (an audit trail); the app labels
-- the old slugs as retired.  The substatus CHECK is unchanged for the same
-- reason.  pipeline_auto_advance is retired (never called since 2026-08-12),
-- but it is replaced so that it can only ever write 'replied'.

SET ROLE app_owner;

ALTER TABLE public.leads DROP CONSTRAINT leads_pipeline_stage_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_pipeline_stage_check CHECK (
  pipeline_stage IS NULL OR pipeline_stage = ANY (ARRAY[
    'first_contact'::text, 'replied'::text,
    'interested'::text, 'neutral'::text, 'negative'::text,
    'following_up'::text, 'negotiations_call'::text, 'call_booked'::text,
    'call_done'::text, 'proposal_in_progress'::text, 'proposal_presented'::text,
    'client'::text, 'lost'::text
  ])
);

UPDATE public.leads
   SET pipeline_stage = 'replied',
       pipeline_substatus = NULL
 WHERE pipeline_stage IN ('interested', 'neutral');

UPDATE public.leads
   SET pipeline_stage = 'lost',
       lost_reason = coalesce(nullif(btrim(lost_reason), ''),
         'Negative reply' || CASE pipeline_substatus
           WHEN 'soft_no' THEN ' (soft no)'
           WHEN 'hard_no' THEN ' (hard no)'
           ELSE ''
         END),
       pipeline_substatus = NULL
 WHERE pipeline_stage = 'negative';

CREATE OR REPLACE FUNCTION public.pipeline_auto_advance() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  updated_count integer;
  followup_count integer;
begin
  -- (1) Serialize concurrent invocations (cron vs UI button). Xact-scoped advisory
  -- lock keyed on the function name; auto-released at transaction end.
  perform pg_advisory_xact_lock(hashtext('pipeline_auto_advance'));

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
      -- Step 025: sentiment lives only on the reply review; the stage records
      -- that the lead replied. A negative reply is left for a human to close.
      'replied'::text as to_stage
    from leads l
    join latest_sentiment ls
      on l.instance_id = ls.instance_id
     and l.campaign_id = ls.campaign_id
     and l.profile_url = ls.profile_url
    where l.replied_at is not null
      and ls.sentiment <> 'negative'
      and (l.pipeline_stage is null or l.pipeline_stage = 'first_contact')
  ),
  updated as (
    update leads l
    set pipeline_stage            = t.to_stage,
        pipeline_stage_changed_at = now()
    from targets t
    where l.id = t.id
      -- (2) Re-assert the stage gate at UPDATE time. Under concurrency the row is
      -- re-read locked here, so a lead another invocation already advanced off
      -- NULL/'first_contact' is skipped and produces no duplicate pipeline_event.
      and (l.pipeline_stage is null or l.pipeline_stage = 'first_contact')
    returning l.id
  ),
  logged as (
    -- Data-modifying CTEs run to completion even when unreferenced by the main
    -- query, so this always fires for every UPDATED row. Driven off `updated`
    -- (not `targets`) so a row skipped by the re-asserted gate logs no event.
    insert into pipeline_events (lead_id, kind, actor, from_stage, to_stage, occurred_at)
    select t.id, 'stage', 'auto', t.from_stage, t.to_stage, now()
    from targets t
    join updated u on u.id = t.id
    returning 1
  )
  select count(*) into updated_count from updated;

  -- Phase 2: replied -> following_up for ghosted leads.
  with thread as (
    select instance_id, profile_url,
           max(sent_at) filter (where direction = 'in')  as last_in,
           max(sent_at) filter (where direction = 'out') as last_out
    from messages
    group by instance_id, profile_url
  ),
  last_stage_actor as (
    select distinct on (lead_id) lead_id, actor
    from pipeline_events
    where kind = 'stage'
    order by lead_id, occurred_at desc, id desc
  ),
  fu_targets as (
    select l.id, l.pipeline_stage as from_stage
    from leads l
    join thread t
      on t.instance_id = l.instance_id
     and t.profile_url = l.profile_url
    join last_stage_actor a on a.lead_id = l.id
    where l.pipeline_stage = 'replied'
      and a.actor = 'auto'
      and t.last_in is not null
      and t.last_in < now() - interval '14 days'
      and t.last_out > t.last_in
  ),
  fu_updated as (
    update leads l
    set pipeline_stage            = 'following_up',
        pipeline_substatus        = null,
        pipeline_stage_changed_at = now()
    from fu_targets t
    where l.id = t.id
      -- Re-asserted gate, same reasoning as phase 1's (2).
      and l.pipeline_stage = 'replied'
    returning l.id
  ),
  fu_logged as (
    insert into pipeline_events (lead_id, kind, actor, from_stage, to_stage, occurred_at)
    select t.id, 'stage', 'auto', t.from_stage, 'following_up', now()
    from fu_targets t
    join fu_updated u on u.id = t.id
    returning 1
  )
  select count(*) into followup_count from fu_updated;

  return updated_count + followup_count;
end;
$$;

RESET ROLE;
