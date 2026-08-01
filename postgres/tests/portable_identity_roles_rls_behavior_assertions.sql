\set ON_ERROR_STOP on

-- The clean-room invokes this file as the separate app_runtime principal.
-- Identity fixtures are seeded by app_migration in a different connection;
-- no owner role is used to prove an authorization result here.

-- A valid active user actor can read shared business data and its own
-- canonical identity boundary, and can perform shared-workspace DML.
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 1 THEN 1 ELSE 0 END AS active_shared_read;
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.users) = 1
                     AND (SELECT count(*) FROM public.user_identities) = 1
                     AND (SELECT count(*) FROM public.team_members) = 1
                THEN 1 ELSE 0 END AS active_identity_boundary_read;
INSERT INTO public.annotations (note, noted_at) VALUES ('active actor fixture', CURRENT_DATE);
UPDATE public.annotations SET note = 'active actor fixture updated' WHERE note = 'active actor fixture';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.annotations WHERE note = 'active actor fixture updated') = 1 THEN 1 ELSE 0 END AS active_update_allowed;
DELETE FROM public.annotations WHERE note = 'active actor fixture updated';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.annotations WHERE note = 'active actor fixture updated') = 0 THEN 1 ELSE 0 END AS active_delete_allowed;
ROLLBACK;

-- A second active user is allowed the shared workspace but not another
-- user's canonical identity rows. This is the cross-user DML denial.
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000002';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 1 THEN 1 ELSE 0 END AS second_active_shared_read;
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.users) = 1
                     AND (SELECT count(*) FROM public.user_identities) = 1
                     AND (SELECT count(*) FROM public.team_members) = 1
                THEN 1 ELSE 0 END AS second_identity_boundary_read;
DO $$
BEGIN
  BEGIN
    UPDATE public.team_members SET name = 'must not change' WHERE user_id = '00000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'cross-user team_members update unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.user_identities (user_id, provider, provider_subject)
    VALUES ('00000000-0000-0000-0000-000000000001', 'cross-user', 'must-not-write');
    RAISE EXCEPTION 'cross-user identity insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

-- Missing, malformed, unknown and inactive actors all deny both visibility and
-- business DML. Each expected RLS error is caught so the following case runs.
BEGIN;
RESET app.actor_id;
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 0
                     AND (SELECT count(*) FROM public.users) = 0
                THEN 1 ELSE 0 END AS missing_actor_denied;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.annotations (note, noted_at) VALUES ('missing actor must fail', CURRENT_DATE);
    RAISE EXCEPTION 'missing actor insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

BEGIN;
SET LOCAL app.actor_id = 'not-a-uuid';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 0
                     AND (SELECT count(*) FROM public.users) = 0
                THEN 1 ELSE 0 END AS malformed_actor_denied;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.annotations (note, noted_at) VALUES ('malformed actor must fail', CURRENT_DATE);
    RAISE EXCEPTION 'malformed actor insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000099';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 0
                     AND (SELECT count(*) FROM public.users) = 0
                THEN 1 ELSE 0 END AS unknown_actor_denied;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.annotations (note, noted_at) VALUES ('unknown actor must fail', CURRENT_DATE);
    RAISE EXCEPTION 'unknown actor insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000003';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 0
                     AND (SELECT count(*) FROM public.users) = 0
                     AND (SELECT count(*) FROM public.user_identities) = 0
                     AND (SELECT count(*) FROM public.team_members) = 0
                THEN 1 ELSE 0 END AS inactive_actor_denied;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.annotations (note, noted_at) VALUES ('inactive actor must fail', CURRENT_DATE);
    RAISE EXCEPTION 'inactive actor insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

-- SET LOCAL actor state is transaction-scoped and is absent after rollback.
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 1 THEN 1 ELSE 0 END AS transaction_actor_allow;
ROLLBACK;

BEGIN;
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.playbook) = 0 THEN 1 ELSE 0 END AS transaction_actor_reset;
ROLLBACK;

SELECT 'portable identity, actor context and RLS DML assertions passed' AS result;
