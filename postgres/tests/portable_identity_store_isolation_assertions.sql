\set ON_ERROR_STOP on

-- Behaviour assertions run by the clean room as the identity_store principal
-- itself -- the role the identity service will connect as.
--
-- The isolation this proves is mutual. The companion file
-- portable_identity_write_path_behavior_assertions.sql proves the request path
-- cannot reach the store; this one proves the store cannot reach the workspace it
-- authenticates people into. A compromise of the identity service must not become
-- a read of the business data.

-- The store owns its four tables and can use them.
INSERT INTO identity."user" ("id", "name", "email", "emailVerified")
VALUES ('subject-store-one', 'Store One', 'store-one@example.test', true);

INSERT INTO identity."account" ("id", "accountId", "providerId", "userId", "password", "updatedAt")
VALUES ('account-store-one', 'store-one@example.test', 'credential', 'subject-store-one',
        'scrypt-hash-placeholder', now());

INSERT INTO identity."session" ("id", "expiresAt", "token", "updatedAt", "userId")
VALUES ('session-store-one', now() + interval '1 day', 'token-store-one', now(), 'subject-store-one');

SELECT 1 / CASE WHEN (SELECT count(*) FROM identity."user") = 1
                     AND (SELECT count(*) FROM identity."account") = 1
                     AND (SELECT count(*) FROM identity."session") = 1
                THEN 1 ELSE 0 END AS store_owns_its_tables;

-- The role-level search_path set by the control-plane prerequisite resolves the
-- candidate's unqualified relation names to its own schema and nowhere else.
SELECT 1 / CASE WHEN (SELECT count(*) FROM "user") = 1 THEN 1 ELSE 0 END AS unqualified_names_resolve_to_the_store;

-- And the workspace is entirely out of reach: no schema usage, so not one
-- business or canonical identity table can be named, let alone read.
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.users;
    RAISE EXCEPTION 'identity_store read public.users';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM public.team_members;
    RAISE EXCEPTION 'identity_store read public.team_members';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM public.user_identities;
    RAISE EXCEPTION 'identity_store read public.user_identities';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM public.leads;
    RAISE EXCEPTION 'identity_store read public.leads';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM public.messages;
    RAISE EXCEPTION 'identity_store read public.messages';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Nor can it reach the write path, the resolver or the roster.
  BEGIN
    PERFORM public.identity_resolve_actor('fixture', 'subject-one');
    RAISE EXCEPTION 'identity_store executed the actor resolver';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.team_roster();
    RAISE EXCEPTION 'identity_store executed the roster read';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.identity_admin_invite_member('store@example.test', 'Store',
      'admin', 'fixture', 'subject-store-two');
    RAISE EXCEPTION 'identity_store executed the invite function';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Nor the migration ledger, and nor another principal's identity.
  BEGIN
    PERFORM count(*) FROM app_ledger.applied_migration;
    RAISE EXCEPTION 'identity_store read the migration ledger';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    EXECUTE 'SET ROLE app_owner';
    RAISE EXCEPTION 'identity_store became app_owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    EXECUTE 'SET ROLE app_runtime';
    RAISE EXCEPTION 'identity_store became app_runtime';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- Fixture rows are left behind on purpose: the clean room checks that the dump,
-- the restore and the re-apply all leave them intact.
SELECT 'portable identity store isolation assertions passed' AS result;
