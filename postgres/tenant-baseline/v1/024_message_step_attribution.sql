-- Step 024: which campaign step produced each outbound message, and how each
-- step performs on that basis.
--
-- Nothing linked a sent message to the step or variation that produced it, so
-- "which wording gets replies" could only be read from LH2's per-step counts.
-- This step matches each outbound body against the synced step templates
-- server-side: both sides are lower-cased with whitespace collapsed, and each
-- template becomes an anchored regex in which every variable ({{firstName}},
-- {firstName}, ...) matches up to 120 characters. Measured read-only on
-- production 2026-10-15: 94% of outbound messages to campaign leads match
-- (8,735 of 9,320), 1% match more than one step. The rest are mostly hand-typed
-- messages, plus template variants LH2 never synced (only variant 0 is).
--
-- The match costs ~9 s over the whole corpus, too slow for a view under the AI
-- guard's 10 s limit, so it is materialized:
--
-- * message_step_attribution: one row per outbound message with text, including
--   'none' rows for messages that matched nothing, so an incremental refresh
--   never retries them. Attribution is a derived cache: never the only copy of
--   anything, rebuilt by a full refresh.
-- * refresh_message_step_attribution(instance, full): the only writer. SECURITY
--   DEFINER as app_owner; app_system may execute it. Incremental by default
--   (messages with no row yet); full recomputes the instance and upserts, so it
--   picks up edited templates. It never deletes: a deleted message takes its
--   row with it through the foreign key.
-- * step_attribution_performance: per campaign step, messages sent and the
--   replies that followed them (an inbound message after this outbound and
--   before the thread's next outbound), with mature counts, positive and P3.
--
-- Candidates for a message, in order of preference: steps of the campaigns the
-- person is a lead of on the same instance (most recently added first), then the
-- step of the message's own campaign_id (a guess on chat-store rows), then any
-- step on the instance (method 'instance_template', for a lead whose campaign
-- row has gone). Ties keep the earliest step and count as ambiguous.
--
-- Funnel semantics are untouched: this is an extra layer beside the milestone
-- timestamps, the views and the agent's derive_events.

SET ROLE app_owner;

CREATE TABLE public.message_step_attribution (
    message_id bigint NOT NULL,
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    campaign_id text,
    step_index integer,
    step_type text,
    message_ordinal integer,
    method text NOT NULL,
    candidates integer DEFAULT 0 NOT NULL,
    attributed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_step_attribution_pkey PRIMARY KEY (message_id),
    CONSTRAINT message_step_attribution_message_fkey FOREIGN KEY (message_id)
        REFERENCES public.messages(id) ON DELETE CASCADE,
    CONSTRAINT message_step_attribution_method_check CHECK (method IN (
        'lead_campaign', 'message_campaign', 'instance_template', 'none'
    )),
    CONSTRAINT message_step_attribution_shape_check CHECK (
        (method = 'none' AND campaign_id IS NULL AND step_index IS NULL AND candidates = 0)
        OR (method <> 'none' AND campaign_id IS NOT NULL AND step_index IS NOT NULL AND candidates >= 1)
    )
);

CREATE INDEX message_step_attribution_step_idx
    ON public.message_step_attribution (campaign_id, step_index) WHERE campaign_id IS NOT NULL;
CREATE INDEX message_step_attribution_thread_idx
    ON public.message_step_attribution (instance_id, profile_url);

ALTER TABLE public.message_step_attribution OWNER TO app_owner;
ALTER TABLE public.message_step_attribution ENABLE ROW LEVEL SECURITY;

CREATE POLICY message_step_attribution_ai_read ON public.message_step_attribution
    FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY message_step_attribution_active_member ON public.message_step_attribution
    FOR SELECT TO app_runtime, app_readonly USING (public.is_active_team_member());

REVOKE ALL ON TABLE public.message_step_attribution FROM PUBLIC;
GRANT SELECT ON TABLE public.message_step_attribution TO app_ai_runner, app_runtime, app_readonly;

-- Lower-case, collapse whitespace, trim: the form both sides are compared in.
CREATE FUNCTION public.normalize_message_text(p_text text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT lower(regexp_replace(btrim(p_text), '\s+', ' ', 'g')) $$;

-- A template as an anchored regex: literal text escaped, each variable a lazy
-- gap of up to 120 characters.
CREATE FUNCTION public.message_template_pattern(p_template text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT '^' || replace(
           regexp_replace(
             regexp_replace(public.normalize_message_text(p_template),
               '\{\{[^}]*\}\}|\{(firstname|companyname|jobtitle|sendername)\}', chr(1), 'g'),
             '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'),
           chr(1), '.{0,120}?') || '$'
$$;

ALTER FUNCTION public.normalize_message_text(text) OWNER TO app_owner;
ALTER FUNCTION public.message_template_pattern(text) OWNER TO app_owner;
REVOKE ALL ON FUNCTION public.normalize_message_text(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.message_template_pattern(text) FROM PUBLIC;

CREATE FUNCTION public.refresh_message_step_attribution(p_instance_id text, p_full boolean DEFAULT false)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET statement_timeout TO '120s'
    AS $$
DECLARE
  v_written integer;
  v_result jsonb;
BEGIN
  IF p_instance_id IS NULL OR btrim(p_instance_id) = '' THEN
    RAISE EXCEPTION 'refresh_message_step_attribution: instance id required' USING errcode = '22023';
  END IF;

  WITH tpl AS (
    SELECT s.campaign_id, s.step_index, s.step_type,
           CASE WHEN s.step_type = 'InvitePerson' THEN 0
                ELSE row_number() OVER (PARTITION BY s.campaign_id, s.step_type ORDER BY s.step_index)::integer
           END AS message_ordinal,
           public.message_template_pattern(s.template_body) AS pattern
      FROM public.campaign_steps s
      JOIN public.campaigns c ON c.id = s.campaign_id
     WHERE c.instance_id = p_instance_id
       AND s.step_type IN ('InvitePerson', 'MessageToPerson')
       AND coalesce(btrim(s.template_body), '') <> ''
  ), outm AS (
    SELECT m.id, m.profile_url, m.campaign_id, public.normalize_message_text(m.body) AS nb
      FROM public.messages m
     WHERE m.instance_id = p_instance_id
       AND m.direction = 'out'
       AND coalesce(btrim(m.body), '') <> ''
       AND (p_full OR NOT EXISTS (
             SELECT 1 FROM public.message_step_attribution a WHERE a.message_id = m.id))
  ), person_campaigns AS (
    SELECT l.profile_url, l.campaign_id, max(l.added_at) AS added_at
      FROM public.leads l
     WHERE l.instance_id = p_instance_id
     GROUP BY l.profile_url, l.campaign_id
  ), primary_cand AS (
    SELECT o.id, tp.campaign_id, tp.step_index, tp.step_type, tp.message_ordinal,
           'lead_campaign'::text AS method, 1 AS preference, pc.added_at
      FROM outm o
      JOIN person_campaigns pc ON pc.profile_url = o.profile_url
      JOIN tpl tp ON tp.campaign_id = pc.campaign_id
     WHERE o.nb ~ tp.pattern
    UNION ALL
    SELECT o.id, tp.campaign_id, tp.step_index, tp.step_type, tp.message_ordinal,
           'message_campaign'::text, 2, NULL::timestamptz
      FROM outm o
      JOIN tpl tp ON tp.campaign_id = o.campaign_id
     WHERE o.nb ~ tp.pattern
       AND NOT EXISTS (SELECT 1 FROM person_campaigns pc
                        WHERE pc.profile_url = o.profile_url AND pc.campaign_id = o.campaign_id)
  ), fallback_cand AS (
    SELECT o.id, tp.campaign_id, tp.step_index, tp.step_type, tp.message_ordinal,
           'instance_template'::text AS method, 3 AS preference, NULL::timestamptz AS added_at
      FROM outm o
      JOIN tpl tp ON o.nb ~ tp.pattern
     WHERE EXISTS (SELECT 1 FROM person_campaigns pc WHERE pc.profile_url = o.profile_url)
       AND NOT EXISTS (SELECT 1 FROM primary_cand p WHERE p.id = o.id)
  ), cand AS (
    SELECT * FROM primary_cand UNION ALL SELECT * FROM fallback_cand
  ), counted AS (
    SELECT c.*, count(*) OVER (PARTITION BY c.id) AS n,
           row_number() OVER (PARTITION BY c.id
                              ORDER BY c.preference, c.added_at DESC NULLS LAST, c.step_index, c.campaign_id) AS pick
      FROM cand c
  ), chosen AS (
    SELECT o.id, o.profile_url, k.campaign_id, k.step_index, k.step_type, k.message_ordinal,
           coalesce(k.method, 'none') AS method, coalesce(k.n, 0)::integer AS candidates
      FROM outm o
      LEFT JOIN counted k ON k.id = o.id AND k.pick = 1
  ), written AS (
    INSERT INTO public.message_step_attribution AS a
           (message_id, instance_id, profile_url, campaign_id, step_index, step_type,
            message_ordinal, method, candidates, attributed_at)
    SELECT ch.id, p_instance_id, ch.profile_url, ch.campaign_id, ch.step_index, ch.step_type,
           ch.message_ordinal, ch.method, ch.candidates, now()
      FROM chosen ch
    ON CONFLICT (message_id) DO UPDATE
       SET campaign_id = EXCLUDED.campaign_id, step_index = EXCLUDED.step_index,
           step_type = EXCLUDED.step_type, message_ordinal = EXCLUDED.message_ordinal,
           method = EXCLUDED.method, candidates = EXCLUDED.candidates,
           profile_url = EXCLUDED.profile_url, attributed_at = EXCLUDED.attributed_at
    RETURNING a.method, a.candidates
  )
  SELECT jsonb_build_object(
           'instance_id', p_instance_id,
           'full', p_full,
           'written', count(*),
           'matched', count(*) FILTER (WHERE method <> 'none'),
           'unmatched', count(*) FILTER (WHERE method = 'none'),
           'ambiguous', count(*) FILTER (WHERE candidates > 1),
           'instance_template', count(*) FILTER (WHERE method = 'instance_template'))
    INTO v_result
    FROM written;

  RETURN v_result;
END;
$$;

ALTER FUNCTION public.refresh_message_step_attribution(text, boolean) OWNER TO app_owner;
REVOKE ALL ON FUNCTION public.refresh_message_step_attribution(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_message_step_attribution(text, boolean) TO app_system;

-- Per campaign step: what was sent and what followed. A reply belongs to the
-- latest outbound before it, so each inbound message credits at most one
-- outbound. "Mature" = sent more than 14 days ago, old enough for most replies.
CREATE VIEW public.step_attribution_performance WITH (security_invoker='true') AS
WITH outs AS (
    SELECT m.id, m.instance_id, m.profile_url, m.sent_at,
           lead(m.sent_at) OVER (PARTITION BY m.instance_id, m.profile_url ORDER BY m.sent_at, m.id) AS next_out_at
      FROM public.messages m
     WHERE m.direction = 'out'
), scored AS (
    SELECT a.campaign_id, a.step_index, a.step_type, a.message_ordinal, a.candidates,
           a.instance_id, a.profile_url, o.sent_at,
           r.first_reply_at, r.positive, r.p3
      FROM public.message_step_attribution a
      JOIN outs o ON o.id = a.message_id
      LEFT JOIN LATERAL (
        SELECT min(mi.sent_at) AS first_reply_at,
               coalesce(bool_or(rr.sentiment = 'positive'), false) AS positive,
               coalesce(bool_or(rr.intent_level = 'p3'), false) AS p3
          FROM public.messages mi
          LEFT JOIN public.reply_reviews rr ON rr.message_id = mi.id
         WHERE mi.instance_id = a.instance_id AND mi.profile_url = a.profile_url
           AND mi.direction = 'in'
           AND mi.sent_at > o.sent_at
           AND (o.next_out_at IS NULL OR mi.sent_at < o.next_out_at)
      ) r ON true
     WHERE a.campaign_id IS NOT NULL
)
SELECT s.campaign_id, s.step_index, s.step_type, s.message_ordinal,
       count(*) AS sent,
       count(DISTINCT (s.instance_id, s.profile_url)) AS people,
       count(*) FILTER (WHERE s.first_reply_at IS NOT NULL) AS replied,
       count(*) FILTER (WHERE s.sent_at < now() - interval '14 days') AS mature_sent,
       count(*) FILTER (WHERE s.sent_at < now() - interval '14 days' AND s.first_reply_at IS NOT NULL) AS mature_replied,
       count(*) FILTER (WHERE s.positive) AS positive_replies,
       count(*) FILTER (WHERE s.p3) AS p3_replies,
       count(*) FILTER (WHERE s.candidates > 1) AS ambiguous_sent,
       min(s.sent_at) AS first_sent_at,
       max(s.sent_at) AS last_sent_at
  FROM scored s
 GROUP BY s.campaign_id, s.step_index, s.step_type, s.message_ordinal;

ALTER VIEW public.step_attribution_performance OWNER TO app_owner;
REVOKE ALL ON TABLE public.step_attribution_performance FROM PUBLIC;
GRANT SELECT ON TABLE public.step_attribution_performance TO app_ai_runner, app_runtime, app_readonly;

RESET ROLE;
