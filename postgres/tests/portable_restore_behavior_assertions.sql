\set ON_ERROR_STOP on

-- Post-restore behavioural assertions, invoked as the app_runtime principal.
--
-- The S06 actor-context assertions are replayed separately and unchanged by the
-- harness; this file covers the behaviour that must specifically survive a
-- dump and a restore into a different cluster: the milestone contract, and the
-- AI SQL guard's reachability from the wrong principals.
--
-- Every case rolls back. The restored database is evidence and is not mutated.

--
-- 1. Milestone preservation. The restored trigger must still refuse to regress
--    a non-NULL milestone to NULL, and must still allow a NULL one to be filled
--    forward. alpha carries a complete chain; beta starts empty.
--
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';

SELECT 1 / CASE WHEN (SELECT replied_at FROM public.leads
                       WHERE id = '11111111-1111-4111-8111-111111111111') IS NOT NULL
                THEN 1 ELSE 0 END AS alpha_milestone_survived_restore;

UPDATE public.leads
   SET invited_at = NULL, connected_at = NULL, first_message_at = NULL, replied_at = NULL
 WHERE id = '11111111-1111-4111-8111-111111111111';

SELECT 1 / CASE WHEN (SELECT count(*) FROM public.leads
                       WHERE id = '11111111-1111-4111-8111-111111111111'
                         AND invited_at IS NOT NULL
                         AND connected_at IS NOT NULL
                         AND first_message_at IS NOT NULL
                         AND replied_at IS NOT NULL) = 1
                THEN 1 ELSE 0 END AS milestone_regress_blocked_after_restore;

UPDATE public.leads
   SET invited_at = '2026-02-01 10:00:00+00'
 WHERE id = '22222222-2222-4222-8222-222222222222';

SELECT 1 / CASE WHEN (SELECT invited_at FROM public.leads
                       WHERE id = '22222222-2222-4222-8222-222222222222')
                     = '2026-02-01 10:00:00+00'::timestamptz
                THEN 1 ELSE 0 END AS milestone_fill_forward_after_restore;
ROLLBACK;

--
-- 2. The AI SQL guard is unreachable from the runtime principal. app_runtime
--    must not execute it and must not become the sandbox role that owns it.
--
DO $$
BEGIN
  BEGIN
    PERFORM public.ai_execute_sql('select 1');
    RAISE EXCEPTION 'app_runtime executed the AI SQL guard after restore';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    EXECUTE 'SET ROLE app_ai_runner';
    RAISE EXCEPTION 'app_runtime became app_ai_runner after restore';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    EXECUTE 'SET ROLE app_system';
    RAISE EXCEPTION 'app_runtime became app_system after restore';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

SELECT 'post-restore milestone and guard-reachability assertions passed' AS result;
