--
-- Behaviour assertions for ledger step 005, the atomic cross-store invite.
--
-- Run as **app_runtime**, the real request principal. That is the whole point:
-- the function's authorization is inside the function, gated on
-- public.is_app_admin() against app.actor_id, and both an admin and an ordinary
-- member arrive here on the same connection with the same EXECUTE grant. Only
-- the actor differs, so only a behavioural test from this principal can tell
-- whether the gate works.
--
-- **This file commits, and is therefore clean-room only.** Step 004's behaviour
-- file rolls everything back, which is why it could also be run against the live
-- project. This one cannot: proving that both halves of an invite land together
-- means letting them land, and the store half can only be observed from an
-- identity_store session that app_runtime is not. So it creates one person in a
-- throwaway container and the clean-room script inspects the result. Do not run
-- it against a database whose rows matter.
--
-- It relies on the S06 identity fixtures the baseline seeds (subject-one active
-- member, subject-two active admin, subject-three inactive).
--
-- What is asserted, in order:
--   1. a non-admin member cannot invite -- the denial that matters most;
--   2. no actor at all cannot invite;
--   3. an admin can, and all five rows appear together;
--   4. atomicity: a failure in the store half takes the canonical half with it;
--   5. validation refuses each malformed argument;
--   6. the duplicate-email refusal still bites;
--   7. app_runtime still cannot touch the identity tables directly, so the
--      function is the only way in.
--

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO warning;

DO $$
declare
  v_member_actor uuid;
  v_admin_actor uuid;
  v_result jsonb;
  v_subject text;
  v_count bigint;
