-- Provider-neutral identity, runtime roles, actor context and RLS artifact.
-- Apply after 001_portable_business_baseline.sql in an empty tenant database.
--
-- The application owns canonical users. Provider subjects are deliberately
-- isolated in user_identities. The server-owned API must begin each database
-- transaction with SET LOCAL app.actor_id = '<canonical user UUID>'. Missing,
-- malformed, unknown, inactive, or non-member actors fail closed in policy
-- expressions without relying on provider claims.

CREATE ROLE app_owner
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS;

CREATE ROLE app_runtime
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS;

CREATE ROLE app_readonly
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS;

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_pkey PRIMARY KEY (id)
);

CREATE TABLE public.user_identities (
    user_id uuid NOT NULL,
    provider text NOT NULL,
    provider_subject text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_identities_provider_check CHECK ((char_length(btrim(provider)) >= 1) AND (char_length(btrim(provider)) <= 80) AND (provider = btrim(provider))),
    CONSTRAINT user_identities_provider_subject_check CHECK ((char_length(btrim(provider_subject)) >= 1) AND (char_length(btrim(provider_subject)) <= 512) AND (provider_subject = btrim(provider_subject))),
    CONSTRAINT user_identities_pkey PRIMARY KEY (user_id, provider),
    CONSTRAINT user_identities_provider_subject_key UNIQUE (provider, provider_subject),
    CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

ALTER TABLE public.team_members
    ADD COLUMN user_id uuid NOT NULL;

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX user_identities_user_id_idx
    ON public.user_identities USING btree (user_id);

CREATE INDEX team_members_user_id_idx
    ON public.team_members USING btree (user_id);

-- Keep all public objects owned by the non-login migration/owner role. The
-- runtime roles below receive explicit least-privilege grants only.
ALTER SCHEMA public OWNER TO app_owner;

ALTER TABLE public.users OWNER TO app_owner;
ALTER TABLE public.user_identities OWNER TO app_owner;
ALTER TABLE public.team_members OWNER TO app_owner;
ALTER TABLE public.annotations OWNER TO app_owner;
ALTER TABLE public.briefing_jobs OWNER TO app_owner;
ALTER TABLE public.briefings OWNER TO app_owner;
ALTER TABLE public.messages OWNER TO app_owner;
ALTER TABLE public.campaign_steps OWNER TO app_owner;
ALTER TABLE public.campaigns OWNER TO app_owner;
ALTER TABLE public.coaching_digest OWNER TO app_owner;
ALTER TABLE public.conversation_coaching OWNER TO app_owner;
ALTER TABLE public.conversation_follow_up_state OWNER TO app_owner;
ALTER TABLE public.events OWNER TO app_owner;
ALTER TABLE public.follow_up_events OWNER TO app_owner;
ALTER TABLE public.hypotheses OWNER TO app_owner;
ALTER TABLE public.hypothesis_campaigns OWNER TO app_owner;
ALTER TABLE public.icp_industries OWNER TO app_owner;
ALTER TABLE public.icp_personas OWNER TO app_owner;
ALTER TABLE public.icps OWNER TO app_owner;
ALTER TABLE public.instances OWNER TO app_owner;
ALTER TABLE public.lead_gender_reviews OWNER TO app_owner;
ALTER TABLE public.lead_notes OWNER TO app_owner;
ALTER TABLE public.leads OWNER TO app_owner;
ALTER TABLE public.pipeline_events OWNER TO app_owner;
ALTER TABLE public.playbook OWNER TO app_owner;
ALTER TABLE public.saved_searches OWNER TO app_owner;
ALTER TABLE public.sync_runs OWNER TO app_owner;

ALTER SEQUENCE public.annotations_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.events_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.follow_up_events_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.hypotheses_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.icp_industries_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.icp_personas_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.icps_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.lead_gender_reviews_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.lead_notes_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.messages_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.pipeline_events_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.saved_searches_id_seq OWNER TO app_owner;
ALTER SEQUENCE public.team_members_id_seq OWNER TO app_owner;

ALTER VIEW public.campaign_metrics OWNER TO app_owner;
ALTER VIEW public.campaign_reply_intent OWNER TO app_owner;
ALTER VIEW public.campaign_reply_sentiment OWNER TO app_owner;
ALTER VIEW public.conversation_latest_message OWNER TO app_owner;
ALTER VIEW public.conversation_reply_intent OWNER TO app_owner;
ALTER VIEW public.daily_activity OWNER TO app_owner;
ALTER VIEW public.pipeline_metrics OWNER TO app_owner;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_runtime, app_readonly;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_runtime, app_readonly;

GRANT INSERT, UPDATE, DELETE ON TABLE
    public.annotations,
    public.briefing_jobs,
    public.briefings,
    public.messages,
    public.campaign_steps,
    public.campaigns,
    public.coaching_digest,
    public.conversation_coaching,
    public.conversation_follow_up_state,
    public.events,
    public.follow_up_events,
    public.hypotheses,
    public.hypothesis_campaigns,
    public.icp_industries,
    public.icp_personas,
    public.icps,
    public.instances,
    public.lead_gender_reviews,
    public.lead_notes,
    public.leads,
    public.pipeline_events,
    public.playbook,
    public.saved_searches,
    public.sync_runs
    TO app_runtime;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
    REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.briefing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coaching_digest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_coaching ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_follow_up_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_up_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hypotheses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hypothesis_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.icp_industries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.icp_personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.icps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_gender_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playbook ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

-- Identity and membership boundaries expose only the current canonical actor.
-- The team_members policy intentionally has no users subquery, so users policy
-- evaluation can safely check active membership without recursive RLS.
CREATE POLICY users_active_actor_select ON public.users
    FOR SELECT TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND id = CASE
            WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN current_setting('app.actor_id', true)::uuid
            ELSE NULL::uuid
        END
        AND active
        AND EXISTS (
            SELECT 1
            FROM public.team_members tm
            WHERE tm.user_id = CASE
                WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                    THEN current_setting('app.actor_id', true)::uuid
                ELSE NULL::uuid
            END
            AND tm.active
        )
    );

