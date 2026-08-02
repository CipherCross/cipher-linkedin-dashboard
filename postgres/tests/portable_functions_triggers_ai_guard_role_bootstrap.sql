\set ON_ERROR_STOP on

-- Test-only bootstrap executed by the disposable PostgreSQL superuser after the
-- S06 role bootstrap. It creates only the AI sandbox role that S07 introduces
-- and the memberships the artifact needs. No role credential of any kind is
-- stored here or anywhere else in SQL.
--
-- app_ai_runner replaces the provider-specific SELECT-only role of the source
-- schema. It is non-superuser, non-BYPASSRLS, NOLOGIN and owns no business
-- object; it only ends up owning the SECURITY DEFINER AI guard function.
CREATE ROLE app_ai_runner
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS;

-- app_owner must be able to SET ROLE into app_ai_runner to hand the guard
-- function to its dedicated owner without a superuser. Membership is one
-- directional: app_ai_runner gains nothing from app_owner.
GRANT app_ai_runner TO app_owner;

-- app_system is the S06 server-owned system/job principal and is the AI
-- execution path S07 grants the guard to. It is NOLOGIN in the real contract,
-- so the clean-room adds a test-only login that can do nothing except SET ROLE
-- app_system. It is NOINHERIT, so the assertions must switch role explicitly
-- and cannot accidentally borrow another principal's privileges.
CREATE ROLE app_ai_client
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT LOGIN NOREPLICATION NOBYPASSRLS;
GRANT app_system TO app_ai_client;