begin
  -- The fixture actor ids are constants from
  -- portable_identity_roles_rls_fixture_seed.sql, not looked up -- and the reason
  -- is itself one of the properties under test. As app_runtime, *querying* for
  -- them is impossible: user_identities_active_actor_select requires
  -- user_id = app.actor_id, so reading the mapping needs the answer first. That
  -- is exactly the constraint public.identity_resolve_actor exists to lift, and a
  -- test that could look them up freely would be running with privileges the
  -- request path does not have.
  v_member_actor := '00000000-0000-0000-0000-000000000001';
  v_admin_actor := '00000000-0000-0000-0000-000000000002';

  -- Confirm the preconditions through the actor context instead: with each actor
  -- published, is_app_admin() must disagree between the two. If the fixtures were
  -- missing, both would be false and the denial test below would pass for the
  -- wrong reason -- a false green this check exists to prevent.
  perform set_config('app.actor_id', v_admin_actor::text, true);
  if not public.is_app_admin() then
    raise exception 'fixture actor 2 is not an active admin; seed the S06 fixtures first';
  end if;
  perform set_config('app.actor_id', v_member_actor::text, true);
  if public.is_app_admin() then
    raise exception 'fixture actor 1 is unexpectedly an admin; the fixtures are wrong';
  end if;
  if not public.is_active_team_member() then
    raise exception 'fixture actor 1 is not an active member; seed the S06 fixtures first';
  end if;

  -- 1. A non-admin member must be refused. -----------------------------------
  perform set_config('app.actor_id', v_member_actor::text, true);
  begin
    v_result := public.identity_admin_invite_member_atomic(
      'member-attempt@example.test', 'Member Attempt', 'member', 'better-auth',
      'subject-member-attempt', 'fake-hash-value');
    raise exception 'a non-admin member invited someone';
  exception
    when insufficient_privilege then
      raise notice 'ok: a non-admin member is refused (42501)';
    when others then
      -- Anything other than 42501 means the gate did not fire; the validation
      -- checks all run *after* it, so a 22023 here would mean the argument
      -- checks ran before authorization.
      raise exception 'expected 42501 for a non-admin member, got % (%)',
        SQLSTATE, SQLERRM;
  end;

  -- 2. No actor at all must be refused. --------------------------------------
  perform set_config('app.actor_id', '', true);
  begin
    v_result := public.identity_admin_invite_member_atomic(
      'no-actor@example.test', 'No Actor', 'member', 'better-auth', 'subject-no-actor',
      'fake-hash-value');
    raise exception 'an anonymous caller invited someone';
  exception
    when insufficient_privilege then
      raise notice 'ok: an anonymous caller is refused (42501)';
    when others then
      raise exception 'expected 42501 for no actor, got % (%)', SQLSTATE, SQLERRM;
  end;

  -- 3. An admin can, and every row lands together. ---------------------------
  perform set_config('app.actor_id', v_admin_actor::text, true);
  v_result := public.identity_admin_invite_member_atomic(
    'invited@example.test', 'Invited Person', 'member', 'better-auth',
    'subject-invited-001', 'scrypt$fake:hash');

  if v_result->>'email' is distinct from 'invited@example.test'
     or v_result->>'role' is distinct from 'member'
     or (v_result->>'active')::boolean is distinct from true then
    raise exception 'the invite returned an unexpected payload: %', v_result;
  end if;

  -- provider_subject must come back, because the caller needs it to revoke that
  -- person's sessions and must not have to trust its own request for it.
  if v_result->>'provider_subject' is distinct from 'subject-invited-001' then
    raise exception 'the invite did not return the provider subject: %', v_result;
  end if;
  raise notice 'ok: an admin can invite, and the payload names the subject';

  v_subject := v_result->>'provider_subject';

  -- The new member is verified through public.team_roster(), which is how the
  -- product reads the roster, and not with a direct select.
  --
  -- The direct select is not merely discouraged here, it is impossible: the
  -- policies on users, team_members and user_identities all restrict app_runtime
  -- to its *own* row, so this principal cannot see the person it just created.
  -- That surprised this file into being rewritten, and it is worth recording as a
  -- property rather than an obstacle -- an admin can create a member and still
  -- cannot read anyone's raw canonical rows. team_roster() is the sanctioned way
  -- through, it is membership-gated, and it returns the same seven columns to
  -- everyone.
  select count(*) into v_count
    from public.team_roster() r
   where r.user_id = (v_result->>'user_id')::uuid
     and lower(r.email) = 'invited@example.test'
     and r.role = 'member'
     and r.active;
  if v_count <> 1 then
    raise exception 'the invited member does not appear in team_roster()';
  end if;
  raise notice 'ok: the invited member appears in team_roster() as an active member';

  -- Two things are deliberately NOT checked from here, and for the same reason:
  -- public.users / public.user_identities are invisible to this principal for
  -- anyone but itself, and the identity schema is invisible to it entirely. Both
  -- are verified by the clean-room script -- the canonical rows as app_owner, the
  -- store rows as identity_store -- after this file commits. Opening either up
  -- with a probe function would be a hole made for a test's convenience, in the
  -- exact boundary step 004 exists to establish.

  -- 4. Atomicity. A second invite reusing the same subject must fail on the
  --    store half (identity."user".id is the primary key) and must leave no
  --    canonical rows behind, even though those inserts come first.
  begin
    v_result := public.identity_admin_invite_member_atomic(
      'second@example.test', 'Second Person', 'member', 'better-auth',
      v_subject, 'scrypt$fake:hash');
    raise exception 'a duplicate store subject was accepted';
  exception
    when unique_violation then
      raise notice 'ok: a duplicate store subject is refused (23505)';
    when others then
      raise exception 'expected 23505 for a duplicate subject, got % (%)',
        SQLSTATE, SQLERRM;
  end;

  -- The failed invite must have taken its own canonical rows with it. The
  -- exception was caught by the block above, which rolled back to that block's
  -- implicit savepoint, so the enclosing transaction is still live and the roster
  -- read below sees exactly what survived.
  --
  -- This is the heart of the step. The three canonical inserts happen *before*
  -- the two store inserts, so under the two-transaction design they would already
  -- have committed by the time the store half failed, and 'Second Person' would
  -- now be a member who can never sign in.
  select count(*) into v_count
    from public.team_roster() r
   where lower(r.email) = 'second@example.test';
  if v_count <> 0 then
    raise exception 'the failed invite left % member(s) on the roster', v_count;
  end if;
  raise notice 'ok: a failure in the store half leaves no half-person on the roster';

  -- 5. Validation. Each of these must be refused with 22023, and none of them
  --    may reach either store.
  begin
    v_result := public.identity_admin_invite_member_atomic(
      'nohash@example.test', 'No Hash', 'member', 'better-auth',
      'subject-nohash', '');
    raise exception 'an empty password hash was accepted';
  exception
    when invalid_parameter_value then
      raise notice 'ok: an empty password hash is refused (22023)';
    when others then
      raise exception 'expected 22023 for an empty hash, got % (%)', SQLSTATE, SQLERRM;
  end;

  begin
    v_result := public.identity_admin_invite_member_atomic(
      'not-an-address', 'Bad Email', 'member', 'better-auth',
      'subject-bademail', 'scrypt$fake:hash');
    raise exception 'an address with no @ was accepted';
  exception
    when invalid_parameter_value then
      raise notice 'ok: a malformed email is refused (22023)';
    when others then
      raise exception 'expected 22023 for a malformed email, got % (%)', SQLSTATE, SQLERRM;
  end;

  begin
    v_result := public.identity_admin_invite_member_atomic(
      'badrole@example.test', 'Bad Role', 'superuser', 'better-auth',
      'subject-badrole', 'scrypt$fake:hash');
    raise exception 'an unknown role was accepted';
  exception
    when invalid_parameter_value then
      raise notice 'ok: a role other than member/admin is refused (22023)';
    when others then
      raise exception 'expected 22023 for a bad role, got % (%)', SQLSTATE, SQLERRM;
  end;

  -- 6. The duplicate-email refusal, case-insensitively, against a member who
  --    already exists.
  begin
    v_result := public.identity_admin_invite_member_atomic(
      'INVITED@example.test', 'Duplicate', 'member', 'better-auth',
      'subject-duplicate', 'scrypt$fake:hash');
    raise exception 'a duplicate email was accepted';
  exception
    when unique_violation then
      raise notice 'ok: a duplicate email is refused case-insensitively (23505)';
    when others then
      raise exception 'expected 23505 for a duplicate email, got % (%)',
        SQLSTATE, SQLERRM;
  end;

  raise notice 'atomic invite behaviour assertions passed';
