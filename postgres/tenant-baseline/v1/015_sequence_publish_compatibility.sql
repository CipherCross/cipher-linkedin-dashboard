-- Measured Linked Helper publishing compatibility, notebook-1 canaries, and
-- immutable replacement lineage for jobs stranded solely by contract drift.

SET ROLE app_owner;

CREATE TABLE public.sequence_publish_contracts (
    fingerprint text PRIMARY KEY,
    state text DEFAULT 'observed' NOT NULL,
    evidence jsonb NOT NULL,
    first_observed_version text NOT NULL,
    first_observed_instance_id text NOT NULL REFERENCES public.instances(id),
    observed_at timestamptz DEFAULT now() NOT NULL,
    decided_at timestamptz,
    decision_evidence jsonb,
    CONSTRAINT sequence_publish_contracts_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT sequence_publish_contracts_state_check CHECK (state IN ('observed','canary_pending','approved','rejected')),
    CONSTRAINT sequence_publish_contracts_json_check CHECK (jsonb_typeof(evidence) = 'object' AND (decision_evidence IS NULL OR jsonb_typeof(decision_evidence) = 'object'))
);

CREATE TABLE public.sequence_publish_contract_bindings (
    instance_id text NOT NULL REFERENCES public.instances(id),
    measured_lh_version text NOT NULL,
    contract_fingerprint text NOT NULL REFERENCES public.sequence_publish_contracts(fingerprint),
    probe_evidence jsonb NOT NULL,
    probe_succeeded boolean NOT NULL,
    probed_by_credential_id uuid NOT NULL REFERENCES public.agent_credential(id),
    probed_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (instance_id, measured_lh_version, contract_fingerprint),
    CONSTRAINT sequence_publish_contract_bindings_json_check CHECK (jsonb_typeof(probe_evidence) = 'object')
);

CREATE TABLE public.sequence_publish_canaries (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    contract_fingerprint text NOT NULL UNIQUE REFERENCES public.sequence_publish_contracts(fingerprint),
    instance_id text DEFAULT 'notebook-1' NOT NULL REFERENCES public.instances(id),
    status text DEFAULT 'queued' NOT NULL,
    claim_generation integer DEFAULT 0 NOT NULL,
    claimed_by_credential_id uuid REFERENCES public.agent_credential(id),
    lease_expires_at timestamptz,
    result_evidence jsonb,
    error_code text,
    queued_at timestamptz DEFAULT now() NOT NULL,
    finished_at timestamptz,
    CONSTRAINT sequence_publish_canaries_instance_check CHECK (instance_id = 'notebook-1'),
    CONSTRAINT sequence_publish_canaries_status_check CHECK (status IN ('queued','claimed','approved','rejected')),
    CONSTRAINT sequence_publish_canaries_generation_check CHECK (claim_generation >= 0),
    CONSTRAINT sequence_publish_canaries_result_check CHECK (result_evidence IS NULL OR jsonb_typeof(result_evidence) = 'object')
);

CREATE TABLE public.sequence_publish_compatibility_alerts (
    instance_id text NOT NULL REFERENCES public.instances(id),
    measured_lh_version text NOT NULL,
    contract_fingerprint text NOT NULL REFERENCES public.sequence_publish_contracts(fingerprint),
    transition text NOT NULL,
    claimed_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (instance_id, measured_lh_version, contract_fingerprint, transition),
    CONSTRAINT sequence_publish_compatibility_alerts_transition_check CHECK (transition IN ('unknown','canary_failed','rejected','stale_probe','replacement_exhausted'))
);

ALTER TABLE public.sequence_publish_targets
    ADD COLUMN measured_lh_version text,
    ADD COLUMN contract_fingerprint text REFERENCES public.sequence_publish_contracts(fingerprint),
    ADD COLUMN compatibility_state text DEFAULT 'unknown' NOT NULL,
    ADD CONSTRAINT sequence_publish_targets_compatibility_state_check CHECK (compatibility_state IN ('approved','canary_pending','rejected','unknown'));

