-- Following-up stage + manual-message deletion.
--
-- (1) New pipeline stage 'following_up': a semi-warm holding lane for leads who
--     replied at least once and then went silent on our follow-ups. Reachable
--     both by hand (board drag / stage selects) and by pipeline_auto_advance's
--     new phase 2 (below).
-- (2) pipeline_auto_advance v3: 033's body unchanged (advisory lock + sentiment
--     triage), plus a phase that parks ghosted interested/neutral leads in
--     following_up.
-- (3) delete_manual_message RPC for /api/import-conversation's delete_message
--     action: removes ONE manually-imported message and repairs the lead
--     milestones the import backfilled from it. leads_keep_milestones gains a
--     transaction-local escape hatch so that repair can NULL a milestone the
--     deleted message was the only evidence for.

-- ---------------------------------------------------------------------------
-- (1) Stage vocabulary: add 'following_up' after the rank-1 sentiment trio.
-- Keep in sync with frontend/api/_lib/pipeline.ts and frontend/src/lib/pipeline.ts.
alter table leads drop constraint if exists leads_pipeline_stage_check;
alter table leads add constraint leads_pipeline_stage_check check (
  pipeline_stage is null or pipeline_stage in (
    'first_contact',
    'interested',
    'neutral',
    'negative',
    'following_up',
    'negotiations_call',
    'call_booked',
    'call_done',
    'proposal_in_progress',
    'proposal_presented',
    'client',
    'lost'
  )
);

-- ---------------------------------------------------------------------------
-- (2) pipeline_auto_advance v3.
--
-- Phase 1 is a verbatim copy of 033 (comments included) so the two stay
-- diff-able. Phase 2 is new: park ghosted leads in 'following_up'.
--
-- Phase 2 rules (all must hold):
--   * current stage is 'interested' or 'neutral', AND that stage was set by
--     actor='auto' (latest 'stage' pipeline_event). Auto never overrides a
--     human-set stage; this also means a lead a human dragged OUT of
--     following_up is never re-parked — the drag is the latest stage event.
--     Leads with a stage but no stage events are conservatively treated as
--     human-set (the join excludes them).
--   * the lead's last inbound message is >= 14 days old, AND
--   * an outbound message was RECORDED after that last inbound. This guards the
--     manual-reply blind spot: when the SDR takes a thread over by hand, LH2
--     records nothing, so silence in the data is ambiguous. A recorded outbound
--     that went unanswered is demonstrable ghosting.
-- Thread scope is (instance_id, profile_url) — follow-ups happen in ONE
-- LinkedIn thread regardless of which campaign row holds the stage.
--
-- Ordering note: phase 2 is a later statement in the same transaction, so it
-- sees phase 1's writes. A lead whose stale positive reply is classified late
-- can therefore hop first_contact -> interested -> following_up in ONE
-- invocation, logging both events — honest history, correct end state.
create or replace function public.pipeline_auto_advance() returns integer
language plpgsql
security definer
set search_path = public
as $$
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

  -- Phase 2 (new in 039): interested/neutral -> following_up for ghosted leads.
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
    where l.pipeline_stage in ('interested', 'neutral')
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
      and l.pipeline_stage in ('interested', 'neutral')
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

-- Service-role / RPC only. Mirrors the grant model of ai_execute_sql (021).
revoke all on function public.pipeline_auto_advance() from public, anon, authenticated;
grant execute on function public.pipeline_auto_advance() to service_role;

-- ---------------------------------------------------------------------------
-- (3a) Milestone-guard escape hatch. 026's trigger blocks every non-NULL -> NULL
-- milestone update, which is right for sync upserts but wrong for
-- delete_manual_message: deleting the only inbound message of a mis-pasted
-- import must be able to take replied_at back to NULL. The hatch is a
-- TRANSACTION-LOCAL GUC set via set_config(..., true) — session-private, resets
-- at commit/rollback, zero blast radius — deliberately NOT
-- ALTER TABLE ... DISABLE TRIGGER, which is DDL that would drop the guard for
-- every concurrent session (an agent re-sync landing in that window would
-- clobber milestones fleet-wide).
create or replace function public.leads_keep_milestones() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.allow_milestone_regress', true), '') = 'on' then
    return new;  -- delete_manual_message's recompute path (this migration)
  end if;
  new.invited_at       := coalesce(new.invited_at,       old.invited_at);
  new.connected_at     := coalesce(new.connected_at,     old.connected_at);
  new.first_message_at := coalesce(new.first_message_at, old.first_message_at);
  new.replied_at       := coalesce(new.replied_at,       old.replied_at);
  new.added_at         := coalesce(new.added_at,         old.added_at);
  return new;
end $$;
-- Trigger itself (026) is unchanged; CREATE OR REPLACE swaps the body in place.

-- (3b) Delete one manually-imported message and repair derived milestones.
--
-- Only source='manual' rows are deletable: sync rows are LH2 ground truth and
-- would be resurrected by the next agent sync anyway. A milestone is repaired
-- only when it EQUALS the deleted message's sent_at — i.e. was plausibly
-- backfilled from that very row by /api/import-conversation. LH2-sourced
-- milestones carry action-run times that practically never coincide with a
-- pasted row's real message time, so they are naturally left alone. The
-- replacement value is recomputed from the REMAINING thread messages and may be
-- NULL (see 3a) — reversing a mis-pasted import is the point.
create or replace function public.delete_manual_message(p_message_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  msg messages%rowtype;
  new_min_in  timestamptz;
  new_min_out timestamptz;
  new_min_any timestamptz;
  patched integer := 0;
begin
  delete from messages
  where id = p_message_id
    and source = 'manual'
  returning * into msg;
  if not found then
    -- Missing id OR a sync row: indistinguishable on purpose (the API 404s both).
    return jsonb_build_object('deleted', false);
  end if;

  select min(sent_at) filter (where direction = 'in'),
         min(sent_at) filter (where direction = 'out'),
         min(sent_at)
    into new_min_in, new_min_out, new_min_any
  from messages
  where instance_id = msg.instance_id
    and profile_url = msg.profile_url;

  perform set_config('app.allow_milestone_regress', 'on', true);  -- txn-local

  -- Deliberately broader than the import backfill (which patches only the one
  -- lead row of the imported campaign): every lead row of this person on this
  -- instance is checked, so a milestone derived from this row is repaired
  -- whichever campaign it sits on. Safe because only exact sent_at matches are
  -- touched — LH2 action-run times practically never coincide with a pasted
  -- row's real message time.
  update leads l
     set replied_at       = case when msg.direction = 'in'  and l.replied_at       = msg.sent_at
                                 then new_min_in  else l.replied_at end,
         first_message_at = case when msg.direction = 'out' and l.first_message_at = msg.sent_at
                                 then new_min_out else l.first_message_at end,
         connected_at     = case when l.connected_at = msg.sent_at
                                 then new_min_any else l.connected_at end
   where l.instance_id = msg.instance_id
     and l.profile_url = msg.profile_url
     and (   (msg.direction = 'in'  and l.replied_at       = msg.sent_at)
          or (msg.direction = 'out' and l.first_message_at = msg.sent_at)
          or  l.connected_at = msg.sent_at);
  get diagnostics patched = row_count;

  return jsonb_build_object('deleted', true, 'milestones_recomputed', patched);
end;
$$;

revoke all on function public.delete_manual_message(bigint) from public, anon, authenticated;
grant execute on function public.delete_manual_message(bigint) to service_role;