end;
$$;

--
-- 7. The function must be the only way in. app_runtime holds nothing on the
--    identity schema, and step 005 must not have changed that: the INSERT grants
--    it adds go to app_owner, which is not a role any request runs as.
--
DO $$
begin
  begin
    execute 'select count(*) from identity."user"';
    raise exception 'app_runtime read the identity store user table';
  exception
    when insufficient_privilege then
      raise notice 'ok: app_runtime still cannot read identity."user"';
  end;

  begin
    execute 'insert into identity."user" ("id","name","email","emailVerified","updatedAt")
             values (''x'',''x'',''x@example.test'',false,now())';
    raise exception 'app_runtime wrote the identity store user table';
  exception
    when insufficient_privilege then
      raise notice 'ok: app_runtime still cannot write identity."user"';
  end;

  begin
    execute 'insert into identity."account" ("id","accountId","providerId","userId","updatedAt")
             values (''x'',''x'',''credential'',''x'',now())';
    raise exception 'app_runtime wrote the identity store account table';
  exception
    when insufficient_privilege then
      raise notice 'ok: app_runtime still cannot write identity."account"';
  end;

  -- The ACL of the grants step 005 adds is checked by the clean-room script, not
  -- here, and the reason is a finding rather than a preference: even
  -- has_table_privilege('app_owner', 'identity."user"', 'INSERT') fails for this
  -- principal with "permission denied for schema identity", because resolving the
  -- table *name* needs USAGE on the schema. app_runtime cannot so much as ask a
  -- question about those tables, which is a stronger statement of the isolation
  -- than the ACL check would have been -- and it is asserted right here, by the
  -- three refusals above, from the principal it matters for.
  raise notice 'ok: app_runtime cannot even name the identity tables to ask about them';
end;
$$;

RESET client_min_messages;
