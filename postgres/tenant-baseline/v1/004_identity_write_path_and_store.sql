-- Identity write path, actor resolver, roster read and identity store schema.
-- Apply after 003_functions_triggers_ai_guard.sql, through the migration ledger.
--
-- PREREQUISITE: 000_identity_store_role_bootstrap.sql must have been run by the
-- control plane against this database's cluster. The step checks for it below
-- and refuses to apply without it, so a missing prerequisite is a clear failure
-- rather than an obscure one. Nothing partial can land: the runner wraps the
-- whole step in one transaction with its own ledger row.
--
-- This step carries the four changes the owner attached to the G3 decision as
-- condition C3, all on the same tables and all reviewed together:
--
--   A. The identity write path. app_runtime holds INSERT/UPDATE/DELETE on the
--      business tables and on none of public.users, public.user_identities or
--      public.team_members. That is a table grant, not RLS, so no actor context
--      can unlock it -- measured, SQLSTATE 42501 on four attempts. Three
--      SECURITY DEFINER functions owned by app_owner give the admin endpoints a
--      write path that an ordinary member cannot reach, because each one refuses
--      a non-admin actor itself rather than relying on who holds the grant.
--
--   B. public.identity_resolve_actor(provider, subject). Chosen by the owner
--      over the account-side canonicalUserId proposal, which is NOT accepted and
--      does not appear in this artifact. Reviewed from the S16 draft rather than
--      copied; the differences are recorded in the handoff.
--
--   C. The Auth candidate's own schema: four tables in their own schema, owned by
--      their own role, with no grant to app_runtime in either direction. user.id
--      is text -- it is a provider subject belonging in
--      public.user_identities.provider_subject, and the type difference is what
--      keeps it from ever being joined to public.users.id.
--
--   D. The roster read. public.team_members is self-only under RLS, so any join
--      resolving an assignee or owner name returns NULL for everybody except the
--      caller. One SECURITY DEFINER read fixes that for the reads that need it.
--
-- Separation from the AI SQL guard. Every function below follows the ACL pattern
-- 003 established for exactly this reason: REVOKE ALL FROM PUBLIC, then EXECUTE
-- to app_runtime alone. app_ai_runner -- the role the guard executes as -- and
-- app_system -- the only role that may execute the guard -- receive no EXECUTE on
-- anything here. Generated SQL is confined to SELECT, and a SELECT that merely
-- calls one of these functions fails with insufficient_privilege before it can
-- become a write path. The guard itself is not touched and gains nothing.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'identity_store') THEN
        RAISE EXCEPTION
            'identity_store role is absent: run 000_identity_store_role_bootstrap.sql '
            'as the control plane before applying step 004'
            USING ERRCODE = '42501';
    END IF;
END
$$;

SET ROLE app_owner;

--
-- SECTION A -- THE IDENTITY WRITE PATH
--
-- Shape: SECURITY DEFINER functions owned by app_owner, EXECUTE granted to
-- app_runtime only, each gating itself on public.is_app_admin().
--
-- The alternative shape -- a distinct privileged login role used only by the
-- admin endpoints -- was rejected. It needs an eighth role in the seven-role
-- bootstrap whose digest is pinned in an append-only single-row ledger record
-- (see 000_identity_store_role_bootstrap.sql for why that record cannot be
-- rewritten), a second credential to distribute and rotate, and it would hold
-- blanket DML on the identity tables for the whole request path rather than
-- exposing three specific, validated operations. The functions here are narrower
-- and carry their own authorization.
--
-- What these three deliberately do NOT do:
--   * they do not touch the identity store's own tables, so an invite that must
--     also create a credential row is not atomic across both stores yet -- see
--     the handoff, which records that as the first thing S17 needs and why it
--     was not guessed at here;
--   * they do not revoke sessions. Disabling a member here does not end that
--     member's live session; the candidate owns session state and S17 owns the
--     revocation call (G3 condition C2);
--   * they do not delete anything. There is no member-deletion path: disable is
--     the sanctioned end state, and public.users rows are never removed;
--   * they do not read or write any business table.
--

