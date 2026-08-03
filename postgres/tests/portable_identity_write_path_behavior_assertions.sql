\set ON_ERROR_STOP on

-- Behaviour assertions for ledger step 004, invoked by the clean room as the
-- separate app_runtime principal -- the role a request actually arrives on.
--
-- Fixtures come from portable_identity_roles_rls_fixture_seed.sql, seeded by
-- app_migration on a different connection. No owner capability is used here, so
-- every allow and every denial below is what a request path really gets:
--
--   ...0001  active canonical user, active member, role member
--   ...0002  active canonical user, active member, role admin
--   ...0003  inactive canonical user, inactive member, role member
--
-- A grant statement is not evidence. These are the denials that have to bite.

--
-- 1. The write path works for an admin actor.
--
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000002';

SELECT 1 / CASE WHEN (SELECT count(*) FROM public.team_roster()) = 3 THEN 1 ELSE 0 END AS admin_sees_full_roster;

-- The roster read is the point of B4: under RLS this same session sees exactly
-- one team_members row, so every roster join would otherwise resolve to NULL.
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.team_members) = 1 THEN 1 ELSE 0 END AS rls_still_self_only;

DO $$
DECLARE
  v_result jsonb;
  v_user_id uuid;
BEGIN
  v_result := public.identity_admin_invite_member(
    'invited@example.test', 'Invited Four', 'member', 'fixture', 'subject-four');
  v_user_id := (v_result ->> 'user_id')::uuid;

  IF v_user_id IS NULL OR (v_result ->> 'member_id') IS NULL THEN
    RAISE EXCEPTION 'invite returned no identifiers: %', v_result;
  END IF;
  IF (SELECT count(*) FROM public.team_roster()) <> 4 THEN
    RAISE EXCEPTION 'the invited member is not visible in the roster';
  END IF;

  -- The invited person is immediately resolvable as an actor, which is what the
  -- sign-in path needs, and the resolver reports the granted role.
  IF (SELECT count(*) FROM public.identity_resolve_actor('fixture', 'subject-four')) <> 1 THEN
    RAISE EXCEPTION 'the invited subject does not resolve';
  END IF;

  -- Role change and deactivation both work on the same person.
  PERFORM public.identity_admin_set_member_role(v_user_id, 'admin');
  IF (SELECT role FROM public.team_roster() WHERE user_id = v_user_id) <> 'admin' THEN
    RAISE EXCEPTION 'role change did not take effect';
  END IF;

  PERFORM public.identity_admin_set_member_active(v_user_id, false);
  IF (SELECT active FROM public.team_roster() WHERE user_id = v_user_id) THEN
    RAISE EXCEPTION 'deactivation did not take effect on the membership';
  END IF;
  -- Deactivation moves both halves. A canonical user left active with an
  -- inactive membership is the inconsistent state the function must never leave.
  IF (SELECT count(*) FROM public.identity_resolve_actor('fixture', 'subject-four')) <> 0 THEN
    RAISE EXCEPTION 'a deactivated member still resolves as an actor';
  END IF;

  -- Input validation.
  BEGIN
    PERFORM public.identity_admin_invite_member('dup@example.test', 'Dup', 'owner',
                                                'fixture', 'subject-five');
    RAISE EXCEPTION 'an invalid role was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.identity_admin_invite_member('not-an-address', 'Dup', 'member',
                                                'fixture', 'subject-five');
    RAISE EXCEPTION 'an address with no @ was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.identity_admin_invite_member('ACTIVE-ONE@EXAMPLE.TEST', 'Clash',
                                                'member', 'fixture', 'subject-five');
    RAISE EXCEPTION 'a duplicate email was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.identity_admin_set_member_role(
      '00000000-0000-0000-0000-000000000099', 'admin');
    RAISE EXCEPTION 'an unknown member was accepted';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END
$$;
ROLLBACK;

--
-- 2. The final-active-admin invariant holds on both paths.
--
-- ...0002 is the only active admin in the fixtures, so it may not remove its own
-- last-admin status by either route.
--
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000002';
DO $$
BEGIN
  BEGIN
    PERFORM public.identity_admin_set_member_active(
      '00000000-0000-0000-0000-000000000002', false);
    RAISE EXCEPTION 'deactivating the final active admin unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.identity_admin_set_member_role(
      '00000000-0000-0000-0000-000000000002', 'member');
    RAISE EXCEPTION 'demoting the final active admin unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$$;
ROLLBACK;

--
-- 3. An ordinary member cannot reach the write path.
--
-- This is the condition the owner set: not "app_runtime holds no grant", but
-- "an ordinary member cannot get there". The grant is identical for both actors;
-- only the function's own authorization differs.
--
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000001';
DO $$
BEGIN
  BEGIN
    PERFORM public.identity_admin_invite_member('member-invited@example.test',
      'Not Allowed', 'member', 'fixture', 'subject-six');
    RAISE EXCEPTION 'a non-admin member invited someone';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.identity_admin_set_member_active(
      '00000000-0000-0000-0000-000000000002', false);
    RAISE EXCEPTION 'a non-admin member deactivated another member';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.identity_admin_set_member_role(
      '00000000-0000-0000-0000-000000000001', 'admin');
    RAISE EXCEPTION 'a non-admin member promoted itself';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
-- But the same member does get the roster, because that gate is membership.
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.team_roster()) = 3 THEN 1 ELSE 0 END AS member_sees_roster;
ROLLBACK;

