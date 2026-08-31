-- Approval-gated Sequence Builder publishing to empty, paused Linked Helper campaigns.
-- This step stores immutable compiler output and a leased machine work queue. It
-- intentionally grants no campaign start, target, overwrite, archive or delete path.

SET ROLE app_owner;

CREATE TABLE public.sequence_publish_targets (
    instance_id text NOT NULL,
    machine_key text NOT NULL,
    account_snapshot jsonb NOT NULL,
    capability_snapshot jsonb NOT NULL,
    compatible boolean DEFAULT false NOT NULL,
    compatibility_error_code text,
    probed_by_credential_id uuid NOT NULL,
    probed_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sequence_publish_targets_pkey PRIMARY KEY (instance_id),
    CONSTRAINT sequence_publish_targets_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id),
    CONSTRAINT sequence_publish_targets_credential_fkey FOREIGN KEY (probed_by_credential_id) REFERENCES public.agent_credential(id),
    CONSTRAINT sequence_publish_targets_machine_key_check CHECK ((char_length(btrim(machine_key)) >= 1) AND (char_length(machine_key) <= 160)),
    CONSTRAINT sequence_publish_targets_account_check CHECK (jsonb_typeof(account_snapshot) = 'object'),
    CONSTRAINT sequence_publish_targets_capability_check CHECK (jsonb_typeof(capability_snapshot) = 'object'),
    CONSTRAINT sequence_publish_targets_error_check CHECK ((compatibility_error_code IS NULL) OR (char_length(compatibility_error_code) <= 120))
);

CREATE TABLE public.sequence_publish_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_document_id uuid NOT NULL,
    sequence_revision integer NOT NULL,
    sequence_version_id bigint NOT NULL,
    sequence_name text NOT NULL,
    document_snapshot jsonb NOT NULL,
    document_fingerprint text NOT NULL,
    compiler_version text NOT NULL,
    publish_options jsonb NOT NULL,
    target_instance_id text NOT NULL,
    target_machine_key text NOT NULL,
    target_account_snapshot jsonb NOT NULL,
    idempotency_key text NOT NULL,
    payload_digest text NOT NULL,
    status text DEFAULT 'queued' NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    claimed_by_credential_id uuid,
    claim_generation integer DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    error_code text,
    error_details jsonb,
    created_by uuid NOT NULL,
    CONSTRAINT sequence_publish_jobs_pkey PRIMARY KEY (id),
    CONSTRAINT sequence_publish_jobs_sequence_fkey FOREIGN KEY (sequence_document_id) REFERENCES public.sequence_documents(id),
    CONSTRAINT sequence_publish_jobs_version_fkey FOREIGN KEY (sequence_version_id) REFERENCES public.sequence_versions(id),
    CONSTRAINT sequence_publish_jobs_target_fkey FOREIGN KEY (target_instance_id) REFERENCES public.sequence_publish_targets(instance_id),
    CONSTRAINT sequence_publish_jobs_credential_fkey FOREIGN KEY (claimed_by_credential_id) REFERENCES public.agent_credential(id),
    CONSTRAINT sequence_publish_jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id),
    CONSTRAINT sequence_publish_jobs_idempotency_key UNIQUE (target_instance_id, idempotency_key),
    CONSTRAINT sequence_publish_jobs_revision_check CHECK (sequence_revision > 0),
    CONSTRAINT sequence_publish_jobs_attempt_check CHECK (attempt >= 0 AND claim_generation >= 0),
    CONSTRAINT sequence_publish_jobs_status_check CHECK (status IN ('queued', 'claimed', 'preflight', 'publishing', 'success', 'partial_failure', 'conflict', 'failed')),
    CONSTRAINT sequence_publish_jobs_json_check CHECK (
        jsonb_typeof(document_snapshot) = 'object'
        AND jsonb_typeof(publish_options) = 'object'
        AND jsonb_typeof(target_account_snapshot) = 'object'
        AND (error_details IS NULL OR jsonb_typeof(error_details) = 'object')
    ),
    CONSTRAINT sequence_publish_jobs_digest_check CHECK (
        document_fingerprint ~ '^[0-9a-f]{64}$'
        AND payload_digest ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT sequence_publish_jobs_error_check CHECK (
        (error_code IS NULL OR char_length(error_code) <= 120)
        AND (error_details IS NULL OR octet_length(error_details::text) <= 4096)
    )
);

