-- Manual reply review, lifecycle and workflow projection.
--
-- This is an additive step after 016.  It deliberately does not edit the
-- frozen Supabase migrations or any earlier portable artifact.  Manual labels
-- are tenant data, and are written by the authenticated app_runtime path; the
-- machine and system principals receive no privileges on these relations.

SET ROLE app_owner;

ALTER TABLE public.messages
  ADD COLUMN first_seen_at timestamp with time zone;
ALTER TABLE public.messages
  ALTER COLUMN first_seen_at SET DEFAULT clock_timestamp();

ALTER TABLE public.conversation_follow_up_state
  ADD COLUMN action text,
  ADD COLUMN do_not_contact boolean DEFAULT false NOT NULL,
  ADD COLUMN acknowledged_inbound_revision bigint DEFAULT 0 NOT NULL,
  ADD COLUMN supporting_message_id bigint;

ALTER TABLE public.conversation_follow_up_state
  ADD CONSTRAINT conversation_follow_up_state_action_check
    CHECK (action = ANY (ARRAY[
      'needs_reply'::text, 'follow_up'::text, 'awaiting_reply'::text,
      'resolved'::text, 'closed_soft'::text, 'closed_hard'::text
    ]) OR action IS NULL),
  ADD CONSTRAINT conversation_follow_up_state_ack_revision_check
    CHECK (acknowledged_inbound_revision >= 0),
  ADD CONSTRAINT conversation_follow_up_state_follow_up_date_check
    CHECK (action <> 'follow_up' OR next_follow_up_date IS NOT NULL),
  ADD CONSTRAINT conversation_follow_up_state_dnc_action_check
    CHECK (NOT do_not_contact OR action = 'resolved');

ALTER TABLE public.conversation_follow_up_state
  ADD CONSTRAINT conversation_follow_up_state_supporting_message_fkey
    FOREIGN KEY (supporting_message_id) REFERENCES public.messages(id)
    ON DELETE SET NULL;

-- Existing dates are the only historical evidence of a scheduled follow-up.
-- Do not infer any completed action or acknowledgement for old rows.
UPDATE public.conversation_follow_up_state
   SET action = CASE
     WHEN next_follow_up_date IS NOT NULL AND archived_at IS NULL THEN 'follow_up'
     ELSE NULL
   END,
       do_not_contact = false,
       acknowledged_inbound_revision = 0
 WHERE action IS NULL;

CREATE TABLE public.reply_review_settings (
    id boolean DEFAULT true NOT NULL,
    schema_version text DEFAULT 'reply-review-v1'::text NOT NULL,
    mode text DEFAULT 'prepared'::text NOT NULL,
    capture_started_at timestamp with time zone,
    activated_at timestamp with time zone,
    activation_in_progress boolean DEFAULT false NOT NULL,
    activation_cursor bigint DEFAULT 0 NOT NULL,
    activation_processed bigint DEFAULT 0 NOT NULL,
    activation_total bigint DEFAULT 0 NOT NULL,
    activation_cutoff bigint,
    activation_mutation_id uuid,
    activation_actor_id uuid,
    activation_batch_size integer,
    CONSTRAINT reply_review_settings_pkey PRIMARY KEY (id),
    CONSTRAINT reply_review_settings_singleton CHECK (id),
    CONSTRAINT reply_review_settings_mode_check CHECK (mode = ANY (ARRAY['prepared'::text, 'manual'::text])),
    CONSTRAINT reply_review_settings_activation_cursor_check CHECK (activation_cursor >= 0),
    CONSTRAINT reply_review_settings_activation_processed_check CHECK (activation_processed >= 0),
    CONSTRAINT reply_review_settings_activation_total_check CHECK (activation_total >= 0),
    CONSTRAINT reply_review_settings_activation_batch_size_check CHECK
      (activation_batch_size IS NULL OR activation_batch_size BETWEEN 1 AND 1000),
    CONSTRAINT reply_review_settings_activation_state_check CHECK (
      (activation_in_progress AND mode = 'prepared' AND activation_cutoff IS NOT NULL
       AND activation_mutation_id IS NOT NULL AND activation_actor_id IS NOT NULL
       AND activation_batch_size IS NOT NULL)
      OR (NOT activation_in_progress)
      OR mode = 'manual'
    )
);

INSERT INTO public.reply_review_settings (id, schema_version, mode)
VALUES (true, 'reply-review-v1', 'prepared');

CREATE TABLE public.conversation_reply_review_state (
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    inbound_revision bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_reply_review_state_pkey PRIMARY KEY (instance_id, profile_url),
    CONSTRAINT conversation_reply_review_state_revision_check CHECK (inbound_revision >= 0),
    CONSTRAINT conversation_reply_review_state_instance_fkey FOREIGN KEY (instance_id)
      REFERENCES public.instances(id) ON DELETE CASCADE
);

