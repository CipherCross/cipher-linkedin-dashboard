\set ON_ERROR_STOP on

-- The clean-room invokes this file as the separate app_runtime principal.
-- Identity and business fixtures were seeded by app_migration in a different
-- connection; no owner role is used to prove a result here. Every case runs in
-- its own transaction and rolls back, so the fixtures stay pristine.

-- ---------------------------------------------------------------------------
-- Actor context still gates the function surface.
-- ---------------------------------------------------------------------------

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
SELECT 1 / CASE WHEN public.is_active_team_member() THEN 1 ELSE 0 END AS valid_actor_is_active_member;
SELECT 1 / CASE WHEN NOT public.is_app_admin() THEN 1 ELSE 0 END AS valid_member_actor_is_not_admin;
ROLLBACK;

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000002';
SELECT 1 / CASE WHEN public.is_active_team_member() AND public.is_app_admin() THEN 1 ELSE 0 END AS admin_actor_recognised;
ROLLBACK;

BEGIN;
RESET app.actor_id;
SELECT 1 / CASE WHEN NOT public.is_active_team_member() AND NOT public.is_app_admin() THEN 1 ELSE 0 END AS missing_actor_denied;
ROLLBACK;

BEGIN;
SET LOCAL app.actor_id = 'not-a-uuid';
SELECT 1 / CASE WHEN NOT public.is_active_team_member() AND NOT public.is_app_admin() THEN 1 ELSE 0 END AS malformed_actor_denied;
ROLLBACK;

BEGIN;
SET LOCAL app.actor_id = '';
SELECT 1 / CASE WHEN NOT public.is_active_team_member() AND NOT public.is_app_admin() THEN 1 ELSE 0 END AS empty_actor_denied;
ROLLBACK;

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000099';
SELECT 1 / CASE WHEN NOT public.is_active_team_member() AND NOT public.is_app_admin() THEN 1 ELSE 0 END AS unknown_actor_denied;
ROLLBACK;

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000003';
SELECT 1 / CASE WHEN NOT public.is_active_team_member() AND NOT public.is_app_admin() THEN 1 ELSE 0 END AS inactive_actor_denied;
ROLLBACK;

-- S07 adds no trigger-mediated bypass: without a valid actor the business DML
-- that would fire the triggers is still refused by the S06 policies, so neither
-- the BEFORE UPDATE milestone trigger nor the AFTER DELETE follow-up trigger
-- ever runs. RLS hides the rows from UPDATE/DELETE rather than raising, so the
-- assertion is on the affected row count; INSERT is the case that raises.
BEGIN;
RESET app.actor_id;
DO $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.leads SET full_name = 'must not change'
   WHERE id = '11111111-1111-4111-8111-111111111111';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'a lead update without an actor changed % rows', v_count;
  END IF;

  DELETE FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'a lead delete without an actor removed % rows', v_count;
  END IF;

  BEGIN
    INSERT INTO public.leads (instance_id, campaign_id, profile_url)
    VALUES ('notebook-test', 'notebook-test:1', 'https://example.test/in/delta');
    RAISE EXCEPTION 'a lead insert without an actor unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

