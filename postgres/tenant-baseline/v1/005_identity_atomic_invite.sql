--
-- 005_identity_atomic_invite.sql -- the atomic cross-store invite.
--
-- Session: S17. Applied through postgres/tools/portable_migration_ledger.mjs as
-- step 5. Additive: it creates one function and one set of grants, and alters
-- nothing that already exists.
--
-- WHY THIS STEP EXISTS
--
-- Step 004 gave the identity write path three functions, and its own handoff
-- recorded the gap they leave: an invite is not atomic across both stores. Those
-- functions write only the canonical tables -- public.users, public.team_members,
-- public.user_identities -- because app_runtime deliberately cannot write the
-- identity schema, and identity_store deliberately cannot read public. So the
-- store-side account had to be a second write, in a second transaction, by a
-- second principal.
--
-- That shape has one failure mode and it is not hypothetical: the canonical half
-- commits, the store half fails, and a person now exists on the roster and cannot
-- sign in. The compensating delete that would clean it up can itself fail, and
-- then nothing is consistent and nothing is retryable. F8 argued against exactly
-- this and named the alternative -- "invite and disable are one SQL transaction
-- across both stores, and there is no compensating write and no reconciliation
-- job". This is that transaction.
--
-- WHY IT NEEDS NO NEW ROLE AND NO NEW CREDENTIAL
--
-- The control-plane prerequisite step 004 already required grants app_owner
-- membership of identity_store WITH INHERIT FALSE. So app_owner can already reach
-- every table in the identity schema with an explicit SET ROLE, and step 004
-- already granted it USAGE on the schema and SELECT on the four tables so that
-- pg_dump works. This step adds INSERT on the two tables an invite writes, issued
-- by identity_store as their owner, and one SECURITY DEFINER function owned by
-- app_owner that performs both halves.
--
-- No eighth role. No second credential to distribute or rotate. Nothing is added
-- to 000_control_plane_role_bootstrap.sql, whose digest is recorded in the
-- single-row, append-only app_ledger.role_bootstrap and must never change.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
--   * it does not grant app_runtime anything on the identity schema. The runtime
--     role still cannot read or write the store; it can only EXECUTE this
--     function, which validates every argument and authorizes itself;
--   * it does not grant UPDATE or DELETE on the identity tables to anyone. An
--     invite inserts. Disabling a member is not a delete, and revoking a session
--     is the identity service's own connection, not this path;
--   * it does not hash a password. The hash arrives already computed by the
--     identity provider, because inventing password handling in SQL is exactly
--     the authorship this project declined when it accepted a reviewed library;
--   * it does not send email;
--   * it grants app_ai_runner and app_system nothing, so the AI SQL guard cannot
--     reach it. Asserted from inside the sandbox by
--     postgres/tests/portable_identity_write_path_ai_boundary_assertions.sql.
--
-- PREREQUISITES, CHECKED IN SQL RATHER THAN ASSUMED
--
-- Step 004 must have been applied, and the identity_store role must exist. Both
-- are checked below and both raise rather than proceeding, for the same reason
-- step 004 checks its own prerequisite: a partially applied step is the one thing
-- an append-only ledger cannot express.
--

SET client_min_messages TO warning;

DO $prereq$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'identity_store') then
    raise exception
      'role identity_store is absent: apply the control-plane prerequisite 000_identity_store_role_bootstrap.sql first'
      using errcode = '42704';
  end if;

  if pg_catalog.to_regnamespace('identity') is null then
    raise exception
      'schema identity is absent: apply ledger step 004_identity_write_path_and_store.sql first'
      using errcode = '42704';
  end if;

  if pg_catalog.to_regprocedure('public.identity_admin_invite_member(text,text,text,text,text)') is null then
    raise exception
      'public.identity_admin_invite_member is absent: apply ledger step 004 first'
      using errcode = '42883';
  end if;

  -- The membership the function relies on to reach the store. Without SET
  -- privilege the function body cannot switch into the owner of the identity
  -- tables, and the failure would otherwise surface at call time rather than
  -- apply time.
  if not pg_catalog.pg_has_role('app_owner', 'identity_store', 'SET') then
    raise exception
      'app_owner cannot SET ROLE identity_store: the control-plane prerequisite did not grant the membership'
      using errcode = '42501';
  end if;
end;
$prereq$;

--
-- The INSERT grants, issued BY the owner of the tables.
--
-- Note the ordering requirement this file inherits from step 004's findings: a
-- grant on an object may only be issued by its owner (or a superuser), and
-- app_owner does not own these tables. So the grants are made under SET ROLE
-- identity_store, then the role is dropped back to app_owner so the step ends as
-- it began and the runner records app_migration/app_owner.
--
SET ROLE identity_store;

GRANT INSERT ON identity."user" TO app_owner;
GRANT INSERT ON identity."account" TO app_owner;

SET ROLE app_owner;