--
-- Name: identity_admin_invite_member(text, text, text, text, text); Owner: app_owner
--
-- Creates the canonical half of a person: the users row, the team_members row
-- and the provider identity mapping, in one transaction. Returns the identifiers
-- the caller needs, as jsonb, so the shape can grow without a signature change.
--
CREATE FUNCTION public.identity_admin_invite_member(
    p_email text,
    p_name text,
    p_role text,
    p_provider text,
    p_provider_subject text
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

  -- The same advisory lock the baseline's admin_update_team_member takes, so the
  -- roster is serialised across every path that can change it, not just within
  -- this function.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('outreach_deck_active_admin_invariant')
  );

  -- team_members carries no unique constraint on email, and adding one to a
  -- table that already holds production rows is a data-dependent decision that
  -- does not belong in a schema step. The duplicate is refused here instead,
  -- case-insensitively, and only against members who still exist as members.
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

  return pg_catalog.jsonb_build_object(
    'user_id', v_user_id,
    'member_id', v_member_id,
    'email', v_email,
    'role', p_role,
    'active', true
  );
end;
$$;

--
-- Name: identity_admin_set_member_active(uuid, boolean); Owner: app_owner
--
-- Disable and re-enable. Both halves of "active" move together: a canonical user
-- that is inactive but whose membership is active, or the reverse, is a state the
-- policies treat inconsistently, so the write path never produces it.
--
CREATE FUNCTION public.identity_admin_set_member_active(
    p_user_id uuid,
    p_active boolean
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_member public.team_members;
  v_admin_count bigint;
begin
  if not public.is_app_admin() then
    raise exception 'only an active admin actor may change member activation'
      using errcode = '42501';
  end if;
  if p_user_id is null or p_active is null then
    raise exception 'user id and active flag are both required'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('outreach_deck_active_admin_invariant')
  );

  select * into v_member
  from public.team_members
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'unknown team member'
      using errcode = 'P0002';
  end if;

  -- The final-active-admin invariant, matching the baseline's
  -- admin_update_team_member: the workspace must never be left without one.
  if not p_active and v_member.active and v_member.role = 'admin' then
    select count(*) into v_admin_count
    from public.team_members
    where active and role = 'admin';

    if v_admin_count <= 1 then
      raise exception 'cannot deactivate the final active admin'
        using errcode = '23514';
    end if;
  end if;

  update public.users set active = p_active where id = p_user_id;
  update public.team_members set active = p_active where user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'user_id', p_user_id,
    'member_id', v_member.id,
    'active', p_active
  );
end;
$$;

--
-- Name: identity_admin_set_member_role(uuid, text); Owner: app_owner
--
-- Role change keyed by canonical user id. The baseline's admin_update_team_member
-- can already change a role, keyed by member id and with no authorization of its
-- own; it is immutable and stays exactly as it is. This function is the one the
-- admin endpoints should use: it is keyed the way the rest of the identity
-- surface is keyed, and it refuses a non-admin caller itself.
--
CREATE FUNCTION public.identity_admin_set_member_role(
    p_user_id uuid,
    p_role text
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_member public.team_members;
  v_admin_count bigint;
begin
  if not public.is_app_admin() then
    raise exception 'only an active admin actor may change a member role'
      using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'user id is required'
      using errcode = '22023';
  end if;
  if p_role not in ('member', 'admin') then
    raise exception 'role must be member or admin'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('outreach_deck_active_admin_invariant')
  );

  select * into v_member
  from public.team_members
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'unknown team member'
      using errcode = 'P0002';
  end if;

  if p_role <> 'admin' and v_member.active and v_member.role = 'admin' then
    select count(*) into v_admin_count
    from public.team_members
    where active and role = 'admin';

    if v_admin_count <= 1 then
      raise exception 'cannot demote the final active admin'
        using errcode = '23514';
    end if;
  end if;

  update public.team_members set role = p_role where user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'user_id', p_user_id,
    'member_id', v_member.id,
    'role', p_role
  );
end;
$$;

