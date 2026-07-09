-- Make pipeline_auto_advance concurrency-safe.
--
-- 028's function is invoked from BOTH the classify cron AND a UI button, which can
-- run at the same time. Both invocations open the `targets` CTE against their own
-- statement snapshot, so both see the SAME not-yet-advanced leads. Row locks on the
-- UPDATE serialize the two writers but do NOT re-evaluate the WHERE against the
-- other's committed change, so each also runs its `logged` INSERT for that target —
-- producing DUPLICATE pipeline_events rows for one real stage change.
--
-- Two independent fixes, either of which suffices; we apply both (belt and braces):
--   (1) pg_advisory_xact_lock at the top serializes whole invocations, so the second
--       caller only starts after the first commits and its snapshot sees the advance.
--   (2) The updated CTE re-asserts the stage gate in its own WHERE. Even without the
--       lock, once the first txn commits, the second's UPDATE re-reads each row under
--       a lock and skips any lead already moved off NULL/'first_contact', so no second
--       row is updated and (targets being driven off the same predicate) no duplicate
--       event is logged for it.
-- The lock is xact-scoped: it auto-releases at commit/rollback, no manual unlock.
--
-- Everything else is a verbatim copy of 028's body (comments included) so the two
-- stay diff-able; only the two lines noted below are new.

create or replace function public.pipeline_auto_advance() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
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

  return updated_count;
end;
$$;

-- Service-role / RPC only. Mirrors the grant model of ai_execute_sql (021).
revoke all on function public.pipeline_auto_advance() from public, anon, authenticated;
grant execute on function public.pipeline_auto_advance() to service_role;