CREATE TABLE public.reply_reviews (
    message_id bigint NOT NULL,
    sentiment text,
    intent_state text DEFAULT 'unreviewed'::text NOT NULL,
    intent_level text,
    comment text,
    taxonomy_version text DEFAULT 'reply-review-v1'::text NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    provenance text DEFAULT 'human'::text NOT NULL,
    sentiment_provenance text DEFAULT 'human'::text NOT NULL,
    intent_provenance text DEFAULT 'none'::text NOT NULL,
    CONSTRAINT reply_reviews_pkey PRIMARY KEY (message_id),
    CONSTRAINT reply_reviews_message_fkey FOREIGN KEY (message_id)
      REFERENCES public.messages(id) ON DELETE CASCADE,
    CONSTRAINT reply_reviews_sentiment_check CHECK (sentiment = ANY (ARRAY[
      'positive'::text, 'neutral'::text, 'negative'::text,
      'objection'::text, 'referral'::text, 'auto'::text
    ]) OR sentiment IS NULL),
    CONSTRAINT reply_reviews_intent_state_check CHECK (intent_state = ANY (ARRAY[
      'unreviewed'::text, 'none'::text, 'level'::text, 'not_applicable'::text
    ])),
    CONSTRAINT reply_reviews_intent_level_check CHECK (
      (intent_state = 'level' AND intent_level = ANY (ARRAY['p1'::text, 'p2'::text, 'p3'::text]))
      OR (intent_state <> 'level' AND intent_level IS NULL)
    ),
    CONSTRAINT reply_reviews_auto_intent_check CHECK (
      (sentiment <> 'auto' OR intent_state = 'not_applicable')
      AND (intent_state <> 'not_applicable' OR sentiment = 'auto')
    ),
    CONSTRAINT reply_reviews_comment_length_check CHECK (comment IS NULL OR char_length(comment) <= 1000),
    CONSTRAINT reply_reviews_revision_check CHECK (revision > 0),
    CONSTRAINT reply_reviews_provenance_check CHECK (provenance = ANY (ARRAY['human'::text, 'legacy_manual'::text])),
    CONSTRAINT reply_reviews_sentiment_provenance_check CHECK (sentiment_provenance = ANY (ARRAY['human'::text, 'legacy_manual'::text, 'none'::text])),
    CONSTRAINT reply_reviews_intent_provenance_check CHECK (intent_provenance = ANY (ARRAY['human'::text, 'legacy_manual'::text, 'none'::text])),
    CONSTRAINT reply_reviews_actor_provenance_check CHECK (provenance = 'legacy_manual' OR reviewed_by IS NOT NULL),
    CONSTRAINT reply_reviews_legacy_actor_check CHECK (provenance <> 'legacy_manual' OR reviewed_by IS NULL)
);

CREATE TABLE public.reply_review_reasons (
    message_id bigint NOT NULL,
    reason_id text NOT NULL,
    CONSTRAINT reply_review_reasons_pkey PRIMARY KEY (message_id, reason_id),
    CONSTRAINT reply_review_reasons_review_fkey FOREIGN KEY (message_id)
      REFERENCES public.reply_reviews(message_id) ON DELETE CASCADE,
    CONSTRAINT reply_review_reasons_id_check CHECK (reason_id = ANY (ARRAY[
      'no_need'::text, 'timing'::text, 'budget'::text,
      'existing_solution'::text, 'offer_fit'::text, 'wrong_person'::text,
      'trust_information'::text, 'do_not_contact'::text, 'other'::text
    ]))
);

CREATE TABLE public.reply_review_events (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    message_id bigint,
    original_message_id bigint,
    event_type text DEFAULT 'review'::text NOT NULL,
    actor_id uuid,
    provenance text DEFAULT 'human'::text NOT NULL,
    before jsonb,
    after jsonb,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    mutation_id uuid NOT NULL DEFAULT gen_random_uuid(),
    CONSTRAINT reply_review_events_pkey PRIMARY KEY (id),
    CONSTRAINT reply_review_events_message_fkey FOREIGN KEY (message_id)
      REFERENCES public.messages(id) ON DELETE SET NULL,
    CONSTRAINT reply_review_events_type_check CHECK (event_type = ANY (ARRAY[
      'review'::text, 'review_invalidated'::text, 'workflow'::text,
      'message_deleted'::text, 'cutover'::text
    ])),
    CONSTRAINT reply_review_events_provenance_check CHECK (provenance = ANY (ARRAY[
      'human'::text, 'legacy_manual'::text, 'system'::text, 'machine'::text
    ]))
);

CREATE TABLE public.reply_review_mutations (
    mutation_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    payload_hash text NOT NULL,
    result jsonb NOT NULL,
    committed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT reply_review_mutations_pkey PRIMARY KEY (mutation_id),
    CONSTRAINT reply_review_mutations_hash_check CHECK (char_length(btrim(payload_hash)) BETWEEN 1 AND 128)
);

-- The snapshot has deliberately no FK: an audit snapshot must survive a
-- message deletion. It is read-only history and is not a current metric source.
CREATE TABLE public.legacy_reply_classifications (
    message_id bigint NOT NULL,
    sentiment text,
    intent_level text,
    classified_at timestamp with time zone,
    classified_model text,
    intent_classified_at timestamp with time zone,
    intent_classified_model text,
    intent_taxonomy_version text,
    sentiment_provenance text DEFAULT 'legacy_ai'::text NOT NULL,
    intent_provenance text DEFAULT 'legacy_ai'::text NOT NULL,
    snapshot_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT legacy_reply_classifications_pkey PRIMARY KEY (message_id),
    CONSTRAINT legacy_reply_classifications_sentiment_check CHECK (sentiment = ANY (ARRAY[
      'positive'::text, 'neutral'::text, 'negative'::text,
      'objection'::text, 'referral'::text, 'auto'::text
    ]) OR sentiment IS NULL),
    CONSTRAINT legacy_reply_classifications_intent_check CHECK (intent_level = ANY (ARRAY['p1'::text, 'p2'::text, 'p3'::text]) OR intent_level IS NULL)
);

CREATE INDEX conversation_reply_review_state_revision_idx
  ON public.conversation_reply_review_state (inbound_revision, updated_at);
CREATE INDEX reply_reviews_sentiment_idx ON public.reply_reviews (sentiment, message_id);
CREATE INDEX reply_review_reasons_reason_message_idx
  ON public.reply_review_reasons (reason_id, message_id);
CREATE INDEX reply_review_events_thread_time_idx
  ON public.reply_review_events (instance_id, profile_url, occurred_at DESC, id DESC);
CREATE INDEX conversation_follow_up_action_owner_due_idx
  ON public.conversation_follow_up_state (action, next_follow_up_date, owner_id)
  WHERE archived_at IS NULL;
