\set ON_ERROR_STOP on

-- Test-only bootstrap executed by the disposable PostgreSQL superuser. The
-- S06 artifact itself is subsequently applied through app_migration, which is
-- a separate non-superuser login. No role password is stored here or in SQL.
CREATE ROLE app_owner
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE app_migration
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT LOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE app_runtime
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT LOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE app_readonly
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE app_machine
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE app_system
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS;

GRANT app_owner TO app_migration;

-- S05 was intentionally applied by the disposable bootstrap superuser. Move
-- its schema objects to the dedicated owner before the migration principal
-- connects; S06 then owns the same boundary for the new identity objects.
ALTER SCHEMA public OWNER TO app_owner;
DO $$
DECLARE
  object_row record;
BEGIN
  FOR object_row IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I OWNER TO app_owner',
      object_row.relname
    );
  END LOOP;

  FOR object_row IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'v'
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'ALTER VIEW public.%I OWNER TO app_owner',
      object_row.relname
    );
  END LOOP;

  FOR object_row IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'ALTER SEQUENCE public.%I OWNER TO app_owner',
      object_row.relname
    );
  END LOOP;
END
$$;