--
-- 4. Missing, malformed, unknown and inactive actors reach nothing.
--
BEGIN;
RESET app.actor_id;
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.team_roster()) = 0 THEN 1 ELSE 0 END AS no_actor_no_roster;
DO $$
BEGIN
  BEGIN
    PERFORM public.identity_admin_invite_member('anonymous@example.test', 'Nobody',
      'admin', 'fixture', 'subject-seven');
    RAISE EXCEPTION 'an actorless session invited someone';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

BEGIN;
SET LOCAL app.actor_id = 'not-a-uuid';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.team_roster()) = 0 THEN 1 ELSE 0 END AS malformed_actor_no_roster;
DO $$
BEGIN
  BEGIN
    PERFORM public.identity_admin_set_member_role(
      '00000000-0000-0000-0000-000000000001', 'admin');
    RAISE EXCEPTION 'a malformed actor changed a role';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000099';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.team_roster()) = 0 THEN 1 ELSE 0 END AS unknown_actor_no_roster;
ROLLBACK;

-- An inactive member is not an actor, even though its row exists and its
-- membership row says role member.
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000003';
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.team_roster()) = 0 THEN 1 ELSE 0 END AS inactive_actor_no_roster;
DO $$
BEGIN
  BEGIN
    PERFORM public.identity_admin_invite_member('inactive@example.test', 'Inactive',
      'member', 'fixture', 'subject-eight');
    RAISE EXCEPTION 'an inactive member invited someone';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

--
-- 5. The resolver: what it answers, and what it refuses to be.
--
-- It is deliberately reachable with no actor context, because it is what
-- establishes the actor. Everything else about it fails closed.
--
BEGIN;
RESET app.actor_id;
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.identity_resolve_actor('fixture', 'subject-one')) = 1
                THEN 1 ELSE 0 END AS resolver_needs_no_actor;
SELECT 1 / CASE WHEN (SELECT actor_id FROM public.identity_resolve_actor('fixture', 'subject-one'))
                     = '00000000-0000-0000-0000-000000000001'::uuid
                THEN 1 ELSE 0 END AS resolver_returns_the_canonical_id;
SELECT 1 / CASE WHEN (SELECT role FROM public.identity_resolve_actor('fixture', 'subject-two')) = 'admin'
                THEN 1 ELSE 0 END AS resolver_returns_the_role;

-- An inactive user, an unknown subject and a wrong provider are indistinguishable
-- from each other: all three are zero rows, so the function tells a caller
-- nothing about who exists.
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.identity_resolve_actor('fixture', 'subject-three')) = 0
                     AND (SELECT count(*) FROM public.identity_resolve_actor('fixture', 'no-such-subject')) = 0
                     AND (SELECT count(*) FROM public.identity_resolve_actor('other', 'subject-one')) = 0
                THEN 1 ELSE 0 END AS resolver_fails_closed;

-- Not an enumeration primitive: it matches on equality, so a pattern returns
-- nothing rather than the whole table.
SELECT 1 / CASE WHEN (SELECT count(*) FROM public.identity_resolve_actor('fixture', '%')) = 0
                     AND (SELECT count(*) FROM public.identity_resolve_actor('%', '%')) = 0
                     AND (SELECT count(*) FROM public.identity_resolve_actor('fixture', '')) = 0
                THEN 1 ELSE 0 END AS resolver_is_not_an_enumeration_primitive;
ROLLBACK;

--
-- 6. The functions are the ONLY write path. The S16 measurement still holds.
--
-- Step 004 gave app_runtime no table grant. Direct DML on the canonical tables
-- is still refused, for an admin actor too, so nothing can write these tables
-- without passing through a function that authorizes the caller.
--
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000002';
DO $$
BEGIN
  BEGIN
    INSERT INTO public.users (active) VALUES (true);
    RAISE EXCEPTION 'direct INSERT into public.users unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.team_members (name, active, role, user_id)
    VALUES ('Direct', true, 'member', '00000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'direct INSERT into public.team_members unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.user_identities (user_id, provider, provider_subject)
    VALUES ('00000000-0000-0000-0000-000000000001', 'direct', 'direct-subject');
    RAISE EXCEPTION 'direct INSERT into public.user_identities unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.team_members SET role = 'admin'
    WHERE user_id = '00000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'direct UPDATE of public.team_members unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.users SET active = false
    WHERE id = '00000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'direct UPDATE of public.users unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

--
-- 7. The identity store is unreachable from the request path, in either
--    direction of use: no read, no write, not even schema visibility.
--
BEGIN;
SET LOCAL app.actor_id = '00000000-0000-0000-0000-000000000002';
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM identity."user";
    RAISE EXCEPTION 'app_runtime read the identity store user table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM identity."account";
    RAISE EXCEPTION 'app_runtime read the identity store account table, which holds the password hash';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM identity."session";
    RAISE EXCEPTION 'app_runtime read the identity store session table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO identity."verification" (id, identifier, value, "expiresAt", "updatedAt")
    VALUES ('x', 'x', 'x', now(), now());
    RAISE EXCEPTION 'app_runtime wrote the identity store';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
ROLLBACK;

--
-- 8. The runtime principal still cannot become anything else, and still cannot
--    execute the AI guard. Step 004 changed neither.
--
DO $$
BEGIN
  BEGIN
    PERFORM public.ai_execute_sql('select 1');
    RAISE EXCEPTION 'app_runtime executed the AI SQL guard';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

SELECT 'portable identity write path, resolver and roster behaviour assertions passed' AS result;