--
-- SECTION B -- THE ACTOR RESOLVER
--
-- Name: identity_resolve_actor(text, text); Owner: app_owner
--
-- public.user_identities is readable by app_runtime only through
-- user_identities_active_actor_select, which requires user_id = app.actor_id:
-- reading the mapping requires already knowing the answer. This function is the
-- way out the owner chose. It answers exactly one question -- which active
-- canonical actor owns this (provider, subject) pair -- and the caller must
-- already hold the subject, which only a verified session yields.
--
-- It is the ONE function in this artifact that is deliberately reachable with no
-- actor context, and it has to be: it is what establishes the actor. Everything
-- that follows in a request is gated on the actor it returns.
--
-- What it does not do. It is not an enumeration primitive: it takes no pattern,
-- returns no list, and an unknown subject, an inactive user and an inactive
-- membership are indistinguishable from each other -- all three return zero rows.
-- It exposes no email, no name and nothing about any other person. It cannot
-- write. Compared with the rejected proposal shape it lets a caller holding a
-- subject learn the canonical id rather than only test a pair, which is strictly
-- more exposure and is precisely why it was the owner's decision to take.
--
CREATE FUNCTION public.identity_resolve_actor(
    p_provider text,
    p_subject text
) RETURNS TABLE (actor_id uuid, role text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select ui.user_id, tm.role
    from public.user_identities ui
    join public.team_members tm on tm.user_id = ui.user_id
    join public.users u on u.id = ui.user_id
   where ui.provider = p_provider
     and ui.provider_subject = p_subject
     and tm.active
     and u.active;
$$;

--
-- SECTION C -- THE ROSTER READ (B4)
--
-- Name: team_roster(); Owner: app_owner
--
-- team_members_active_actor_select restricts app_runtime to its own row, so a
-- lead's assigned_to, a follow-up's owner_id and every other roster join resolve
-- to NULL for everyone but the caller. The dashboard has always shown the whole
-- roster to every signed-in member -- today's client reads
-- id,name,active,created_at,email,role for all members -- so this function is
-- what keeps that behaviour available once reads go through the server-owned API.
--
-- The gate is membership, not admin: an ordinary member needs the roster to see
-- who owns a conversation. With no actor, a malformed actor, an unknown actor or
-- an inactive one it returns zero rows, because is_active_team_member() is false.
--
-- What it does not expose: nothing from public.users beyond the id already in
-- team_members.user_id, no provider subject, no identity-store row, no password
-- material, and no ability to write. It is the same seven columns for every
-- caller; there is no admin-only projection here.
--
CREATE FUNCTION public.team_roster() RETURNS TABLE (
    id bigint,
    user_id uuid,
    name text,
    email text,
    role text,
    active boolean,
    created_at timestamp with time zone
)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select tm.id, tm.user_id, tm.name, tm.email, tm.role, tm.active, tm.created_at
    from public.team_members tm
   where public.is_active_team_member();
$$;

--
-- Function ACLs. The pattern is 003's, unchanged: PUBLIC executes nothing, and
-- the server-owned runtime principal is the only grantee. app_readonly is left
-- out on purpose -- nothing reads through it yet, and the roster read can be
-- granted to it by a later step if something does. app_ai_runner and app_system
-- appear nowhere below, which is what keeps the AI surface and the write surface
-- separate.
--
REVOKE ALL ON FUNCTION public.identity_admin_invite_member(p_email text, p_name text, p_role text, p_provider text, p_provider_subject text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.identity_admin_set_member_active(p_user_id uuid, p_active boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.identity_admin_set_member_role(p_user_id uuid, p_role text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.identity_resolve_actor(p_provider text, p_subject text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.team_roster() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.identity_admin_invite_member(p_email text, p_name text, p_role text, p_provider text, p_provider_subject text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.identity_admin_set_member_active(p_user_id uuid, p_active boolean) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.identity_admin_set_member_role(p_user_id uuid, p_role text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.identity_resolve_actor(p_provider text, p_subject text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.team_roster() TO app_runtime;

--
-- SECTION D -- THE IDENTITY STORE SCHEMA
--
-- The accepted candidate's own four tables, in their own schema, owned by their
-- own role. The DDL is the candidate's generated output, verbatim except for two
-- deliberate differences, both recorded in the handoff:
--
--   * the schema is named identity, not the spike's throwaway name;
--   * the canonicalUserId column is absent. It belonged to the proposal shape the
--     owner did not accept; the resolver in section B replaces it, and leaving
--     the column in place would leave a second, writable copy of the canonical id
--     that nothing keeps correct.
--
-- The store is subordinate to the canonical tables and stays that way:
--
--   * user.id is text. It is a provider subject and belongs in
--     public.user_identities.provider_subject. It is never joined to
--     public.users.id, and the type difference means such a join cannot be
--     written by accident.
--   * there is no foreign key in either direction between this schema and public.
--     A cross-store reference would make one store unable to be restored without
--     the other.
--   * the email address is the one genuine duplication between the two stores.
--     Keeping the two copies equal is the invite transaction's job, not a
--     constraint's -- they live in different schemas with different owners.
--
-- Privileges: nothing to PUBLIC, nothing to app_runtime, app_readonly,
-- app_machine, app_system or app_ai_runner, in either direction. The store role
-- receives no USAGE on public and no grant on any business table, so it cannot
-- read the workspace it authenticates people into. account.password holds the
-- candidate's password hash and no role in the product can read it.
--
-- No RLS. Every row in this schema belongs to the tenant that owns the database,
-- the only principal with any privilege here is the store's own role, and a
-- policy evaluated for a table's owner does nothing. Tenant isolation in this
-- model is the database boundary, not a policy.
--
-- The schema is created directly OWNED BY the store role, and the tables are
-- created by that role rather than handed over afterwards. This is not a style
-- preference; the alternatives do not work, and both failures were measured in
-- the clean room:
--
--   * ALTER TABLE ... OWNER TO identity_store fails with "permission denied for
--     schema identity", because since PostgreSQL 16 the incoming owner must hold
--     CREATE on the schema, and the store holds nothing on a schema app_owner
--     owns. Granting it CREATE first works but leaves a pointless ACL entry on a
--     schema the role ends up owning outright.
--   * transferring the schema first and the tables second fails the same way in
--     the other direction: once the schema belongs to identity_store, app_owner
--     has no USAGE on it and cannot alter anything inside it, including its own
--     tables and its own COMMENT.
--
-- app_owner may do this because the control-plane prerequisite granted it
-- membership in identity_store. The membership is WITH INHERIT FALSE, so this
-- explicit SET ROLE is the only way those privileges are ever used.
CREATE SCHEMA identity AUTHORIZATION identity_store;

SET ROLE identity_store;

COMMENT ON SCHEMA identity IS
    'Identity provider store. Subordinate to public.users/public.user_identities: its user.id is a provider subject, never a canonical user id.';

CREATE TABLE identity."user" (
    "id" text NOT NULL PRIMARY KEY,
    "name" text NOT NULL,
    "email" text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL,
    "image" text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "role" text,
    "banned" boolean,
    "banReason" text,
    "banExpires" timestamp with time zone
);

CREATE TABLE identity."session" (
    "id" text NOT NULL PRIMARY KEY,
    "expiresAt" timestamp with time zone NOT NULL,
    "token" text NOT NULL UNIQUE,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL REFERENCES identity."user" ("id") ON DELETE CASCADE,
    "impersonatedBy" text
);

CREATE TABLE identity."account" (
    "id" text NOT NULL PRIMARY KEY,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES identity."user" ("id") ON DELETE CASCADE,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    "scope" text,
    "password" text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE identity."verification" (
    "id" text NOT NULL PRIMARY KEY,
    "identifier" text NOT NULL,
    "value" text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX "session_userId_idx" ON identity."session" ("userId");
CREATE INDEX "account_userId_idx" ON identity."account" ("userId");
CREATE INDEX "verification_identifier_idx" ON identity."verification" ("identifier");

-- Belt and braces: a non-public schema grants nothing to PUBLIC on creation in
-- any supported PostgreSQL version, and nothing above grants anything either.
-- The revokes are run by the store role, because it is the owner and app_owner is
-- no longer permitted to revoke on a schema it does not own. Both facts are
-- asserted, not assumed.
REVOKE ALL ON SCHEMA identity FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA identity FROM PUBLIC;

-- The one deliberate exception to "nothing outside the store reaches the store":
-- the backup principal can read it.
--
-- This is not a softening of the isolation and it was not a preference. It was
-- measured: without it, `pg_dump --role=app_owner` -- the documented, tested
-- procedure, run as the non-superuser app_migration login -- fails outright with
--
--     pg_dump: error: query failed: ERROR: permission denied for schema identity
--     detail: Query was: LOCK TABLE ... identity."user", identity.session, ... 
--
-- and the tenant becomes impossible to back up as a whole. A schema that cannot
-- be dumped cannot be restored, which would defeat the entire point of routing
-- this through the ledger.
--
-- It confers no authority app_owner did not already hold. The control-plane
-- prerequisite makes app_owner a member of identity_store, so it can already
-- reach every one of these tables with an explicit SET ROLE. The grant only
-- removes the need for one, which pg_dump has no way to issue. SELECT and USAGE
-- only: the backup principal reads, and even that read is asserted to be absent
-- for every request-path, AI, machine and read-only role.
--
-- These grants are issued BY identity_store, the owner. That matters on restore:
-- pg_restore replays a GRANT as app_owner, which is not the owner, so the
-- statement would emit a warning and silently do nothing -- the same trap the AI
-- guard's restore window exists for. restore_window_open.sql therefore lets
-- app_owner act as identity_store for the duration of a restore, and
-- restore_window_close.sql asserts these grants came back.
GRANT USAGE ON SCHEMA identity TO app_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA identity TO app_owner;

-- Back to the applying role, so the step ends as it began and the runner records
-- its ledger row as app_migration/app_owner.
SET ROLE app_owner;

RESET ROLE;
