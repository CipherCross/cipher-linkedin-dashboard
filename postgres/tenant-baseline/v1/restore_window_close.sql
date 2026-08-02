\set ON_ERROR_STOP on

-- Restore window — CLOSE.
--
-- Run by the control plane immediately after pg_restore, against the restored
-- target. It reverses restore_window_open.sql and then refuses to succeed
-- unless the target is back on the production privilege contract.

-- 1. Reverse the two temporary capabilities.
REVOKE CREATE ON SCHEMA public FROM app_ai_runner;
GRANT app_ai_runner TO app_owner WITH INHERIT FALSE;

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
END
$$;

SELECT 'restore window closed and post-restore privilege contract verified' AS result;