--
-- Name: identity_admin_invite_member_atomic(text, text, text, text, text, text); Owner: app_owner
--
-- Creates a whole person -- canonical rows and store-side account -- in one
-- transaction. Either every row exists or none does.
--
-- The parameter list is the candidate's column set, and that coupling is
-- deliberate and bounded: p_provider_subject IS identity."user"."id", and
-- p_password_hash is whatever format the provider's own hashing produces. This
-- function stores both and interprets neither. Replacing the identity provider
-- changes what those two strings contain and does not change this signature.
--
CREATE FUNCTION public.identity_admin_invite_member_atomic(
    p_email text,
    p_name text,
    p_role text,
    p_provider text,
    p_provider_subject text,
    p_password_hash text
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_email text := btrim(p_email);
  v_name text := btrim(p_name);
  v_provider text := btrim(p_provider);
  v_subject text := btrim(p_provider_subject);
  v_user_id uuid;
  v_member_id bigint;
begin
  -- Authorization first, and it is the same gate the other three use: the
  -- caller's actor must be an active admin. An admin and an ordinary member
  -- arrive on the same app_runtime connection with the same EXECUTE grant, so
  -- this check -- not the grant -- is the control.
  if not public.is_app_admin() then
    raise exception 'only an active admin actor may invite a member'
      using errcode = '42501';
  end if;

  if v_name is null or length(v_name) = 0 or length(v_name) > 100 then
    raise exception 'name must be between 1 and 100 characters'
      using errcode = '22023';
  end if;
  if p_role not in ('member', 'admin') then
    raise exception 'role must be member or admin'
      using errcode = '22023';
  end if;
  if v_email is null or length(v_email) = 0 or length(v_email) > 320
     or position('@' in v_email) < 2 then
    raise exception 'email must be a non-empty address of at most 320 characters'
      using errcode = '22023';
  end if;
  if v_provider is null or length(v_provider) = 0 or length(v_provider) > 80 then
    raise exception 'provider must be between 1 and 80 characters'
      using errcode = '22023';
  end if;
  if v_subject is null or length(v_subject) = 0 or length(v_subject) > 512 then
    raise exception 'provider subject must be between 1 and 512 characters'
      using errcode = '22023';
  end if;
  -- A credential, so it is checked for presence and never inspected, compared,
  -- logged or returned. The length ceiling is a sanity bound, not a format claim:
  -- this function must not encode an assumption about the provider's hash format.
  if p_password_hash is null or length(p_password_hash) = 0
     or length(p_password_hash) > 1024 then
    raise exception 'password hash must be a non-empty value of at most 1024 characters'
      using errcode = '22023';
  end if;

  -- The same advisory lock every other roster-changing path takes, so the
  -- final-active-admin invariant is serialised across all of them rather than
  -- within each.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('outreach_deck_active_admin_invariant')
  );

  -- team_members carries no unique constraint on email; the duplicate is refused
  -- here, case-insensitively, exactly as step 004's invite does.
  if exists (
    select 1
    from public.team_members tm
    where tm.email is not null
      and lower(btrim(tm.email)) = lower(v_email)
  ) then
    raise exception 'a team member with this email already exists'
      using errcode = '23505';
  end if;

  insert into public.users (active) values (true)
  returning id into v_user_id;

  insert into public.team_members (name, active, email, role, user_id)
  values (v_name, true, v_email, p_role, v_user_id)
  returning id into v_member_id;

  insert into public.user_identities (user_id, provider, provider_subject)
  values (v_user_id, v_provider, v_subject);

  -- The store half, written as app_owner through the INSERT grants above rather
  -- than by switching role.
  --
  -- SET ROLE was the first shape tried and it does not work here: inside a
  -- SECURITY DEFINER function the role switch is authorized against the
  -- *session* user, which on this path is app_runtime, and app_runtime is not a
  -- member of identity_store. SECURITY DEFINER changes current_user, not
  -- session_user. So the function holds the two INSERT privileges directly, which
  -- is also the narrower grant: INSERT on two tables rather than the ability to
  -- become their owner.
  --
  -- Both inserts are in the same transaction as the three above, which is the
  -- entire point of the step: a failure here -- a duplicate email in the store, a
  -- subject collision, a constraint the candidate added in a later version --
  -- takes the canonical rows with it and leaves no half-person.
  insert into identity."user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
  values (v_subject, v_name, v_email, false, pg_catalog.now(), pg_catalog.now());

  insert into identity."account"
    ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
  values (
    pg_catalog.gen_random_uuid()::text,
    v_subject,
    -- The candidate's own label for an email/password account. A row with any
    -- other providerId would not be found by its credential sign-in path.
    'credential',
    v_subject,
    p_password_hash,
    pg_catalog.now(),
    pg_catalog.now()
  );

  -- provider_subject is returned because the caller needs it to revoke that
  -- person's sessions later, and it must come from here rather than from the
  -- caller's own request. It is the store's internal id and carries no secret.
  return pg_catalog.jsonb_build_object(
    'user_id', v_user_id,
    'member_id', v_member_id,
    'email', v_email,
    'role', p_role,
    'active', true,
    'provider_subject', v_subject
  );
end;
$$;

--
-- Function ACL. 003's pattern, unchanged: PUBLIC executes nothing and the
-- server-owned runtime principal is the only grantee. app_ai_runner and
-- app_system appear nowhere, which is what keeps the AI surface away from the
-- write surface.
--
REVOKE ALL ON FUNCTION public.identity_admin_invite_member_atomic(p_email text, p_name text, p_role text, p_provider text, p_provider_subject text, p_password_hash text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.identity_admin_invite_member_atomic(p_email text, p_name text, p_role text, p_provider text, p_provider_subject text, p_password_hash text) TO app_runtime;

COMMENT ON FUNCTION public.identity_admin_invite_member_atomic(p_email text, p_name text, p_role text, p_provider text, p_provider_subject text, p_password_hash text) IS
    'Creates the canonical rows and the identity-store account for one member in a single transaction. Admin-only, gated on public.is_app_admin(). Stores a provider-computed password hash without interpreting it.';

RESET client_min_messages;