-- The rows are still intact when a valid actor looks again.
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.leads) = 3
                 AND (SELECT full_name FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111') = 'Alpha Person'
           THEN 1 ELSE 0 END AS actorless_dml_left_no_trace;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Milestone preservation.
-- ---------------------------------------------------------------------------

-- NULL -> non-NULL is allowed and stores the supplied value verbatim.
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE public.leads
   SET invited_at       = '2026-02-01 10:00:00+00',
       connected_at     = '2026-02-02 10:00:00+00',
       first_message_at = '2026-02-03 10:00:00+00',
       replied_at       = '2026-02-04 10:00:00+00',
       added_at         = '2026-01-31 10:00:00+00'
 WHERE id = '22222222-2222-4222-8222-222222222222';
SELECT 1 / CASE WHEN (SELECT invited_at       FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222') = '2026-02-01 10:00:00+00'::timestamptz
                 AND (SELECT connected_at     FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222') = '2026-02-02 10:00:00+00'::timestamptz
                 AND (SELECT first_message_at FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222') = '2026-02-03 10:00:00+00'::timestamptz
                 AND (SELECT replied_at       FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222') = '2026-02-04 10:00:00+00'::timestamptz
                 AND (SELECT added_at         FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222') = '2026-01-31 10:00:00+00'::timestamptz
           THEN 1 ELSE 0 END AS milestone_null_to_non_null_allowed;
ROLLBACK;

-- non-NULL -> NULL is preserved, not applied. The source contract silently
-- restores the previous value instead of raising.
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE public.leads
   SET invited_at = NULL, connected_at = NULL, first_message_at = NULL,
       replied_at = NULL, added_at = NULL
 WHERE id = '11111111-1111-4111-8111-111111111111';
SELECT 1 / CASE WHEN (SELECT invited_at       FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111') = '2026-01-05 10:00:00+00'::timestamptz
                 AND (SELECT connected_at     FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111') = '2026-01-07 11:00:00+00'::timestamptz
                 AND (SELECT first_message_at FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111') = '2026-01-08 12:00:00+00'::timestamptz
                 AND (SELECT replied_at       FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111') = '2026-01-09 13:00:00+00'::timestamptz
                 AND (SELECT added_at         FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111') = '2026-01-04 09:00:00+00'::timestamptz
           THEN 1 ELSE 0 END AS milestone_non_null_to_null_blocked;
ROLLBACK;

-- A later milestone may still advance forward while the others are preserved.
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE public.leads
   SET invited_at = NULL, replied_at = '2026-01-15 13:00:00+00'
 WHERE id = '11111111-1111-4111-8111-111111111111';
SELECT 1 / CASE WHEN (SELECT invited_at FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111') = '2026-01-05 10:00:00+00'::timestamptz
                 AND (SELECT replied_at FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111') = '2026-01-15 13:00:00+00'::timestamptz
           THEN 1 ELSE 0 END AS milestone_partial_update_preserved;
ROLLBACK;

-- A repeated sync upsert that carries no milestone values is idempotent: the
-- first replay preserves every milestone and the second changes nothing.
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
DO $$
DECLARE
  v_first  public.leads%rowtype;
  v_second public.leads%rowtype;
BEGIN
  FOR i IN 1..2 LOOP
    INSERT INTO public.leads (instance_id, campaign_id, profile_url, full_name,
                              invited_at, connected_at, first_message_at, replied_at, added_at)
    VALUES ('notebook-test', 'notebook-test:1', 'https://example.test/in/alpha', 'Alpha Person',
            NULL, NULL, NULL, NULL, NULL)
    ON CONFLICT (campaign_id, profile_url) DO UPDATE
      SET full_name        = EXCLUDED.full_name,
          invited_at       = EXCLUDED.invited_at,
          connected_at     = EXCLUDED.connected_at,
          first_message_at = EXCLUDED.first_message_at,
          replied_at       = EXCLUDED.replied_at,
          added_at         = EXCLUDED.added_at;

    IF i = 1 THEN
      SELECT * INTO v_first FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111';
    ELSE
      SELECT * INTO v_second FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111';
    END IF;
  END LOOP;

  IF v_first.invited_at       <> '2026-01-05 10:00:00+00'::timestamptz
     OR v_first.connected_at     <> '2026-01-07 11:00:00+00'::timestamptz
     OR v_first.first_message_at <> '2026-01-08 12:00:00+00'::timestamptz
     OR v_first.replied_at       <> '2026-01-09 13:00:00+00'::timestamptz
     OR v_first.added_at         <> '2026-01-04 09:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'a re-sync upsert regressed a milestone: %', to_jsonb(v_first);
  END IF;
  IF v_second IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'a repeated re-sync upsert was not idempotent';
  END IF;
END
$$;
SELECT 'repeated sync upsert preserves milestones' AS repeated_upsert_idempotent;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- touch_updated_at.
-- ---------------------------------------------------------------------------

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
DO $$
DECLARE
  v_before timestamptz;
  v_noop   timestamptz;
  v_after  timestamptz;
BEGIN
  SELECT updated_at INTO v_before FROM public.campaigns WHERE id = 'notebook-test:1';

  UPDATE public.campaigns SET name = name WHERE id = 'notebook-test:1';
  SELECT updated_at INTO v_noop FROM public.campaigns WHERE id = 'notebook-test:1';
  IF v_noop <> v_before THEN
    RAISE EXCEPTION 'touch_updated_at bumped updated_at on a no-op update';
  END IF;

  -- The agent's own updated_at stamp must not win over the trigger.
  UPDATE public.campaigns
     SET name = 'Renamed campaign', updated_at = '2000-01-01 00:00:00+00'
   WHERE id = 'notebook-test:1';
  SELECT updated_at INTO v_after FROM public.campaigns WHERE id = 'notebook-test:1';
  IF v_after <= v_before THEN
    RAISE EXCEPTION 'touch_updated_at did not bump updated_at on a real change';
  END IF;
END
$$;
SELECT 'touch_updated_at bumps only on real changes' AS touch_updated_at_contract;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- refresh_lead_age_estimate.
-- ---------------------------------------------------------------------------

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
DO $$
DECLARE
  v public.leads%rowtype;
BEGIN
  UPDATE public.leads SET education_start_year = 2010
   WHERE id = '22222222-2222-4222-8222-222222222222';
  SELECT * INTO v FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222';
  IF v.birth_year_min <> 1989 OR v.birth_year_max <> 1994
     OR v.age_source <> 'education' OR v.age_method_version <> 'career-signals-v2'
     OR v.age_inferred_at IS NULL THEN
    RAISE EXCEPTION 'education-only age estimate mismatch: %', to_jsonb(v);
  END IF;

  UPDATE public.leads SET first_job_start_year = 2014
   WHERE id = '22222222-2222-4222-8222-222222222222';
  SELECT * INTO v FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222';
  IF v.birth_year_min <> 1989 OR v.birth_year_max <> 1994 OR v.age_source <> 'combined' THEN
    RAISE EXCEPTION 'combined age estimate mismatch: %', to_jsonb(v);
  END IF;

  UPDATE public.leads SET education_start_year = 1951, first_job_start_year = 2020
   WHERE id = '22222222-2222-4222-8222-222222222222';
  SELECT * INTO v FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222';
  IF v.birth_year_min IS NOT NULL OR v.birth_year_max IS NOT NULL OR v.age_source <> 'conflict' THEN
    RAISE EXCEPTION 'conflicting age estimate was not rejected: %', to_jsonb(v);
  END IF;

  UPDATE public.leads SET education_start_year = NULL, first_job_start_year = NULL
   WHERE id = '22222222-2222-4222-8222-222222222222';
  SELECT * INTO v FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222';
  IF v.birth_year_min IS NOT NULL OR v.birth_year_max IS NOT NULL
     OR v.age_source IS NOT NULL OR v.age_method_version IS NOT NULL
     OR v.age_inferred_at IS NOT NULL THEN
    RAISE EXCEPTION 'clearing the career signals did not clear the age estimate: %', to_jsonb(v);
  END IF;
END
$$;
SELECT 'refresh_lead_age_estimate derives and clears as in the source' AS age_estimate_contract;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- reset_lead_gender_on_input_change.
-- ---------------------------------------------------------------------------

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
DO $$
DECLARE
  v public.leads%rowtype;
BEGIN
  -- Seeding the inferred demographics does not list full_name/headline, so the
  -- trigger stays silent.
  UPDATE public.leads
     SET gender = 'female', gender_confidence = 0.9, gender_inferred_at = now(),
         gender_model_version = 'fixture-v1', demo_inferred_at = now(), demo_model = 'fixture'
   WHERE id = '22222222-2222-4222-8222-222222222222';
  SELECT * INTO v FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222';
  IF v.gender IS DISTINCT FROM 'female' THEN
    RAISE EXCEPTION 'gender seed was cleared by an unrelated update';
  END IF;

  UPDATE public.leads SET headline = 'New headline'
   WHERE id = '22222222-2222-4222-8222-222222222222';
  SELECT * INTO v FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222';
  IF v.gender IS NOT NULL OR v.gender_confidence IS NOT NULL
     OR v.gender_inferred_at IS NOT NULL OR v.gender_model_version IS NOT NULL
     OR v.demo_inferred_at IS NOT NULL OR v.demo_model IS NOT NULL THEN
    RAISE EXCEPTION 'changing the headline did not reset the inferred gender: %', to_jsonb(v);
  END IF;

  -- A manual label survives an input change.
  UPDATE public.leads
     SET gender = 'male', demo_model = 'manual'
   WHERE id = '22222222-2222-4222-8222-222222222222';
  UPDATE public.leads SET full_name = 'Beta Renamed'
   WHERE id = '22222222-2222-4222-8222-222222222222';
  SELECT * INTO v FROM public.leads WHERE id = '22222222-2222-4222-8222-222222222222';
  IF v.gender IS DISTINCT FROM 'male' OR v.demo_model IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'a manual gender label was cleared by an input change: %', to_jsonb(v);
  END IF;
END
$$;
SELECT 'reset_lead_gender_on_input_change preserves manual labels' AS gender_reset_contract;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- delete_manual_message and its sanctioned milestone recompute.
-- ---------------------------------------------------------------------------

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
DO $$
DECLARE
  v_result jsonb;
  v public.leads%rowtype;
  v_sync_id bigint;
  v_manual_id bigint;
BEGIN
  SELECT id INTO v_sync_id   FROM public.messages WHERE content_hash = 'gamma-in-1';
  SELECT id INTO v_manual_id FROM public.messages WHERE content_hash = 'alpha-in-1';

  v_result := public.delete_manual_message(v_sync_id);
  IF v_result <> jsonb_build_object('deleted', false) THEN
    RAISE EXCEPTION 'a synced message was deletable through the manual path: %', v_result;
  END IF;

  v_result := public.delete_manual_message(v_manual_id);
  IF v_result <> jsonb_build_object('deleted', true, 'milestones_recomputed', 1) THEN
    RAISE EXCEPTION 'manual message delete result mismatch: %', v_result;
  END IF;

  SELECT * INTO v FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111';
  IF v.replied_at <> '2026-01-11 15:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'replied_at was not recomputed to the next real reply: %', v.replied_at;
  END IF;
  IF v.connected_at <> '2026-01-07 11:00:00+00'::timestamptz
     OR v.first_message_at <> '2026-01-08 12:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'an unrelated milestone was disturbed by the recompute: %', to_jsonb(v);
  END IF;

  -- The regress escape hatch is transaction-local and opt-in only: an ordinary
  -- update in the same transaction is still blocked from nulling a milestone.
  IF current_setting('app.allow_milestone_regress', true) <> 'on' THEN
    RAISE EXCEPTION 'the sanctioned recompute flag was not set transaction-locally';
  END IF;
END
$$;
SELECT 'delete_manual_message recomputes only the milestones it owns' AS manual_delete_contract;
ROLLBACK;

-- Outside delete_manual_message the flag is gone again, so the next transaction
-- cannot regress a milestone.
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
SELECT 1 / CASE WHEN coalesce(current_setting('app.allow_milestone_regress', true), '') <> 'on' THEN 1 ELSE 0 END AS regress_flag_is_transaction_local;
UPDATE public.leads SET replied_at = NULL WHERE id = '11111111-1111-4111-8111-111111111111';
SELECT 1 / CASE WHEN (SELECT replied_at FROM public.leads WHERE id = '11111111-1111-4111-8111-111111111111') = '2026-01-09 13:00:00+00'::timestamptz THEN 1 ELSE 0 END AS regress_still_blocked_after_recompute;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- pipeline_auto_advance.
-- ---------------------------------------------------------------------------

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
DO $$
DECLARE
  v_advanced integer;
  v_stage text;
  v_events integer;
BEGIN
  v_advanced := public.pipeline_auto_advance();
  IF v_advanced <> 1 THEN
    RAISE EXCEPTION 'pipeline_auto_advance advanced % leads, expected 1', v_advanced;
  END IF;

  SELECT pipeline_stage INTO v_stage FROM public.leads
   WHERE id = '33333333-3333-4333-8333-333333333333';
  IF v_stage <> 'interested' THEN
    RAISE EXCEPTION 'a positive reply did not advance the lead to interested: %', v_stage;
  END IF;

  SELECT count(*) INTO v_events FROM public.pipeline_events
   WHERE lead_id = '33333333-3333-4333-8333-333333333333'
     AND kind = 'stage' AND actor = 'auto' AND to_stage = 'interested';
  IF v_events <> 1 THEN
    RAISE EXCEPTION 'expected exactly one auto stage event, found %', v_events;
  END IF;

  -- A second run in the same state is a no-op and logs no duplicate event.
  v_advanced := public.pipeline_auto_advance();
  SELECT count(*) INTO v_events FROM public.pipeline_events
   WHERE lead_id = '33333333-3333-4333-8333-333333333333';
  IF v_advanced <> 0 OR v_events <> 1 THEN
    RAISE EXCEPTION 'a repeated pipeline_auto_advance was not idempotent: advanced %, events %',
      v_advanced, v_events;
  END IF;
END
$$;
SELECT 'pipeline_auto_advance is gated and idempotent' AS pipeline_contract;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- apply_follow_up_action and archive_follow_up_after_last_lead.
-- ---------------------------------------------------------------------------

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
DO $$
DECLARE
  v_owner_id bigint;
  v_mutation uuid := '44444444-4444-4444-8444-444444444444';
  v_result jsonb;
  v_replay jsonb;
  v_state public.conversation_follow_up_state%rowtype;
  v_canceled integer;
BEGIN
  SELECT id INTO v_owner_id FROM public.team_members WHERE name = 'Active One';
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'the active actor could not see its own team_members row';
  END IF;

  v_result := public.apply_follow_up_action(
    'schedule', 'notebook-test', 'https://example.test/in/alpha', 'tester',
    0, v_mutation, v_owner_id, CURRENT_DATE + 30, NULL);
  IF (v_result -> 'replayed')::boolean THEN
    RAISE EXCEPTION 'the first follow-up mutation reported a replay';
  END IF;

  -- The same mutation_id replays instead of double-applying.
  v_replay := public.apply_follow_up_action(
    'schedule', 'notebook-test', 'https://example.test/in/alpha', 'tester',
    0, v_mutation, v_owner_id, CURRENT_DATE + 30, NULL);
  IF NOT (v_replay -> 'replayed')::boolean
     OR (v_replay -> 'mutation_revision') <> (v_result -> 'mutation_revision') THEN
    RAISE EXCEPTION 'a repeated follow-up mutation was not idempotent: %', v_replay;
  END IF;

  -- Deleting the last lead row of the conversation archives the follow-up
  -- through the AFTER DELETE trigger and records a system cancellation.
  DELETE FROM public.leads
   WHERE instance_id = 'notebook-test'
     AND profile_url = 'https://example.test/in/alpha';

  SELECT * INTO v_state FROM public.conversation_follow_up_state
   WHERE instance_id = 'notebook-test' AND profile_url = 'https://example.test/in/alpha';
  IF v_state.archived_at IS NULL OR v_state.next_follow_up_date IS NOT NULL
     OR v_state.owner_id IS NOT NULL OR v_state.updated_by <> 'system' THEN
    RAISE EXCEPTION 'the follow-up was not archived after the last lead was deleted: %',
      to_jsonb(v_state);
  END IF;

  SELECT count(*) INTO v_canceled FROM public.follow_up_events
   WHERE instance_id = 'notebook-test'
     AND profile_url = 'https://example.test/in/alpha'
     AND event_kind = 'canceled' AND actor = 'system';
  IF v_canceled <> 1 THEN
    RAISE EXCEPTION 'expected exactly one system cancellation event, found %', v_canceled;
  END IF;
END
$$;
SELECT 'follow-up mutations are idempotent and archive on last lead delete' AS follow_up_contract;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- set_hypothesis_campaigns runs with the caller's privileges, so it is still
-- bounded by the actor policies rather than by owner rights.
-- ---------------------------------------------------------------------------

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
DO $$
DECLARE
  v_hypothesis bigint;
  v_attached integer;
BEGIN
  INSERT INTO public.hypotheses (name) VALUES ('Fixture hypothesis') RETURNING id INTO v_hypothesis;
  PERFORM public.set_hypothesis_campaigns(v_hypothesis, ARRAY['notebook-test:1']);
  SELECT count(*) INTO v_attached FROM public.hypothesis_campaigns
   WHERE hypothesis_id = v_hypothesis AND campaign_id = 'notebook-test:1';
  IF v_attached <> 1 THEN
    RAISE EXCEPTION 'set_hypothesis_campaigns attached % campaigns, expected 1', v_attached;
  END IF;

  -- Re-running with the same set is idempotent.
  PERFORM public.set_hypothesis_campaigns(v_hypothesis, ARRAY['notebook-test:1']);
  SELECT count(*) INTO v_attached FROM public.hypothesis_campaigns
   WHERE hypothesis_id = v_hypothesis;
  IF v_attached <> 1 THEN
    RAISE EXCEPTION 'a repeated set_hypothesis_campaigns was not idempotent: %', v_attached;
  END IF;
END
$$;
SELECT 'set_hypothesis_campaigns reattaches idempotently' AS hypothesis_campaign_contract;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- admin_update_team_member keeps the final-admin invariant.
-- ---------------------------------------------------------------------------

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000002';
DO $$
DECLARE
  v_admin_id bigint;
  v_member public.team_members%rowtype;
BEGIN
  SELECT id INTO v_admin_id FROM public.team_members WHERE name = 'Active Two';

  BEGIN
    PERFORM public.admin_update_team_member(v_admin_id, 'Active Two', 'member', true);
    RAISE EXCEPTION 'demoting the final active admin unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.admin_update_team_member(v_admin_id, '', 'admin', true);
    RAISE EXCEPTION 'an empty member name was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    PERFORM public.admin_update_team_member(v_admin_id, 'Active Two', 'owner', true);
    RAISE EXCEPTION 'an unknown role was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  v_member := public.admin_update_team_member(v_admin_id, '  Renamed Admin  ', 'admin', true);
  IF v_member.name <> 'Renamed Admin' THEN
    RAISE EXCEPTION 'the member name was not trimmed: %', v_member.name;
  END IF;
END
$$;
SELECT 'admin_update_team_member validates and protects the last admin' AS admin_update_contract;
ROLLBACK;

SELECT 'portable function and trigger behavior assertions passed' AS result;
