\set ON_ERROR_STOP on

-- Additive control-plane role bootstrap for the AI execution principal.
--
-- This file is a PREREQUISITE of ledger step 007, not a ledger step, and it is
-- deliberately a SEPARATE artifact from 000_control_plane_role_bootstrap.sql
-- rather than an edit to it, for the same reason the identity store bootstrap
-- is separate: app_ledger.role_bootstrap is a single-row, append-only record
-- of that artifact's digest, and the runner hard-fails with
-- role_bootstrap_sha_mismatch when the recorded digest disagrees with the
-- manifest. Changing the bytes of the seven-role bootstrap would permanently
-- break the ledger of every database already prepared with it, with no
-- in-contract remedy. An additive artifact with its own digest, pinned in the
-- manifest under role_bootstrap_extensions and checked by the static
-- assertions, is the contract's way to change what a role can do.
--
-- Unlike the identity store extension, this artifact CREATES NO ROLE.
-- app_system is part of the seven-role contract: it already exists in every
-- prepared cluster, NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
-- NOREPLICATION NOBYPASSRLS and NOLOGIN, its database-scoped privilege set
-- already fixed by step 003 — USAGE on public and EXECUTE on the AI SQL guard
-- and nothing else. What this artifact changes is exactly one attribute: it
-- makes app_system a LOGIN role, so the AI layer can connect as the principal
-- the guard was designed around instead of reaching it through a test fixture
-- whose password lives in a session scratchpad.
--
-- A cluster where app_system does not exist was never prepared with the
-- seven-role bootstrap, and this artifact refuses it loudly rather than
-- recreating the role with attributes that might differ from the pinned
-- contract.
--
-- Executed once per cluster by the control plane, using the same privileged
-- principal that runs the seven-role bootstrap: a local superuser in the
-- clean room, the provider's non-superuser database owner on a managed
-- platform.
--
-- No password, credential, connection string or provider resource identifier
-- appears here. The login credential is assigned out of band by the control
-- plane, exactly as for app_migration and app_runtime.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
        RAISE EXCEPTION
            'app_system does not exist: prepare the cluster with the seven-role bootstrap first'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- Re-runnable and normalising, like part A of the seven-role bootstrap: a
    -- cluster that already carries a prepared database can host a rehearsal or
    -- restore database as well, and re-applying LOGIN to a login role is a
    -- no-op.
    EXECUTE 'ALTER ROLE app_system LOGIN';
END
$$;
