\set ON_ERROR_STOP on

-- Additive control-plane role bootstrap for the machine ingest principal.
--
-- This file is a PREREQUISITE of ledger step 009, not a ledger step, and it is
-- a SEPARATE artifact from 000_control_plane_role_bootstrap.sql rather than an
-- edit to it, for the reason both earlier extensions record:
-- app_ledger.role_bootstrap is a single-row, append-only record of that
-- artifact's digest, and the runner hard-fails with role_bootstrap_sha_mismatch
-- when the recorded digest disagrees with the manifest. Changing the bytes of
-- the seven-role bootstrap would permanently break the ledger of every database
-- already prepared with it, with no in-contract remedy. An additive artifact
-- with its own digest, pinned in the manifest under role_bootstrap_extensions
-- and checked by the static assertions, is the contract's way to change what a
-- role can do.
--
-- Like the AI execution extension and unlike the identity store one, this
-- artifact CREATES NO ROLE. app_machine is part of the seven-role contract --
-- it already exists in every prepared cluster as NOSUPERUSER NOCREATEDB
-- NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS and NOLOGIN, and its
-- database-scoped privilege set is fixed by ledger step 009 rather than here.
-- What this artifact changes is exactly one attribute: it makes app_machine a
-- LOGIN role, so the ingest endpoint can connect as the principal step 009's
-- policies were written for.
--
-- Why the attribute cannot live in step 009. A role is a cluster-level object.
-- pg_dump does not carry it, a restore target must find it already present, and
-- the ledger applies as app_migration -- which is NOCREATEROLE and therefore
-- cannot alter another role at all. Step 009 is correct and complete in a
-- database whose app_machine still cannot log in; what it opens simply has no
-- principal to enter it until this artifact has run.
--
-- A cluster where app_machine does not exist was never prepared with the
-- seven-role bootstrap, and this artifact refuses it loudly rather than
-- recreating the role with attributes that might differ from the pinned
-- contract.
--
-- Executed once per cluster by the control plane, using the same privileged
-- principal that runs the seven-role bootstrap: a local superuser in the clean
-- room, the provider's non-superuser database owner on a managed platform.
--
-- No password, credential, connection string or provider resource identifier
-- appears here. The login credential is assigned out of band by the control
-- plane, exactly as for app_migration, app_runtime and app_system.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_machine') THEN
        RAISE EXCEPTION
            'app_machine does not exist: prepare the cluster with the seven-role bootstrap first'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- Re-runnable and normalising, like part A of the seven-role bootstrap: a
    -- cluster that already carries a prepared database can host a rehearsal or
    -- restore database as well, and re-applying LOGIN to a login role is a
    -- no-op.
    EXECUTE 'ALTER ROLE app_machine LOGIN';
END
$$;
