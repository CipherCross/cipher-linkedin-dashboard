\set ON_ERROR_STOP on

-- Provider-neutral migration ledger bootstrap.
--
-- Applied by the non-superuser app_migration principal immediately after the
-- control-plane role bootstrap and before step 001. It is not itself a numbered
-- ledger step: it creates the store the steps are recorded in.
--
-- The ledger deliberately lives in its own app_ledger schema rather than in
-- public. public is the business inventory that S05, S06 and S07 assert against
-- (25 business tables, 27 RLS tables, 52 policies); putting a bookkeeping table
-- there would silently redefine those numbers. app_ledger is invisible to the
-- runtime, read-only path and AI sandbox: it receives no grant at all, so only
-- app_owner — reached by app_migration through SET ROLE — can read or write it.
--
-- This is not a provider migration history. It requires no supabase_migrations
-- schema, no PostgREST, no provider extension and no provider-specific column.
-- It is ordinary PostgreSQL that survives pg_dump/pg_restore into any cluster
-- where the control-plane bootstrap has already created the roles.

SET ROLE app_owner;

CREATE SCHEMA app_ledger;

COMMENT ON SCHEMA app_ledger IS
    'Provider-neutral migration ledger. Source of truth for which portable baseline steps this database has received.';

--
-- The applied-step ledger.
--
-- step        canonical position in the baseline set; also the primary key, so
--             a second attempt to record the same step fails at the database
--             level even if a caller bypasses the runner.
-- applied_seq append-only arrival order. Comparing it to step is what detects
--             an out-of-order apply; applied_at is not sufficient because two
--             applies inside one transaction share a timestamp.
-- apply_principal / apply_role
--             session_user and current_user at insert time. The contract is
--             app_migration entering app_owner; a superuser apply is visible
--             here and is rejected by the verifier.
--
CREATE TABLE app_ledger.applied_migration (
    step integer NOT NULL,
    artifact text NOT NULL,
    sha256 text NOT NULL,
    ledger_version text NOT NULL,
    apply_principal name DEFAULT session_user NOT NULL,
    apply_role name DEFAULT current_user NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    CONSTRAINT applied_migration_pkey PRIMARY KEY (step),
    CONSTRAINT applied_migration_seq_key UNIQUE (applied_seq),
    CONSTRAINT applied_migration_artifact_key UNIQUE (artifact),
    CONSTRAINT applied_migration_step_positive CHECK (step > 0),
    CONSTRAINT applied_migration_artifact_shape CHECK (artifact ~ '^[0-9]{3}_[a-z0-9_]+\.sql$'),
    CONSTRAINT applied_migration_sha256_shape CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT applied_migration_version_shape CHECK (ledger_version ~ '^[a-z0-9.\-]{1,32}$')
);

COMMENT ON TABLE app_ledger.applied_migration IS
    'Append-only record of applied portable baseline steps, in arrival order.';

--
-- The role-bootstrap dependency.
--
-- The baseline set cannot be applied into a database whose roles do not exist,
-- and those roles are not carried by pg_dump. Recording the bootstrap artifact
-- and the role set it is expected to have created makes that dependency part of
-- the ledger rather than tribal knowledge, and lets a restore target be checked
-- before anything is applied to it.
--
CREATE TABLE app_ledger.role_bootstrap (
    id boolean DEFAULT true NOT NULL,
    artifact text NOT NULL,
    sha256 text NOT NULL,
    ledger_version text NOT NULL,
    required_roles text[] NOT NULL,
    recorded_by name DEFAULT session_user NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_bootstrap_pkey PRIMARY KEY (id),
    CONSTRAINT role_bootstrap_single_row CHECK (id),
    CONSTRAINT role_bootstrap_artifact_shape CHECK (artifact ~ '^[0-9]{3}_[a-z0-9_]+\.sql$'),
    CONSTRAINT role_bootstrap_sha256_shape CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT role_bootstrap_roles_present CHECK (array_length(required_roles, 1) > 0)
);

COMMENT ON TABLE app_ledger.role_bootstrap IS
    'The control-plane role prerequisite this database was prepared with. Roles are cluster objects and are never carried by a dump.';

--
-- Append-only enforcement.
--
-- A ledger that can be edited is not evidence. Rows may only be inserted; the
-- history of what a database received is never rewritten or erased. There is no
-- down-migration path here by design: the operations contract keeps reversal as
-- an explicit break-glass action outside this ledger.
--
CREATE FUNCTION app_ledger.reject_ledger_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION
        'migration ledger is append-only: % on %.% is not permitted',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER applied_migration_append_only
    BEFORE UPDATE OR DELETE ON app_ledger.applied_migration
    FOR EACH ROW EXECUTE FUNCTION app_ledger.reject_ledger_rewrite();

CREATE TRIGGER applied_migration_no_truncate
    BEFORE TRUNCATE ON app_ledger.applied_migration
    FOR EACH STATEMENT EXECUTE FUNCTION app_ledger.reject_ledger_rewrite();

CREATE TRIGGER role_bootstrap_append_only
    BEFORE UPDATE OR DELETE ON app_ledger.role_bootstrap
    FOR EACH ROW EXECUTE FUNCTION app_ledger.reject_ledger_rewrite();

CREATE TRIGGER role_bootstrap_no_truncate
    BEFORE TRUNCATE ON app_ledger.role_bootstrap
    FOR EACH STATEMENT EXECUTE FUNCTION app_ledger.reject_ledger_rewrite();

--
-- No principal other than the owner may see or touch the ledger. The runtime,
-- read-only, machine, system and AI roles have no reason to read migration
-- bookkeeping, and the AI sandbox must not discover it at all.
--
REVOKE ALL ON SCHEMA app_ledger FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app_ledger FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_ledger FROM PUBLIC;

RESET ROLE;
