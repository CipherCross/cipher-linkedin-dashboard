-- Step 020: let message identity adoption invalidate a manual review without
-- forging a human reviewer.
--
-- Chat-store adoption (step 019) corrects a legacy message's sent_at while
-- attaching its stable external_id.  That semantic change invokes
-- reply_review_message_semantic_change.  Step 017 treated every UUID-shaped
-- app.actor_id as a human actor, but machine credentials are UUIDs too.  For a
-- legacy_manual review the trigger consequently changed provenance to human
-- while reviewed_by remained NULL, violating
-- reply_reviews_actor_provenance_check and rolling back the entire ingest.
--
-- This additive correction keeps the review row's existing human/legacy
-- provenance when a machine or system invalidates it, records the actual
-- machine/system provenance in the append-only event, and attributes a human
-- invalidation only to an active team member.  An unchanged legacy_manual
-- provenance is allowed through the provenance guard; creating a new legacy
-- provenance, or changing another row to it, remains migration-only.

SET ROLE app_owner;

CREATE OR REPLACE FUNCTION public.reply_review_provenance_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE aid uuid;
BEGIN
  IF NEW.provenance = 'legacy_manual'
     AND (TG_OP = 'INSERT' OR NEW.provenance IS DISTINCT FROM OLD.provenance)
     AND coalesce(current_setting('app.legacy_reply_migration', true), '') <> 'on' THEN
    RAISE EXCEPTION 'legacy reply provenance is reserved for the activation snapshot'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.provenance = 'human' THEN
    aid := CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F-]{36}$'
      THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END;
    IF pg_trigger_depth() = 1
       AND (aid IS NULL OR NEW.reviewed_by IS DISTINCT FROM aid OR NOT is_active_team_member()) THEN
      RAISE EXCEPTION 'human review actor must match the canonical active actor'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reply_review_message_semantic_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  r reply_reviews%rowtype;
  aid uuid;
  mid uuid := gen_random_uuid();
  event_actor uuid;
  event_provenance text;
BEGIN
  IF NEW.body IS NOT DISTINCT FROM OLD.body
     AND NEW.direction IS NOT DISTINCT FROM OLD.direction
     AND NEW.sent_at IS NOT DISTINCT FROM OLD.sent_at THEN
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM reply_reviews WHERE message_id = OLD.id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  aid := CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F-]{36}$'
    THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END;
  IF aid IS NOT NULL AND is_active_team_member() THEN
    event_actor := aid;
    event_provenance := 'human';
  ELSIF aid IS NOT NULL AND EXISTS (
    SELECT 1 FROM agent_credential c WHERE c.id = aid
  ) THEN
    event_actor := aid;
    event_provenance := 'machine';
  ELSE
    event_actor := NULL;
    event_provenance := 'system';
  END IF;

  INSERT INTO reply_review_events (
    instance_id, profile_url, message_id, original_message_id, event_type,
    actor_id, provenance, before, after, mutation_id
  ) VALUES (
    OLD.instance_id, OLD.profile_url, OLD.id, OLD.id, 'review_invalidated',
    event_actor, event_provenance,
    jsonb_build_object('sentiment', r.sentiment, 'intent_state', r.intent_state,
      'intent_level', r.intent_level, 'comment', r.comment),
    jsonb_build_object('sentiment', NULL, 'intent_state', 'unreviewed',
      'intent_level', NULL, 'comment', NULL), mid
  );
  DELETE FROM reply_review_reasons WHERE message_id = OLD.id;
  UPDATE reply_reviews SET sentiment = NULL, intent_state = 'unreviewed',
    intent_level = NULL, comment = NULL,
    reviewed_by = CASE WHEN event_provenance = 'human' THEN aid ELSE r.reviewed_by END,
    reviewed_at = clock_timestamp(), revision = revision + 1,
    provenance = CASE WHEN event_provenance = 'human' THEN 'human' ELSE r.provenance END,
    sentiment_provenance = 'none', intent_provenance = 'none',
    taxonomy_version = 'reply-review-v1'
  WHERE message_id = OLD.id;
  NEW.sentiment := NULL;
  NEW.reason := NULL;
  NEW.classified_at := NULL;
  NEW.classified_model := NULL;
  NEW.intent_level := NULL;
  NEW.intent_reason := NULL;
  NEW.intent_classified_at := NULL;
  NEW.intent_classified_model := NULL;
  NEW.intent_taxonomy_version := NULL;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.reply_review_provenance_guard() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_message_semantic_change() OWNER TO app_owner;
REVOKE ALL ON FUNCTION public.reply_review_provenance_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_message_semantic_change() FROM PUBLIC;

RESET ROLE;
