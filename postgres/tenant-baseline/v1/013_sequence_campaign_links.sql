-- Unified sequence/deployment read model support.
-- Publish lineage remains derived from immutable jobs. This table records only
-- deliberate human links such as converting an externally sourced campaign.

SET ROLE app_owner;

CREATE TABLE public.campaign_sequence_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id text NOT NULL,
    sequence_document_id uuid NOT NULL,
    link_kind text NOT NULL,
    source_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    linked_by uuid NOT NULL,
    linked_by_name text NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_sequence_links_pkey PRIMARY KEY (id),
    CONSTRAINT campaign_sequence_links_campaign_key UNIQUE (campaign_id),
    CONSTRAINT campaign_sequence_links_campaign_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id),
    CONSTRAINT campaign_sequence_links_sequence_fkey FOREIGN KEY (sequence_document_id) REFERENCES public.sequence_documents(id),
    CONSTRAINT campaign_sequence_links_linked_by_fkey FOREIGN KEY (linked_by) REFERENCES public.users(id),
    CONSTRAINT campaign_sequence_links_kind_check CHECK (link_kind IN ('explicit_conversion', 'explicit_link')),
    CONSTRAINT campaign_sequence_links_name_check CHECK ((char_length(btrim(linked_by_name)) >= 1) AND (char_length(linked_by_name) <= 160)),
    CONSTRAINT campaign_sequence_links_metadata_check CHECK (jsonb_typeof(source_metadata) = 'object')
);

CREATE INDEX campaign_sequence_links_sequence_idx
    ON public.campaign_sequence_links (sequence_document_id, linked_at DESC, id);

ALTER TABLE public.campaign_sequence_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY campaign_sequence_links_member_read ON public.campaign_sequence_links
    FOR SELECT TO app_runtime, app_readonly
    USING (public.is_active_team_member());
CREATE POLICY campaign_sequence_links_admin_write ON public.campaign_sequence_links
    FOR ALL TO app_runtime
    USING (public.is_app_admin())
    WITH CHECK (public.is_app_admin());

-- The hub is shared operational context. Publishing remains admin-only; these
-- additional policies expose immutable target/job/branch rows read-only to every
-- active member without widening any machine-changing capability.
CREATE POLICY sequence_publish_targets_member_read ON public.sequence_publish_targets
    FOR SELECT TO app_runtime, app_readonly
    USING (public.is_active_team_member());
CREATE POLICY sequence_publish_jobs_member_read ON public.sequence_publish_jobs
    FOR SELECT TO app_runtime, app_readonly
    USING (public.is_active_team_member());
CREATE POLICY sequence_publish_branches_member_read ON public.sequence_publish_branches
    FOR SELECT TO app_runtime, app_readonly
    USING (public.is_active_team_member());

REVOKE ALL ON TABLE public.campaign_sequence_links FROM PUBLIC;

GRANT SELECT ON TABLE public.campaign_sequence_links TO app_runtime, app_readonly;
GRANT INSERT, UPDATE ON TABLE public.campaign_sequence_links TO app_runtime;
GRANT SELECT ON TABLE
    public.sequence_publish_targets,
    public.sequence_publish_jobs,
    public.sequence_publish_branches
    TO app_readonly;

ALTER TABLE public.campaign_sequence_links OWNER TO app_owner;

RESET ROLE;