CREATE POLICY user_identities_active_actor_select ON public.user_identities
    FOR SELECT TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND user_id = CASE
            WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN current_setting('app.actor_id', true)::uuid
            ELSE NULL::uuid
        END
        AND EXISTS (
            SELECT 1
            FROM public.users u
            WHERE u.id = user_id
            AND u.active
        )
        AND EXISTS (
            SELECT 1
            FROM public.team_members tm
            WHERE tm.user_id = user_id
            AND tm.active
        )
    );

CREATE POLICY team_members_active_actor_select ON public.team_members
    FOR SELECT TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND user_id = CASE
            WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN current_setting('app.actor_id', true)::uuid
            ELSE NULL::uuid
        END
        AND active
    );

-- Shared workspace semantics: an active member can read and mutate shared
-- business rows through the server-owned runtime role. app_readonly receives
-- SELECT only through the same policy; its table grants prevent writes.
CREATE POLICY annotations_active_member ON public.annotations
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY briefing_jobs_active_member ON public.briefing_jobs
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY briefings_active_member ON public.briefings
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY messages_active_member ON public.messages
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY campaign_steps_active_member ON public.campaign_steps
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY campaigns_active_member ON public.campaigns
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY coaching_digest_active_member ON public.coaching_digest
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY conversation_coaching_active_member ON public.conversation_coaching
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY conversation_follow_up_state_active_member ON public.conversation_follow_up_state
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY events_active_member ON public.events
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY follow_up_events_active_member ON public.follow_up_events
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY hypotheses_active_member ON public.hypotheses
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY hypothesis_campaigns_active_member ON public.hypothesis_campaigns
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY icp_industries_active_member ON public.icp_industries
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY icp_personas_active_member ON public.icp_personas
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY icps_active_member ON public.icps
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY instances_active_member ON public.instances
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY lead_gender_reviews_active_member ON public.lead_gender_reviews
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY lead_notes_active_member ON public.lead_notes
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY leads_active_member ON public.leads
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY pipeline_events_active_member ON public.pipeline_events
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY playbook_active_member ON public.playbook
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY saved_searches_active_member ON public.saved_searches
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );

CREATE POLICY sync_runs_active_member ON public.sync_runs
    FOR ALL TO app_runtime, app_readonly
    USING (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    )
    WITH CHECK (
        current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND u.active)
        AND EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = CASE WHEN current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN current_setting('app.actor_id', true)::uuid ELSE NULL::uuid END AND tm.active)
    );