CREATE TABLE public.sequence_publish_branches (
    job_id uuid NOT NULL,
    branch_id text NOT NULL,
    branch_ordinal integer NOT NULL,
    branch_letter text NOT NULL,
    campaign_name text NOT NULL,
    compiled_action_chain jsonb NOT NULL,
    action_fingerprint text NOT NULL,
    status text DEFAULT 'queued' NOT NULL,
    lh_campaign_id text,
    verification_summary jsonb,
    error_code text,
    error_details jsonb,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sequence_publish_branches_pkey PRIMARY KEY (job_id, branch_id),
    CONSTRAINT sequence_publish_branches_job_fkey FOREIGN KEY (job_id) REFERENCES public.sequence_publish_jobs(id),
    CONSTRAINT sequence_publish_branches_ordinal_key UNIQUE (job_id, branch_ordinal),
    CONSTRAINT sequence_publish_branches_campaign_name_key UNIQUE (job_id, campaign_name),
    CONSTRAINT sequence_publish_branches_status_check CHECK (status IN ('queued', 'publishing', 'created', 'conflict', 'failed')),
    CONSTRAINT sequence_publish_branches_identity_check CHECK (
        branch_ordinal >= 0
        AND branch_letter ~ '^[A-Z]$'
        AND char_length(btrim(branch_id)) BETWEEN 1 AND 100
        AND char_length(btrim(campaign_name)) BETWEEN 1 AND 160
    ),
    CONSTRAINT sequence_publish_branches_json_check CHECK (
        jsonb_typeof(compiled_action_chain) = 'array'
        AND (verification_summary IS NULL OR jsonb_typeof(verification_summary) = 'object')
        AND (error_details IS NULL OR jsonb_typeof(error_details) = 'object')
    ),
    CONSTRAINT sequence_publish_branches_digest_check CHECK (action_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT sequence_publish_branches_error_check CHECK (
        (error_code IS NULL OR char_length(error_code) <= 120)
        AND (error_details IS NULL OR octet_length(error_details::text) <= 4096)
    )
);

CREATE INDEX sequence_publish_jobs_human_idx
    ON public.sequence_publish_jobs (sequence_document_id, queued_at DESC, id);
CREATE INDEX sequence_publish_jobs_machine_claim_idx
    ON public.sequence_publish_jobs (target_instance_id, status, lease_expires_at, queued_at, id);
CREATE INDEX sequence_publish_branches_job_idx
    ON public.sequence_publish_branches (job_id, branch_ordinal);

CREATE TRIGGER touch_sequence_publish_targets_updated_at
    BEFORE UPDATE ON public.sequence_publish_targets
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER touch_sequence_publish_jobs_updated_at
    BEFORE UPDATE ON public.sequence_publish_jobs
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER touch_sequence_publish_branches_updated_at
    BEFORE UPDATE ON public.sequence_publish_branches
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.sequence_publish_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_publish_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_publish_branches ENABLE ROW LEVEL SECURITY;

CREATE POLICY sequence_publish_targets_admin_read ON public.sequence_publish_targets
    FOR SELECT TO app_runtime USING (public.is_app_admin());
CREATE POLICY sequence_publish_targets_machine ON public.sequence_publish_targets
    FOR ALL TO app_machine
    USING (instance_id = public.machine_actor_instance())
    WITH CHECK (instance_id = public.machine_actor_instance());

CREATE POLICY sequence_publish_jobs_admin ON public.sequence_publish_jobs
    FOR ALL TO app_runtime
    USING (public.is_app_admin())
    WITH CHECK (public.is_app_admin());
CREATE POLICY sequence_publish_jobs_machine ON public.sequence_publish_jobs
    FOR SELECT TO app_machine
    USING (target_instance_id = public.machine_actor_instance());
CREATE POLICY sequence_publish_jobs_machine_update ON public.sequence_publish_jobs
    FOR UPDATE TO app_machine
    USING (target_instance_id = public.machine_actor_instance())
    WITH CHECK (target_instance_id = public.machine_actor_instance());

CREATE POLICY sequence_publish_branches_admin ON public.sequence_publish_branches
    FOR ALL TO app_runtime
    USING (public.is_app_admin())
    WITH CHECK (public.is_app_admin());
CREATE POLICY sequence_publish_branches_machine ON public.sequence_publish_branches
    FOR SELECT TO app_machine
    USING (EXISTS (
        SELECT 1 FROM public.sequence_publish_jobs j
         WHERE j.id = sequence_publish_branches.job_id
           AND j.target_instance_id = public.machine_actor_instance()
    ));
CREATE POLICY sequence_publish_branches_machine_update ON public.sequence_publish_branches
    FOR UPDATE TO app_machine
    USING (EXISTS (
        SELECT 1 FROM public.sequence_publish_jobs j
         WHERE j.id = sequence_publish_branches.job_id
           AND j.target_instance_id = public.machine_actor_instance()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sequence_publish_jobs j
         WHERE j.id = sequence_publish_branches.job_id
           AND j.target_instance_id = public.machine_actor_instance()
    ));

REVOKE ALL ON TABLE
    public.sequence_publish_targets,
    public.sequence_publish_jobs,
    public.sequence_publish_branches
    FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON TABLE
    public.sequence_publish_targets,
    public.sequence_publish_jobs,
    public.sequence_publish_branches
    TO app_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE public.sequence_publish_targets TO app_machine;
GRANT SELECT, UPDATE ON TABLE public.sequence_publish_jobs, public.sequence_publish_branches TO app_machine;

ALTER TABLE public.sequence_publish_targets OWNER TO app_owner;
ALTER TABLE public.sequence_publish_jobs OWNER TO app_owner;
ALTER TABLE public.sequence_publish_branches OWNER TO app_owner;

RESET ROLE;
