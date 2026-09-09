-- Narrow machine-role insert surface for server-authored replacement jobs.
-- Step 015 creates replacements inside the measured compatibility transaction;
-- step 012 deliberately granted machines only SELECT/UPDATE on jobs and
-- branches, so the new CTE otherwise fails before it can record a probe.

SET ROLE app_owner;

CREATE POLICY sequence_publish_jobs_machine_replacement_insert
    ON public.sequence_publish_jobs
    FOR INSERT TO app_machine
    WITH CHECK (
        target_instance_id = public.machine_actor_instance()
        AND replaces_job_id IS NOT NULL
    );

CREATE POLICY sequence_publish_branches_machine_replacement_insert
    ON public.sequence_publish_branches
    FOR INSERT TO app_machine
    WITH CHECK (EXISTS (
        SELECT 1
          FROM public.sequence_publish_jobs j
         WHERE j.id = sequence_publish_branches.job_id
           AND j.target_instance_id = public.machine_actor_instance()
           AND j.replaces_job_id IS NOT NULL
    ));

GRANT INSERT (
    sequence_document_id, sequence_revision, sequence_version_id, sequence_name,
    document_snapshot, document_fingerprint, compiler_version, publish_options,
    target_instance_id, target_machine_key, target_account_snapshot,
    idempotency_key, payload_digest, created_by,
    target_contract_fingerprint, replaces_job_id
) ON public.sequence_publish_jobs TO app_machine;

GRANT INSERT (
    job_id, branch_id, branch_ordinal, branch_letter, campaign_name,
    compiled_action_chain, action_fingerprint
) ON public.sequence_publish_branches TO app_machine;

RESET ROLE;
