\set ON_ERROR_STOP on

-- Additive control-plane role bootstrap for the identity store.
--
-- This file is a PREREQUISITE of ledger step 004, not a ledger step, and it is
-- deliberately a SEPARATE artifact from 000_control_plane_role_bootstrap.sql
-- rather than an edit to it.
--
-- Why separate, and not an eighth role added to the existing bootstrap:
--
--   app_ledger.role_bootstrap is a single-row, append-only table. It records the
--   digest of the bootstrap artifact a database was prepared with, and the
--   runner hard-fails with role_bootstrap_sha_mismatch when that recorded
--   digest disagrees with the manifest. The row cannot be updated, deleted or
--   replaced -- that is the point of an append-only ledger. So changing the
--   bytes of the existing bootstrap would permanently break the ledger of every
--   database already prepared with it, including a production tenant, with no
--   in-contract remedy and no way to apply any further step to it.
--
--   The seven-role contract is therefore effectively immutable once a database
--   has been provisioned. An additive artifact with its own digest, pinned in
--   the manifest under role_bootstrap_extensions and checked by the static
--   assertions, adds the eighth role without touching that record.
--
-- Executed once per tenant database by the control plane, using the same
-- privileged principal that runs the seven-role bootstrap: a local superuser in
-- the clean room, the provider's non-superuser database owner on a managed
-- platform. Everything after it still runs as the ordinary, non-superuser
-- app_migration login.
--
-- Roles are cluster-level objects and are not carried by pg_dump, which is why
-- this role is created here rather than inside step 004: a restore target must
-- find it already present, or the restore of an object owned by it fails.
--
-- No password, credential, connection string or provider resource identifier
-- appears here. The login credential is assigned out of band by the control
-- plane, exactly as for app_migration and app_runtime.

--
-- PART A -- CLUSTER SCOPE. The identity store role.
--
-- identity_store owns the identity schema and the four tables the accepted Auth
-- candidate generates, and nothing else. It is a LOGIN role because the identity
-- service connects as itself; it is granted nothing in the business schema, and
-- the business runtime is granted nothing of its. The isolation is mutual and is
-- asserted in postgres/tests/portable_identity_write_path_catalog_assertions.sql.
--
-- Written to be safely re-runnable, like part A of the seven-role bootstrap, so
-- a cluster that already hosts a prepared database can host a rehearsal or
-- restore database as well.
--
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_store') THEN
        EXECUTE 'CREATE ROLE identity_store NOSUPERUSER NOCREATEDB NOCREATEROLE '
             || 'NOINHERIT NOREPLICATION NOBYPASSRLS';
    END IF;

    EXECUTE 'ALTER ROLE identity_store LOGIN';

    -- The store resolves its own unqualified relation names and must never fall
    -- through to the business schema. pg_catalog is always searched first and is
    -- not affected by this setting.
    EXECUTE 'ALTER ROLE identity_store SET search_path = identity, pg_temp';
END
$$;

--
-- Membership. One-directional and required by step 004: app_owner applies the
-- step and must be able to SET ROLE into identity_store to hand it the schema
-- and the four tables. This mirrors the existing GRANT app_ai_runner TO
-- app_owner, which exists for exactly the same reason -- ownership transfer to a
-- role the owner is not otherwise allowed to become.
--
-- INHERIT FALSE is deliberate and matches both existing memberships: a privilege
-- is only ever used after an explicit SET ROLE, so app_owner never silently acts
-- with the store's rights. Re-running this is intentional and normalising.
--
SET client_min_messages = warning;
GRANT identity_store TO app_owner WITH INHERIT FALSE;
RESET client_min_messages;

--
-- PART B -- DATABASE SCOPE.
--
-- Nothing. The store's schema, tables and privileges are created by ledger step
-- 004 under SET ROLE app_owner, because they are database objects that a dump
-- does carry. Only the cluster-level role above belongs here.
--