CREATE INDEX messages_inbound_first_seen_idx
  ON public.messages (instance_id, first_seen_at, id)
  WHERE direction = 'in';

ALTER TABLE public.reply_review_settings OWNER TO app_owner;
ALTER TABLE public.conversation_reply_review_state OWNER TO app_owner;
ALTER TABLE public.reply_reviews OWNER TO app_owner;
ALTER TABLE public.reply_review_reasons OWNER TO app_owner;
ALTER TABLE public.reply_review_events OWNER TO app_owner;
ALTER TABLE public.reply_review_mutations OWNER TO app_owner;
ALTER TABLE public.legacy_reply_classifications OWNER TO app_owner;

-- Every trigger is SECURITY DEFINER and pins search_path. It is intentionally
-- not a grantable general-purpose write function.
CREATE FUNCTION public.reply_review_first_seen_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at
     AND coalesce(current_setting('app.allow_first_seen_backfill', true), '') <> 'on' THEN
    RAISE EXCEPTION 'first_seen_at is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reply_review_inbound_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.direction = 'in' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(jsonb_build_array(NEW.instance_id, NEW.profile_url)::text, 0)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reply_review_inbound_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.direction = 'in' THEN
    INSERT INTO conversation_reply_review_state (instance_id, profile_url, inbound_revision)
    VALUES (NEW.instance_id, NEW.profile_url, 1)
    ON CONFLICT (instance_id, profile_url) DO UPDATE
      SET inbound_revision = conversation_reply_review_state.inbound_revision + 1,
          updated_at = clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reply_review_message_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_manual_guard boolean;
