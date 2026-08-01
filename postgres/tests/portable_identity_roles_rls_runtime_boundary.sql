\set ON_ERROR_STOP on

-- This file is executed as the separate app_runtime login. The shell harness
-- separately attempts SET ROLE app_owner and SET ROLE app_migration so those
-- failures are observed from the runtime session, not inferred from postgres.
SELECT 1 / CASE WHEN current_user = 'app_runtime' THEN 1 ELSE 0 END AS runtime_principal;
SELECT 1 / CASE WHEN NOT pg_has_role('app_runtime', 'app_owner', 'member')
                     AND NOT pg_has_role('app_runtime', 'app_migration', 'member')
                THEN 1 ELSE 0 END AS runtime_role_membership_denied;
SELECT 1 / CASE WHEN NOT EXISTS (
                   SELECT 1
                   FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                   JOIN pg_roles r ON r.oid = c.relowner
                   WHERE n.nspname = 'public'
                     AND r.rolname = 'app_runtime'
                 ) THEN 1 ELSE 0 END AS runtime_owns_no_public_objects;
SELECT 1 / CASE WHEN (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime') IS FALSE THEN 1 ELSE 0 END AS runtime_bypassrls_denied;
SELECT 'portable runtime role boundary assertions passed' AS result;
