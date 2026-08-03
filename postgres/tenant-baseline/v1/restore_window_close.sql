\set ON_ERROR_STOP on

-- Restore window — CLOSE.
--
-- Run by the control plane immediately after pg_restore, against the restored
-- target. It reverses restore_window_open.sql and then refuses to succeed
-- unless the target is back on the production privilege contract.

-- 1. Reverse the temporary capabilities.
REVOKE CREATE ON SCHEMA public FROM app_ai_runner;
GRANT app_ai_runner TO app_owner WITH INHERIT FALSE;
DO $$
BEGIN
    EXECUTE format('REVOKE CREATE ON DATABASE %I FROM identity_store', current_database());
END
$$;
GRANT identity_store TO app_owner WITH INHERIT FALSE;

-- 2. Prove the window is shut and that the restore produced the intended
--    privilege picture rather than PostgreSQL's defaults. Each check here has a
--    matching, independently written assertion in
--    postgres/tests/portable_restore_reconciliation.sql; this one exists so an
--    operator running the documented procedure by hand cannot leave a restored
--    tenant in a weakened state without being told.
DO $$
BEGIN
    IF pg_catalog.has_schema_privilege('app_ai_runner', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'restore window still open: app_ai_runner retains CREATE on schema public';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_auth_members m
        JOIN pg_roles member ON member.oid = m.member
        JOIN pg_roles grantee ON grantee.oid = m.roleid
        WHERE member.rolname = 'app_owner'
          AND grantee.rolname = 'app_ai_runner'
          AND m.inherit_option
    ) THEN
        RAISE EXCEPTION 'restore window still open: app_owner inherits app_ai_runner';
    END IF;

    IF pg_catalog.has_function_privilege('public', 'public.ai_execute_sql(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'AI SQL guard is executable by PUBLIC after restore';
    END IF;

    IF NOT pg_catalog.has_function_privilege('app_system', 'public.ai_execute_sql(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'AI SQL guard lost its app_system EXECUTE grant during restore';
    END IF;

    IF (SELECT pg_get_userbyid(proowner)
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'ai_execute_sql') <> 'app_ai_runner' THEN
        RAISE EXCEPTION 'AI SQL guard is not owned by app_ai_runner after restore';
    END IF;

    -- The identity store half of the window, in the same shape.
    IF pg_catalog.has_database_privilege('identity_store', current_database(), 'CREATE') THEN
        RAISE EXCEPTION 'restore window still open: identity_store retains CREATE on the database';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_auth_members m
        JOIN pg_roles member ON member.oid = m.member
        JOIN pg_roles grantee ON grantee.oid = m.roleid
        WHERE member.rolname = 'app_owner'
          AND grantee.rolname = 'identity_store'
          AND m.inherit_option
    ) THEN
        RAISE EXCEPTION 'restore window still open: app_owner inherits identity_store';
    END IF;

    IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'identity')
       <> 'identity_store' THEN
        RAISE EXCEPTION 'the identity schema is not owned by identity_store after restore';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'identity' AND c.relkind = 'r'
          AND pg_get_userbyid(c.relowner) <> 'identity_store'
    ) THEN
        RAISE EXCEPTION 'an identity store table is not owned by identity_store after restore';
    END IF;

    -- The silent failure this window exists to prevent: the backup principal
    -- losing its read of the store, which makes the restored tenant impossible to
    -- dump while the restore itself reports success.
    IF NOT pg_catalog.has_schema_privilege('app_owner', 'identity', 'USAGE') THEN
        RAISE EXCEPTION 'app_owner lost USAGE on schema identity during restore; this tenant can no longer be dumped';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'identity' AND c.relkind = 'r'
          AND NOT pg_catalog.has_table_privilege('app_owner', c.oid, 'SELECT')
    ) THEN
        RAISE EXCEPTION 'app_owner lost SELECT on an identity store table during restore; this tenant can no longer be dumped';
    END IF;

    IF pg_catalog.has_schema_privilege('app_runtime', 'identity', 'USAGE') THEN
        RAISE EXCEPTION 'app_runtime gained USAGE on schema identity during restore';
    END IF;
END
$$;

SELECT 'restore window closed and post-restore privilege contract verified' AS result;
