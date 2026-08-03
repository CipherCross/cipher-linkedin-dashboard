\set ON_ERROR_STOP on

-- Provider-neutral control-plane role bootstrap for a tenant database.
--
-- This file is a PREREQUISITE of the migration ledger, not a ledger step. It is
-- executed once per tenant database by the control plane using whatever
-- privileged principal that provider hands the operator (a local superuser in
-- the clean-room, the provider's database owner role on a managed platform).
-- Everything after it — the ledger bootstrap and steps 001..003 — runs as the
-- ordinary, non-superuser app_migration login.
--
-- Roles are deliberately created here rather than inside a ledger step because
-- roles are cluster-level objects: pg_dump does not carry them, so a restore
-- into a different cluster must find them already created by this bootstrap.
-- That is exactly why the dump/restore harness never uses `pg_dumpall
-- --roles-only`, which would move role credentials between clusters.
--
-- No password, credential, connection string or provider resource ID appears
-- here. Login credentials are assigned out of band by the control plane.

--
-- PART A — CLUSTER SCOPE. Roles and memberships.
--
-- Roles live in the cluster, not in a database, which is why pg_dump never
-- carries them and why a restore target must be prepared with this file first.
-- The role section is written to be safely re-runnable so that a cluster which
-- already hosts a prepared database can host a rehearsal or restore database
-- as well; part B is database-scoped and runs again for every such database.
--
-- The seven-role contract established by S06 and S07:
--   app_owner      object owner, never logs in
--   app_migration  migration principal, logs in, owns nothing
--   app_runtime    application runtime, separate login, no BYPASSRLS
--   app_readonly   read-only group
--   app_machine    machine/ingest principal reserved for S21, fails closed
--   app_system     server-owned system/job principal reserved for S15
--   app_ai_runner  AI SQL sandbox, owns only the guard function
--
DO $$
DECLARE
    role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY[
        'app_owner', 'app_migration', 'app_runtime', 'app_readonly',
        'app_machine', 'app_system', 'app_ai_runner'
    ]
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format(
                'CREATE ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT '
                || 'NOREPLICATION NOBYPASSRLS',
                role_name
            );
        END IF;
    END LOOP;

    -- Only the two principals an operator or a server process connects as may
    -- log in. The rest are reached with SET ROLE and can never open a session.
    EXECUTE 'ALTER ROLE app_migration LOGIN';
    EXECUTE 'ALTER ROLE app_runtime LOGIN';
END
$$;

--
-- Memberships. Both are one-directional and both are required by the artifacts:
-- app_migration must become app_owner to apply them, and app_owner must become
-- app_ai_runner to hand it the guard function without a superuser.
--
-- INHERIT FALSE is deliberate on both. A privilege is only ever used after an
-- explicit SET ROLE, so no principal silently acts with more rights than the
-- statement it is running claims.
--
-- Re-running these is intentional and normalising: it puts INHERIT back to
-- FALSE on a cluster where a restore window was left open. PostgreSQL notices
-- the existing membership, which is expected rather than interesting.
SET client_min_messages = warning;
GRANT app_owner TO app_migration WITH INHERIT FALSE;
GRANT app_ai_runner TO app_owner WITH INHERIT FALSE;
RESET client_min_messages;

--
-- PART B — DATABASE SCOPE. Capabilities inside this database.
--

-- 001 installs pgcrypto, which is a trusted extension. A non-superuser may
-- install a trusted extension only with CREATE on the current database, so the
-- owner role receives it here. The database name is resolved at runtime so this
-- file carries no provider-specific resource identifier.
DO $$
BEGIN
    EXECUTE format('GRANT CREATE ON DATABASE %I TO app_owner', current_database());
END
$$;

-- Make the executing principal able to SET ROLE app_owner before the ownership
-- transfer below needs it.
--
-- A managed provider hands the operator a NON-SUPERUSER privileged principal
-- (Neon's neondb_owner, and the equivalent elsewhere). Since PostgreSQL 16, a
-- role holding CREATEROLE that creates a role is auto-granted membership in it
-- with admin_option = true but SET_OPTION = FALSE. Transferring an object to a
-- role requires the executor to be able to SET ROLE into it, so without this
-- grant the next statement fails with: must be able to SET ROLE "app_owner".
--
-- A superuser is exempt from that membership check, which is why the clean-room
-- harnesses -- which bootstrap as the postgres superuser -- never exercised this
-- path and the defect stayed invisible until the first real managed apply. The
-- grant is therefore made ONLY for a non-superuser principal, so the clean-room
-- role graph, and the S08 inventory snapshots that cover role memberships, stay
-- byte-identical.
--
-- This confers nothing the principal did not already hold: it created these
-- roles and holds ADMIN OPTION on them, so it could grant itself SET at any
-- time. INHERIT FALSE preserves the rule that a privilege is only ever used
-- after an explicit SET ROLE.
DO $$
BEGIN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = CURRENT_USER) THEN
        EXECUTE format(
            'GRANT app_owner TO %I WITH SET TRUE, INHERIT FALSE',
            CURRENT_USER
        );
    END IF;
END
$$;

-- Schema ownership. 001 predates the role contract and contains no SET ROLE, so
-- the ledger runner enters app_owner for it; that requires public to be owned by
-- app_owner up front. 002 re-asserts the same ownership as a no-op.
ALTER SCHEMA public OWNER TO app_owner;

-- Anonymous access is closed immediately, before any object exists. 002 repeats
-- the object-level revokes once the objects are there.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
