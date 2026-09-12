-- Step 018: preserve the reply-review taxonomy contract during activation.
--
-- Step 017 copied messages.intent_taxonomy_version directly into the new
-- reply_reviews.taxonomy_version column.  Legacy manual sentiment-only rows
-- legitimately have no intent taxonomy, but reply_reviews.taxonomy_version is
-- required and uses the current reply-review contract version.  This additive
-- replacement keeps activation resumable/idempotent while defaulting only the
-- missing source value; all provenance and compatibility semantics remain the
-- same as step 017.
SET ROLE app_owner;

CREATE OR REPLACE FUNCTION public.activate_manual_reply_review(
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
      NULL,COALESCE(m.intent_taxonomy_version, 'reply-review-v1'), NULL,
      COALESCE(m.classified_at,m.sent_at), 1,
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

ALTER FUNCTION public.activate_manual_reply_review(uuid, integer) OWNER TO app_owner;
REVOKE ALL ON FUNCTION public.activate_manual_reply_review(uuid, integer) FROM PUBLIC;

RESET ROLE;
