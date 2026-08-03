\set ON_ERROR_STOP on

-- Restore window — OPEN.
--
-- Run by the control plane against an already-bootstrapped, still-empty restore
-- target, immediately before pg_restore. Its counterpart restore_window_close.sql
-- must run immediately after and asserts that everything opened here is shut.
--
-- Why a window is needed at all.
--
-- The portable baseline deliberately gives the AI SQL guard its own owner,
-- app_ai_runner, which is otherwise a powerless SELECT-only sandbox. A dump of
-- that database therefore contains two statements that the sandbox's own
-- privileges cannot satisfy on a clean target:
--
--   ALTER FUNCTION public.ai_execute_sql(query text) OWNER TO app_ai_runner;
--       PostgreSQL requires the incoming owner to hold CREATE on the schema.
--       003 grants that, takes ownership and revokes it again in one artifact,
--       so a restored database legitimately has no such grant to inherit.
--
--   REVOKE ALL ON FUNCTION public.ai_execute_sql(query text) FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.ai_execute_sql(query text) TO app_system;
--       Only the function's owner may re-grant its privileges. pg_restore runs
--       these as app_owner, which is a member of app_ai_runner but NOINHERIT,
--       so without this window they do not raise an error — they emit a warning
--       and silently do nothing, leaving the guard at its default ACL: EXECUTE
--       for PUBLIC and no grant to app_system. That is a privilege escalation
--       produced by restore alone, and pg_restore --exit-on-error does not
--       catch it because a failed GRANT is only a warning.
--
-- Neither grant may outlive the restore. restore_window_close.sql revokes both
-- and fails if either is still in place, and the reconciliation harness asserts
-- the same properties independently afterwards.
--
-- No credential, connection string or provider resource ID appears here.

-- 1. Let the sandbox role receive ownership of its one function.
GRANT CREATE ON SCHEMA public TO app_ai_runner;

-- 2. Let app_owner act with the sandbox's rights for the duration of the
--    restore, so the guard's ACL is re-established by its real owner. This
--    grants app_owner nothing it does not already exceed: app_owner owns every
--    other object in the database.
GRANT app_ai_runner TO app_owner WITH INHERIT TRUE;

-- 3. The same two problems, for the identity store that ledger step 004 adds.
--
--    The store's schema and four tables are owned by identity_store, a role with
--    no CREATE anywhere. A dump of that database therefore contains statements a
--    clean target cannot satisfy:
--
--      ALTER SCHEMA identity OWNER TO identity_store;
--          PostgreSQL requires the incoming owner of a schema to hold CREATE on
--          the database. 004 never grants that -- it creates the schema with
--          CREATE SCHEMA ... AUTHORIZATION instead -- so a restored database has
--          no such grant to inherit.
--
--      GRANT USAGE ON SCHEMA identity TO app_owner;
--      GRANT SELECT ON TABLE identity."user" TO app_owner;   (and the other three)
--          Only the owner may re-grant. pg_restore runs these as app_owner, which
--          is a member of identity_store but NOINHERIT, so they emit a warning
--          and silently do nothing. The failure mode is the nasty one: the
--          restore reports success and the restored tenant can no longer be
--          dumped, because the backup principal has lost its read of the store.
--
--    Neither capability may outlive the restore. restore_window_close.sql
--    reverses both, asserts they are shut, and asserts the store's grants and
--    ownership actually came back.
DO $$
BEGIN
    EXECUTE format('GRANT CREATE ON DATABASE %I TO identity_store', current_database());
END
$$;

GRANT identity_store TO app_owner WITH INHERIT TRUE;

SELECT 'restore window open: app_ai_runner may receive the AI guard, identity_store may receive its schema, and app_owner may re-grant for both' AS result;