ALTER TABLE public.sequence_publish_jobs
    ADD COLUMN target_contract_fingerprint text REFERENCES public.sequence_publish_contracts(fingerprint),
    ADD COLUMN replaces_job_id uuid REFERENCES public.sequence_publish_jobs(id),
    ADD CONSTRAINT sequence_publish_jobs_one_replacement UNIQUE (replaces_job_id);

CREATE INDEX sequence_publish_canaries_claim_idx ON public.sequence_publish_canaries (instance_id, status, lease_expires_at, queued_at);

ALTER TABLE public.sequence_publish_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_publish_contract_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_publish_canaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_publish_compatibility_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY sequence_publish_contracts_member_read ON public.sequence_publish_contracts FOR SELECT TO app_runtime USING (public.is_active_team_member());
CREATE POLICY sequence_publish_contract_bindings_member_read ON public.sequence_publish_contract_bindings FOR SELECT TO app_runtime USING (public.is_active_team_member());
CREATE POLICY sequence_publish_canaries_member_read ON public.sequence_publish_canaries FOR SELECT TO app_runtime USING (public.is_active_team_member());
CREATE POLICY sequence_publish_contracts_machine_read ON public.sequence_publish_contracts FOR SELECT TO app_machine USING (true);
CREATE POLICY sequence_publish_contracts_machine_insert ON public.sequence_publish_contracts FOR INSERT TO app_machine
    WITH CHECK (first_observed_instance_id = public.machine_actor_instance());
CREATE POLICY sequence_publish_contracts_canary_update ON public.sequence_publish_contracts FOR UPDATE TO app_machine
    USING (public.machine_actor_instance() = 'notebook-1')
    WITH CHECK (public.machine_actor_instance() = 'notebook-1');
CREATE POLICY sequence_publish_contracts_canary_update ON public.sequence_publish_contracts FOR UPDATE TO app_machine
    USING (public.machine_actor_instance() = 'notebook-1') WITH CHECK (public.machine_actor_instance() = 'notebook-1');
CREATE POLICY sequence_publish_contract_bindings_machine ON public.sequence_publish_contract_bindings FOR ALL TO app_machine
    USING (instance_id = public.machine_actor_instance()) WITH CHECK (instance_id = public.machine_actor_instance());
CREATE POLICY sequence_publish_canaries_machine_read ON public.sequence_publish_canaries FOR SELECT TO app_machine
    USING (instance_id = public.machine_actor_instance());
CREATE POLICY sequence_publish_canaries_machine_insert ON public.sequence_publish_canaries FOR INSERT TO app_machine
    WITH CHECK (instance_id = 'notebook-1' AND public.machine_actor_instance() = 'notebook-1');
CREATE POLICY sequence_publish_canaries_machine_update ON public.sequence_publish_canaries FOR UPDATE TO app_machine
    USING (instance_id = public.machine_actor_instance()) WITH CHECK (instance_id = public.machine_actor_instance());
CREATE POLICY sequence_publish_compatibility_alerts_machine ON public.sequence_publish_compatibility_alerts FOR INSERT TO app_machine
    WITH CHECK (instance_id = public.machine_actor_instance());

REVOKE ALL ON TABLE public.sequence_publish_contracts, public.sequence_publish_contract_bindings, public.sequence_publish_canaries, public.sequence_publish_compatibility_alerts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.sequence_publish_contracts, public.sequence_publish_contract_bindings, public.sequence_publish_canaries TO app_machine;
GRANT INSERT ON public.sequence_publish_compatibility_alerts TO app_machine;
GRANT SELECT ON public.sequence_publish_contracts, public.sequence_publish_contract_bindings, public.sequence_publish_canaries, public.sequence_publish_compatibility_alerts TO app_runtime;

ALTER TABLE public.sequence_publish_contracts OWNER TO app_owner;
ALTER TABLE public.sequence_publish_contract_bindings OWNER TO app_owner;
ALTER TABLE public.sequence_publish_canaries OWNER TO app_owner;
ALTER TABLE public.sequence_publish_compatibility_alerts OWNER TO app_owner;

RESET ROLE;