BEGIN
  IF NEW.instance_id IS DISTINCT FROM OLD.instance_id
     OR NEW.profile_url IS DISTINCT FROM OLD.profile_url THEN
    RAISE EXCEPTION 'message thread identity is immutable; use the supported import/delete flow'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.sentiment IS DISTINCT FROM OLD.sentiment
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.classified_at IS DISTINCT FROM OLD.classified_at
       OR NEW.classified_model IS DISTINCT FROM OLD.classified_model
       OR NEW.intent_level IS DISTINCT FROM OLD.intent_level
       OR NEW.intent_reason IS DISTINCT FROM OLD.intent_reason
       OR NEW.intent_classified_at IS DISTINCT FROM OLD.intent_classified_at
       OR NEW.intent_classified_model IS DISTINCT FROM OLD.intent_classified_model
       OR NEW.intent_taxonomy_version IS DISTINCT FROM OLD.intent_taxonomy_version) THEN
    -- Activation locks this singleton FOR UPDATE.  A classification-changing
    -- message UPDATE takes the compatible key-share lock, creating the
    -- happens-before boundary: either the old UPDATE commits before activation
    -- captures its cutoff, or it waits and observes activation_in_progress.
    SELECT (mode = 'manual' OR activation_in_progress) INTO v_manual_guard
      FROM reply_review_settings WHERE id = true FOR KEY SHARE;
    IF v_manual_guard
       AND coalesce(current_setting('app.reply_review_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'AI reply classification writes are disabled in manual mode'
      USING ERRCODE = '42501';
    END IF;
    IF v_manual_guard
       AND coalesce(current_setting('app.reply_review_write', true), '') = 'on'
       AND coalesce(current_setting('app.reply_review_cutover', true), '') <> 'on'
       AND NOT EXISTS (
         SELECT 1 FROM reply_reviews r
          WHERE r.message_id = NEW.id
            AND NEW.sentiment IS NOT DISTINCT FROM r.sentiment
            AND NEW.intent_level IS NOT DISTINCT FROM
              CASE WHEN r.intent_state = 'level' THEN r.intent_level ELSE NULL END
            AND NEW.classified_model = 'manual'
       ) THEN
      RAISE EXCEPTION 'manual compatibility projection requires a matching reply review row'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reply_review_message_semantic_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  r reply_reviews%rowtype;
  aid uuid;
  mid uuid := gen_random_uuid();
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
  INSERT INTO reply_review_events (
    instance_id, profile_url, message_id, original_message_id, event_type,
    actor_id, provenance, before, after, mutation_id
  ) VALUES (
    OLD.instance_id, OLD.profile_url, OLD.id, OLD.id, 'review_invalidated',
    aid, CASE WHEN aid IS NULL THEN 'system' ELSE 'human' END,
    jsonb_build_object('sentiment', r.sentiment, 'intent_state', r.intent_state,
      'intent_level', r.intent_level, 'comment', r.comment),
    jsonb_build_object('sentiment', NULL, 'intent_state', 'unreviewed',
      'intent_level', NULL, 'comment', NULL), mid
  );
  DELETE FROM reply_review_reasons WHERE message_id = OLD.id;
  UPDATE reply_reviews SET sentiment = NULL, intent_state = 'unreviewed',
    intent_level = NULL, comment = NULL,
    reviewed_at = clock_timestamp(), revision = revision + 1,
    provenance = 'human', sentiment_provenance = 'none', intent_provenance = 'none',
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

CREATE FUNCTION public.reply_review_message_delete_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE r reply_reviews%rowtype; aid uuid;
BEGIN
  SELECT * INTO r FROM reply_reviews WHERE message_id = OLD.id;
  IF FOUND THEN
    aid := CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F-]{36}$'
      THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END;
    INSERT INTO reply_review_events (
      instance_id, profile_url, message_id, original_message_id, event_type,
      actor_id, provenance, before, after
    ) VALUES (
      OLD.instance_id, OLD.profile_url, NULL, OLD.id, 'message_deleted', aid,
      CASE WHEN aid IS NULL THEN 'system' ELSE 'human' END,
      jsonb_build_object('sentiment', r.sentiment, 'intent_state', r.intent_state,
        'intent_level', r.intent_level, 'comment', r.comment),
      '{}'::jsonb
    );
  END IF;
  RETURN OLD;
END;
$$;

CREATE FUNCTION public.reply_review_state_projection_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.do_not_contact AND NEW.action IS DISTINCT FROM 'resolved' THEN
    RAISE EXCEPTION 'do_not_contact requires resolved action' USING ERRCODE = '22023';
  END IF;
  IF NEW.do_not_contact AND (NEW.action IN ('needs_reply', 'follow_up', 'awaiting_reply')
      OR NEW.next_follow_up_date IS NOT NULL) THEN
    RAISE EXCEPTION 'do_not_contact blocks active follow-up actions' USING ERRCODE = '42501';
  END IF;
  -- Keep old schedule/reschedule/complete/cancel callers and the new action
  -- projection in one state store. The legacy function does not know action.
  IF NEW.next_follow_up_date IS NOT NULL THEN
    NEW.action := 'follow_up';
  ELSIF NEW.next_follow_up_date IS NULL AND NEW.archived_at IS NOT NULL THEN
    NEW.action := 'resolved';
  ELSIF OLD.next_follow_up_date IS NOT NULL
        AND NEW.next_follow_up_date IS NULL
        AND NEW.action IS NULL THEN
    NEW.action := 'resolved';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reply_review_workflow_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE aid uuid;
BEGIN
  IF NEW.action IS NOT DISTINCT FROM OLD.action
     AND NEW.do_not_contact IS NOT DISTINCT FROM OLD.do_not_contact
     AND NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id
     AND NEW.next_follow_up_date IS NOT DISTINCT FROM OLD.next_follow_up_date
     AND NEW.acknowledged_inbound_revision IS NOT DISTINCT FROM OLD.acknowledged_inbound_revision THEN
    RETURN NEW;
  END IF;
  aid := CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F-]{36}$'
    THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END;
  INSERT INTO reply_review_events (
    instance_id, profile_url, event_type, actor_id, provenance,
    before, after
  ) VALUES (
    NEW.instance_id, NEW.profile_url, 'workflow', aid,
    CASE WHEN aid IS NULL THEN 'system' ELSE 'human' END,
    jsonb_build_object('action', OLD.action, 'owner_id', OLD.owner_id,
      'next_follow_up_date', OLD.next_follow_up_date,
      'do_not_contact', OLD.do_not_contact,
      'acknowledged_inbound_revision', OLD.acknowledged_inbound_revision),
    jsonb_build_object('action', NEW.action, 'owner_id', NEW.owner_id,
      'next_follow_up_date', NEW.next_follow_up_date,
      'do_not_contact', NEW.do_not_contact,
      'acknowledged_inbound_revision', NEW.acknowledged_inbound_revision)
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reply_review_events_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'reply review events are append-only' USING ERRCODE = '42501';
END;
$$;

CREATE FUNCTION public.reply_review_mutations_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'reply review mutations are append-only' USING ERRCODE = '42501';
END;
$$;

CREATE FUNCTION public.reply_review_validate_completion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE has_reason boolean; direction text;
BEGIN
  IF NEW.provenance = 'legacy_manual' THEN RETURN NEW; END IF;
  SELECT m.direction INTO direction FROM messages m WHERE m.id = NEW.message_id;
  IF direction <> 'in' THEN
    RAISE EXCEPTION 'reply reviews require an inbound message' USING ERRCODE = '22023';
  END IF;
  IF NEW.sentiment IS NULL THEN RETURN NEW; END IF;
  SELECT EXISTS (SELECT 1 FROM reply_review_reasons WHERE message_id = NEW.message_id)
    INTO has_reason;
  IF NEW.sentiment IN ('negative', 'objection') AND NOT has_reason THEN
    RAISE EXCEPTION 'negative and objection reviews require at least one reason'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.sentiment = 'auto' AND has_reason THEN
    RAISE EXCEPTION 'auto reviews cannot have reasons' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reply_review_validate_reason() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE c text; s text; p text; thread_instance text; thread_profile text;
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT comment, sentiment, provenance INTO c, s, p
    FROM reply_reviews WHERE message_id = COALESCE(NEW.message_id, OLD.message_id);
  IF COALESCE(NEW.reason_id, OLD.reason_id) = 'other'
     AND (c IS NULL OR btrim(c) = '') THEN
    RAISE EXCEPTION 'other reason requires a non-empty comment' USING ERRCODE = '22023';
  END IF;
  IF s = 'auto' AND p <> 'legacy_manual' THEN
    RAISE EXCEPTION 'auto reviews cannot have reasons' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(NEW.reason_id, OLD.reason_id) = 'do_not_contact' THEN
    SELECT m.instance_id, m.profile_url INTO thread_instance, thread_profile
      FROM messages m WHERE m.id = COALESCE(NEW.message_id, OLD.message_id);
    IF NOT EXISTS (
      SELECT 1 FROM conversation_follow_up_state wf
       WHERE wf.instance_id = thread_instance AND wf.profile_url = thread_profile
         AND wf.do_not_contact
    ) THEN
      RAISE EXCEPTION 'do_not_contact reason requires the conversation DNC flag'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reply_review_validate_dnc_reason_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NOT NEW.do_not_contact AND EXISTS (
    SELECT 1
      FROM messages m
      JOIN reply_review_reasons rr ON rr.message_id = m.id
     WHERE m.instance_id = NEW.instance_id
       AND m.profile_url = NEW.profile_url
       AND rr.reason_id = 'do_not_contact'
  ) THEN
    RAISE EXCEPTION 'do_not_contact reason requires the conversation DNC flag'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reply_review_provenance_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE aid uuid;
BEGIN
  IF NEW.provenance = 'legacy_manual'
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

CREATE CONSTRAINT TRIGGER reply_reviews_require_reasons
  AFTER INSERT OR UPDATE ON public.reply_reviews
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.reply_review_validate_completion();
CREATE CONSTRAINT TRIGGER reply_review_reasons_require_valid_parent
  AFTER INSERT OR UPDATE OR DELETE ON public.reply_review_reasons
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.reply_review_validate_reason();
CREATE CONSTRAINT TRIGGER reply_follow_up_dnc_reason_invariant
  AFTER INSERT OR UPDATE ON public.conversation_follow_up_state
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.reply_review_validate_dnc_reason_state();
CREATE TRIGGER reply_review_provenance_boundary
  BEFORE INSERT OR UPDATE ON public.reply_reviews
  FOR EACH ROW EXECUTE FUNCTION public.reply_review_provenance_guard();

CREATE TRIGGER reply_messages_first_seen_guard
  BEFORE UPDATE OF first_seen_at ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.reply_review_first_seen_guard();
CREATE TRIGGER reply_messages_identity_guard
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.reply_review_message_identity_guard();
CREATE TRIGGER reply_messages_inbound_lock
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.reply_review_inbound_before_insert();
CREATE TRIGGER reply_messages_inbound_revision
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.reply_review_inbound_after_insert();
CREATE TRIGGER reply_messages_semantic_review_invalidation
  BEFORE UPDATE OF body, direction, sent_at ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.reply_review_message_semantic_change();
CREATE TRIGGER reply_messages_delete_review_audit
  BEFORE DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.reply_review_message_delete_audit();
CREATE TRIGGER reply_follow_up_state_projection_guard
  BEFORE UPDATE ON public.conversation_follow_up_state
  FOR EACH ROW EXECUTE FUNCTION public.reply_review_state_projection_guard();
CREATE TRIGGER reply_follow_up_workflow_audit
  AFTER UPDATE ON public.conversation_follow_up_state
  FOR EACH ROW EXECUTE FUNCTION public.reply_review_workflow_audit();
CREATE TRIGGER reply_review_events_append_only
  BEFORE UPDATE OR DELETE ON public.reply_review_events
  FOR EACH ROW EXECUTE FUNCTION public.reply_review_events_immutable();
CREATE TRIGGER reply_review_mutations_append_only
  BEFORE UPDATE OR DELETE ON public.reply_review_mutations
  FOR EACH ROW EXECUTE FUNCTION public.reply_review_mutations_immutable();

-- Preserve the old nine-argument follow-up contract while extending the named
-- operation with the six canonical action states. The legacy implementation is
-- retained behind the wrapper so schedule/reschedule semantics and their audit
-- remain byte-compatible for existing callers.
ALTER FUNCTION public.apply_follow_up_action(text, text, text, text, bigint, uuid, bigint, date, text)
  RENAME TO apply_follow_up_action_legacy;

CREATE FUNCTION public.apply_follow_up_action(
  p_action text, p_instance_id text, p_profile_url text, p_actor text,
  p_expected_revision bigint, p_mutation_id uuid, p_owner_id bigint DEFAULT NULL,
  p_next_follow_up_date date DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_state conversation_follow_up_state%rowtype;
  v_rr conversation_reply_review_state%rowtype;
  v_actor uuid;
  v_hash text;
  v_old jsonb;
  v_result jsonb;
BEGIN
  IF p_action IN ('schedule','reschedule','reassign','complete','skip','cancel') THEN
    RETURN apply_follow_up_action_legacy(p_action, p_instance_id, p_profile_url,
      p_actor, p_expected_revision, p_mutation_id, p_owner_id,
      p_next_follow_up_date, p_reason);
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('needs_reply','follow_up','awaiting_reply','resolved',
      'closed_soft','closed_hard','do_not_contact') THEN
    RAISE EXCEPTION 'unknown workflow action' USING ERRCODE = '22023';
  END IF;
  IF p_instance_id IS NULL OR btrim(p_instance_id) = ''
     OR p_profile_url IS NULL OR btrim(p_profile_url) = ''
     OR p_mutation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'workflow identity, revision and mutation_id are required' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR char_length(btrim(p_actor)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'actor must be 1-120 characters' USING ERRCODE = '22023';
  END IF;
  v_actor := CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F-]{36}$'
    THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END;
  IF v_actor IS NULL OR NOT is_active_team_member() THEN
    RAISE EXCEPTION 'canonical active actor is required' USING ERRCODE = '42501';
  END IF;
  v_hash := md5(jsonb_build_object('action',p_action,'instance_id',p_instance_id,
    'profile_url',p_profile_url,'expected_revision',p_expected_revision,
    'owner_id',p_owner_id,'next_follow_up_date',p_next_follow_up_date,
    'reason',p_reason)::text);
  SELECT result INTO v_result FROM reply_review_mutations
   WHERE mutation_id = p_mutation_id AND actor_id = v_actor
     AND payload_hash = v_hash;
  IF FOUND THEN RETURN v_result || jsonb_build_object('replayed', true); END IF;
  IF EXISTS (SELECT 1 FROM reply_review_mutations WHERE mutation_id = p_mutation_id) THEN
    RAISE EXCEPTION 'REPLY_REVIEW_CONFLICT: mutation_id was already used with different inputs'
      USING ERRCODE = '40001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array(p_instance_id,p_profile_url)::text, 0));
  IF NOT EXISTS (SELECT 1 FROM leads WHERE instance_id=p_instance_id AND profile_url=p_profile_url)
     AND NOT EXISTS (SELECT 1 FROM messages WHERE instance_id=p_instance_id AND profile_url=p_profile_url) THEN
    RAISE EXCEPTION 'unknown conversation' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO conversation_follow_up_state (instance_id, profile_url, revision, updated_by)
  VALUES (p_instance_id, p_profile_url, 0, p_actor::text)
  ON CONFLICT (instance_id, profile_url) DO NOTHING;
  SELECT * INTO v_state FROM conversation_follow_up_state
    WHERE instance_id=p_instance_id AND profile_url=p_profile_url FOR UPDATE;
  IF v_state.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'FOLLOW_UP_CONFLICT: stale revision' USING ERRCODE = '40001';
  END IF;
  IF v_state.do_not_contact AND p_action IN ('needs_reply','follow_up','awaiting_reply') THEN
    RAISE EXCEPTION 'do_not_contact blocks active workflow actions' USING ERRCODE = '42501';
  END IF;
  IF p_action IN ('needs_reply','follow_up','awaiting_reply') AND p_owner_id IS NULL THEN
    RAISE EXCEPTION 'owner_id is required for an active workflow action' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'follow_up' AND p_next_follow_up_date IS NULL THEN
    RAISE EXCEPTION 'next_follow_up_date is required for follow_up' USING ERRCODE = '22023';
  END IF;
  IF p_next_follow_up_date IS NOT NULL AND p_next_follow_up_date <
      (now() AT TIME ZONE 'Europe/Madrid')::date THEN
    RAISE EXCEPTION 'next_follow_up_date cannot be in the past' USING ERRCODE = '22023';
  END IF;
  IF p_owner_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM team_members WHERE id=p_owner_id AND active) THEN
    RAISE EXCEPTION 'owner_id must reference an active team member' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_rr FROM conversation_reply_review_state
    WHERE instance_id=p_instance_id AND profile_url=p_profile_url;
  v_old := to_jsonb(v_state);
  UPDATE conversation_follow_up_state SET
    action = CASE WHEN p_action='do_not_contact' THEN 'resolved' ELSE p_action END,
    do_not_contact = CASE WHEN p_action='do_not_contact' THEN true ELSE do_not_contact END,
    next_follow_up_date = CASE WHEN p_action='follow_up' THEN p_next_follow_up_date ELSE NULL END,
    owner_id = COALESCE(p_owner_id, owner_id),
    acknowledged_inbound_revision = COALESCE(v_rr.inbound_revision, acknowledged_inbound_revision),
    revision = revision + 1, last_mutation_id = p_mutation_id,
    updated_at = clock_timestamp(), updated_by = p_actor
  WHERE instance_id=p_instance_id AND profile_url=p_profile_url
  RETURNING * INTO v_state;
  v_result := jsonb_build_object('state',to_jsonb(v_state),'replayed',false,
    'mutation_id',p_mutation_id,'mutation_revision',v_state.revision);
  INSERT INTO reply_review_mutations(mutation_id,actor_id,payload_hash,result)
    VALUES(p_mutation_id,v_actor,v_hash,v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_follow_up_action_legacy(text,text,text,text,bigint,uuid,bigint,date,text) FROM PUBLIC, app_runtime;
REVOKE ALL ON FUNCTION public.apply_follow_up_action(text,text,text,text,bigint,uuid,bigint,date,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_first_seen_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_inbound_before_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_inbound_after_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_message_identity_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_message_semantic_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_message_delete_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_state_projection_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_workflow_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_events_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_mutations_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_validate_completion() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_validate_reason() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_validate_dnc_reason_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reply_review_provenance_guard() FROM PUBLIC;

-- Operator-only activation is a database guard, not a browser feature flag.
-- The migration is resumable: each invocation copies at most p_batch_size
-- inbound messages. mode remains prepared while activation_in_progress is true,
-- so manual readers cannot observe a partial projection. The API must still
-- perform its normal capability/preflight and operations-contract checks.
CREATE FUNCTION public.activate_manual_reply_review(
  p_mutation_id uuid, p_batch_size integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  aid uuid;
  s reply_review_settings%rowtype;
  result jsonb;
  v_hash text;
  v_existing_actor uuid;
  v_existing_hash text;
  v_next_cursor bigint;
  v_batch_count bigint := 0;
  v_remaining bigint := 0;
  v_complete boolean := false;
BEGIN
  IF p_mutation_id IS NULL OR p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'activation mutation_id and batch_size (1-1000) are required'
      USING ERRCODE = '22023';
  END IF;
  aid := CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F-]{36}$'
    THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END;
  IF aid IS NULL OR NOT is_app_admin() THEN
    RAISE EXCEPTION 'manual reply review activation requires an active admin' USING ERRCODE = '42501';
  END IF;
  v_hash := md5(jsonb_build_object('mutation_id',p_mutation_id,'batch_size',p_batch_size)::text);
  SELECT * INTO s FROM reply_review_settings WHERE id=true FOR UPDATE;
  SELECT actor_id, payload_hash INTO v_existing_actor, v_existing_hash
    FROM reply_review_mutations WHERE mutation_id = p_mutation_id;
  IF FOUND AND (v_existing_actor IS DISTINCT FROM aid OR v_existing_hash IS DISTINCT FROM v_hash) THEN
    RAISE EXCEPTION 'REPLY_REVIEW_CONFLICT: mutation_id was already used with different inputs'
      USING ERRCODE = '40001';
  END IF;
  IF s.mode = 'manual' THEN
    IF s.activation_mutation_id IS DISTINCT FROM p_mutation_id THEN
      RAISE EXCEPTION 'REPLY_REVIEW_CONFLICT: activation already completed with another mutation_id'
        USING ERRCODE = '40001';
    END IF;
    RETURN jsonb_build_object('mode','manual','activated_at',s.activated_at,
      'complete',true,'processed',s.activation_processed,'remaining',0,
      'cursor',s.activation_cursor,'replayed',true,'mutation_id',p_mutation_id);
  END IF;
  IF s.activation_in_progress AND s.activation_mutation_id IS DISTINCT FROM p_mutation_id THEN
    RAISE EXCEPTION 'REPLY_REVIEW_CONFLICT: activation is already in progress with another mutation_id'
      USING ERRCODE = '40001';
  END IF;
  IF s.activation_in_progress
     AND (s.activation_actor_id IS DISTINCT FROM aid OR s.activation_batch_size IS DISTINCT FROM p_batch_size) THEN
    RAISE EXCEPTION 'REPLY_REVIEW_CONFLICT: activation mutation inputs changed during resume'
      USING ERRCODE = '40001';
  END IF;
  IF NOT s.activation_in_progress THEN
    SELECT coalesce(max(id), 0), count(*) INTO s.activation_cutoff, s.activation_total
      FROM messages WHERE direction='in';
    UPDATE reply_review_settings SET
      activation_in_progress=true, activation_cursor=0, activation_processed=0,
      activation_total=s.activation_total, activation_cutoff=s.activation_cutoff,
      activation_mutation_id=p_mutation_id, activation_actor_id=aid,
      activation_batch_size=p_batch_size, capture_started_at=clock_timestamp()
      WHERE id=true
      RETURNING * INTO s;
  END IF;
  PERFORM set_config('app.legacy_reply_migration','on',true);

  SELECT max(id), count(*) INTO v_next_cursor, v_batch_count
    FROM (SELECT id FROM messages
      WHERE direction='in' AND id > s.activation_cursor AND id <= s.activation_cutoff
      ORDER BY id LIMIT p_batch_size) batch;
  IF v_batch_count > 0 THEN
  INSERT INTO legacy_reply_classifications(
    message_id,sentiment,intent_level,classified_at,classified_model,
    intent_classified_at,intent_classified_model,intent_taxonomy_version,
    sentiment_provenance,intent_provenance)
  SELECT id,sentiment,intent_level,classified_at,classified_model,
    intent_classified_at,intent_classified_model,intent_taxonomy_version,
    CASE WHEN classified_model = 'manual' THEN 'legacy_manual' ELSE 'legacy_ai' END,
    CASE WHEN intent_classified_model = 'manual' THEN 'legacy_manual' ELSE 'legacy_ai' END
  FROM messages m
  WHERE m.direction='in' AND m.id > s.activation_cursor AND m.id <= v_next_cursor
  ON CONFLICT (message_id) DO NOTHING;
  INSERT INTO reply_reviews(message_id,sentiment,intent_state,intent_level,comment,
      taxonomy_version,reviewed_by,reviewed_at,revision,provenance,
      sentiment_provenance,intent_provenance)
  SELECT m.id,
      CASE WHEN l.sentiment_provenance='legacy_manual' THEN m.sentiment ELSE NULL END,
      CASE WHEN l.sentiment_provenance='legacy_manual' AND m.sentiment='auto' THEN 'not_applicable'
        WHEN l.intent_provenance='legacy_manual' AND m.intent_level IS NOT NULL THEN 'level'
        ELSE 'unreviewed' END,
      CASE WHEN l.sentiment_provenance='legacy_manual' AND m.sentiment='auto' THEN NULL
        WHEN l.intent_provenance='legacy_manual' THEN m.intent_level ELSE NULL END,
      NULL,m.intent_taxonomy_version, NULL, COALESCE(m.classified_at,m.sent_at), 1,
      'legacy_manual',
      CASE WHEN l.sentiment_provenance='legacy_manual' THEN 'legacy_manual' ELSE 'none' END,
      CASE WHEN l.intent_provenance='legacy_manual' THEN 'legacy_manual' ELSE 'none' END
  FROM messages m JOIN legacy_reply_classifications l ON l.message_id=m.id
  WHERE m.direction='in' AND m.id > s.activation_cursor AND m.id <= v_next_cursor
    AND (l.sentiment_provenance='legacy_manual' OR l.intent_provenance='legacy_manual')
  ON CONFLICT (message_id) DO NOTHING;
  END IF;

  v_next_cursor := coalesce(v_next_cursor, s.activation_cursor);
  SELECT count(*) INTO v_remaining FROM messages
    WHERE direction='in' AND id > v_next_cursor AND id <= s.activation_cutoff;
  v_complete := v_remaining = 0;
  IF v_complete THEN
  PERFORM set_config('app.reply_review_write','on',true);
  PERFORM set_config('app.reply_review_cutover','on',true);
  -- Mixed legacy provenance is independent per classification family.  Keep
  -- only the compatibility fields backed by a legacy-manual source; AI-only
  -- sentiment must not survive merely because intent was manual, and vice
  -- versa.  Rows without a review therefore clear both families.
  UPDATE messages m SET
    sentiment=CASE WHEN (SELECT r.sentiment_provenance FROM reply_reviews r
                          WHERE r.message_id=m.id)='legacy_manual'
                   THEN m.sentiment ELSE NULL END,
    reason=CASE WHEN (SELECT r.sentiment_provenance FROM reply_reviews r
                      WHERE r.message_id=m.id)='legacy_manual'
                THEN m.reason ELSE NULL END,
    classified_at=CASE WHEN (SELECT r.sentiment_provenance FROM reply_reviews r
                             WHERE r.message_id=m.id)='legacy_manual'
                       THEN m.classified_at ELSE NULL END,
    classified_model=CASE WHEN (SELECT r.sentiment_provenance FROM reply_reviews r
                                WHERE r.message_id=m.id)='legacy_manual'
                          THEN m.classified_model ELSE NULL END,
    intent_level=CASE WHEN (SELECT r.intent_provenance FROM reply_reviews r
                            WHERE r.message_id=m.id)='legacy_manual'
                      THEN m.intent_level ELSE NULL END,
    intent_reason=CASE WHEN (SELECT r.intent_provenance FROM reply_reviews r
                             WHERE r.message_id=m.id)='legacy_manual'
                       THEN m.intent_reason ELSE NULL END,
    intent_classified_at=CASE WHEN (SELECT r.intent_provenance FROM reply_reviews r
                                    WHERE r.message_id=m.id)='legacy_manual'
                              THEN m.intent_classified_at ELSE NULL END,
    intent_classified_model=CASE WHEN (SELECT r.intent_provenance FROM reply_reviews r
                                       WHERE r.message_id=m.id)='legacy_manual'
                                 THEN m.intent_classified_model ELSE NULL END,
    intent_taxonomy_version=CASE WHEN (SELECT r.intent_provenance FROM reply_reviews r
                                       WHERE r.message_id=m.id)='legacy_manual'
                                 THEN m.intent_taxonomy_version ELSE NULL END
  WHERE m.direction='in' AND m.id <= s.activation_cutoff;
  UPDATE reply_review_settings SET mode='manual', activation_in_progress=false,
    activation_cursor=v_next_cursor, activation_processed=activation_processed + v_batch_count,
    activated_at=clock_timestamp() WHERE id=true;
  ELSE
    UPDATE reply_review_settings SET activation_cursor=v_next_cursor,
      activation_processed=activation_processed + v_batch_count WHERE id=true;
  END IF;
  SELECT * INTO s FROM reply_review_settings WHERE id=true;
  result := jsonb_build_object('mode',s.mode,'activated_at',s.activated_at,
    'complete',v_complete,'processed',s.activation_processed,
    'remaining',v_remaining,'cursor',s.activation_cursor,'replayed',false,
    'mutation_id',p_mutation_id);
  -- The mutation ledger is immutable audit/replay history.  In-progress
  -- batches use the settings progress columns above; insert exactly once only
  -- after the final compatibility cutover so append-only triggers remain strict.
  IF v_complete THEN
    INSERT INTO reply_review_mutations(mutation_id,actor_id,payload_hash,result)
      VALUES(p_mutation_id,aid,v_hash,result)
      ON CONFLICT (mutation_id) DO NOTHING;
  END IF;
  RETURN result;
END;
$$;

ALTER FUNCTION public.reply_review_first_seen_guard() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_inbound_before_insert() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_inbound_after_insert() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_message_identity_guard() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_message_semantic_change() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_message_delete_audit() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_state_projection_guard() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_workflow_audit() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_events_immutable() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_mutations_immutable() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_validate_completion() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_validate_reason() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_validate_dnc_reason_state() OWNER TO app_owner;
ALTER FUNCTION public.reply_review_provenance_guard() OWNER TO app_owner;
ALTER FUNCTION public.apply_follow_up_action(text,text,text,text,bigint,uuid,bigint,date,text) OWNER TO app_owner;
ALTER FUNCTION public.activate_manual_reply_review(uuid, integer) OWNER TO app_owner;
REVOKE ALL ON FUNCTION public.activate_manual_reply_review(uuid, integer) FROM PUBLIC;

ALTER TABLE public.reply_review_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_reply_review_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reply_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reply_review_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reply_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reply_review_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_reply_classifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY reply_review_settings_active_member ON public.reply_review_settings
  FOR SELECT TO app_runtime, app_readonly USING (public.is_active_team_member());
CREATE POLICY conversation_reply_review_state_active_member ON public.conversation_reply_review_state
  FOR ALL TO app_runtime USING (public.is_active_team_member())
  WITH CHECK (public.is_active_team_member());
CREATE POLICY conversation_reply_review_state_readonly_member ON public.conversation_reply_review_state
  FOR SELECT TO app_readonly USING (public.is_active_team_member());
CREATE POLICY reply_reviews_active_member ON public.reply_reviews
  FOR ALL TO app_runtime USING (public.is_active_team_member())
  WITH CHECK (public.is_active_team_member());
CREATE POLICY reply_reviews_readonly_member ON public.reply_reviews
  FOR SELECT TO app_readonly USING (public.is_active_team_member());
CREATE POLICY reply_review_reasons_active_member ON public.reply_review_reasons
  FOR ALL TO app_runtime USING (public.is_active_team_member())
  WITH CHECK (public.is_active_team_member());
CREATE POLICY reply_review_reasons_readonly_member ON public.reply_review_reasons
  FOR SELECT TO app_readonly USING (public.is_active_team_member());
CREATE POLICY reply_review_events_active_member ON public.reply_review_events
  FOR SELECT TO app_runtime, app_readonly USING (public.is_active_team_member());
CREATE POLICY reply_review_events_insert_active_member ON public.reply_review_events
  FOR INSERT TO app_runtime WITH CHECK (public.is_active_team_member());
CREATE POLICY reply_review_mutations_active_member ON public.reply_review_mutations
  FOR SELECT TO app_runtime, app_readonly USING (public.is_active_team_member());
CREATE POLICY reply_review_mutations_insert_active_member ON public.reply_review_mutations
  FOR INSERT TO app_runtime WITH CHECK (public.is_active_team_member());
CREATE POLICY legacy_reply_classifications_active_member ON public.legacy_reply_classifications
  FOR SELECT TO app_runtime, app_readonly USING (public.is_active_team_member());

REVOKE ALL ON TABLE public.reply_review_settings, public.conversation_reply_review_state,
  public.reply_reviews, public.reply_review_reasons, public.reply_review_events,
  public.reply_review_mutations, public.legacy_reply_classifications FROM PUBLIC;
GRANT SELECT ON TABLE public.reply_review_settings, public.legacy_reply_classifications TO app_runtime, app_readonly;
GRANT SELECT, INSERT, UPDATE ON TABLE public.conversation_reply_review_state, public.reply_reviews TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reply_review_reasons TO app_runtime;
GRANT SELECT, INSERT ON TABLE public.reply_review_events, public.reply_review_mutations TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE public.reply_review_events_id_seq TO app_runtime;
GRANT EXECUTE ON FUNCTION public.apply_follow_up_action(text,text,text,text,bigint,uuid,bigint,date,text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.activate_manual_reply_review(uuid, integer) TO app_runtime;

RESET ROLE;
