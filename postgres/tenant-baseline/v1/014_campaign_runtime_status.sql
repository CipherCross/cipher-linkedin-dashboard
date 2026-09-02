-- Last-observed Linked Helper campaign runtime state.
--
-- Runtime, archive membership and observation health are deliberately separate.
-- NULL is the fail-closed value for every unverified or unsupported signal; the
-- legacy campaigns.status column remains only for compatibility with old agents.

SET ROLE app_owner;

ALTER TABLE public.campaigns
    ADD COLUMN runtime_status text,
    ADD COLUMN is_archived boolean,
    ADD COLUMN status_observed_at timestamp with time zone,
    ADD COLUMN status_source text,
    ADD COLUMN status_raw text,
    ADD CONSTRAINT campaigns_runtime_status_check CHECK (
        runtime_status IS NULL OR runtime_status IN (
            'draft', 'running', 'queued', 'sleeping', 'stopped', 'completed'
        )
    ),
    ADD CONSTRAINT campaigns_status_source_length CHECK (
        status_source IS NULL OR char_length(status_source) <= 120
    ),
    ADD CONSTRAINT campaigns_status_raw_length CHECK (
        status_raw IS NULL OR char_length(status_raw) <= 500
    ),
    ADD CONSTRAINT campaigns_status_observation_shape CHECK (
        status_observed_at IS NOT NULL
        OR (runtime_status IS NULL AND is_archived IS NULL
            AND status_source IS NULL AND status_raw IS NULL)
    );

-- The Supabase compatibility transport performs a direct PostgREST upsert, while
-- the portable ingest gateway uses a fixed SQL operation. Keeping the monotonic
-- rule in this trigger protects both paths: an old agent (no observation) and an
-- out-of-order retry cannot erase a newer observation. An equal timestamp is an
-- idempotent retry and may replace the same snapshot.
CREATE FUNCTION public.campaigns_keep_latest_runtime_observation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
    IF NEW.status_observed_at IS NULL
       OR (OLD.status_observed_at IS NOT NULL
           AND NEW.status_observed_at < OLD.status_observed_at) THEN
        NEW.runtime_status := OLD.runtime_status;
        NEW.is_archived := OLD.is_archived;
        NEW.status_observed_at := OLD.status_observed_at;
        NEW.status_source := OLD.status_source;
        NEW.status_raw := OLD.status_raw;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.campaigns_keep_latest_runtime_observation() FROM PUBLIC;

CREATE TRIGGER campaigns_keep_latest_runtime_observation
BEFORE UPDATE OF runtime_status, is_archived, status_observed_at, status_source, status_raw
ON public.campaigns
FOR EACH ROW
EXECUTE FUNCTION public.campaigns_keep_latest_runtime_observation();

-- Append the normalized fields to the existing view without changing any of its
-- historical funnel semantics or column order.
CREATE OR REPLACE VIEW public.campaign_metrics WITH (security_invoker='true') AS
 SELECT c.id AS campaign_id,
    c.name AS campaign_name,
    c.instance_id,
    c.status,
    count(l.id) AS total_leads,
    count(l.invited_at) AS invites_sent,
    count(l.connected_at) AS accepted,
    count(l.replied_at) AS replies,
    round(((100.0 * (count(l.connected_at) FILTER (WHERE (l.invited_at IS NOT NULL)))::numeric) / (NULLIF(count(l.invited_at), 0))::numeric), 1) AS acceptance_rate,
    round(((100.0 * (count(l.replied_at) FILTER (WHERE (l.connected_at IS NOT NULL)))::numeric) / (NULLIF(count(l.connected_at), 0))::numeric), 1) AS reply_rate,
    max(l.last_action_at) AS last_activity_at,
    c.briefing_context,
    c.briefing_context_updated_at,
    c.runtime_status,
    c.is_archived,
    c.status_observed_at,
    c.status_source,
    c.status_raw
   FROM (public.campaigns c
     LEFT JOIN public.leads l ON ((l.campaign_id = c.id)))
  GROUP BY c.id;

ALTER FUNCTION public.campaigns_keep_latest_runtime_observation() OWNER TO app_owner;
ALTER VIEW public.campaign_metrics OWNER TO app_owner;

REVOKE ALL ON TABLE public.campaign_metrics FROM PUBLIC;
GRANT SELECT ON TABLE public.campaign_metrics TO app_runtime, app_readonly, app_ai_runner;

RESET ROLE;
