-- Tenant schema baseline v053.
--
-- Source revision: 5adb6f6c7127b1be6da0c6edf6e31c90cf9199c9
-- Historical catalog: migrations 001-053
-- Historical catalog digest:
--   sha256:3acf60b2abc36eb9e701c0e92256ac32596986ee284df77117dcd0310227ff4b
--
-- This artifact is immutable after publication. It materializes the final
-- schema state at cutover 053 without replaying historical data repairs,
-- internal cleanup, or internal seed data. It assumes the Supabase-managed
-- public, auth, storage, and supabase_migrations schemas and provider roles
-- already exist.

create extension if not exists pgcrypto;

do $baseline_role$
begin
  if not exists (select 1 from pg_roles where rolname = 'ai_sql_runner') then
    create role ai_sql_runner nologin;
  end if;
end
$baseline_role$;

do $baseline_membership$
begin
  execute format('grant ai_sql_runner to %I', current_user);
exception when others then
  null;
end
$baseline_membership$;

-- PostgreSQL requires the future owner to have CREATE on the containing schema
-- during an ownership transfer. Revoke it immediately after ai_execute_sql.
grant usage, create on schema public to ai_sql_runner;

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg13+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: team_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.team_members (
    id bigint NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_user_id uuid,
    email text,
    role text DEFAULT 'member'::text NOT NULL,
    CONSTRAINT team_members_role_check CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))
);


ALTER TABLE public.team_members OWNER TO postgres;

--
-- Name: admin_update_team_member(bigint, text, text, boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.admin_update_team_member(p_member_id bigint, p_name text, p_role text, p_active boolean) RETURNS public.team_members
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_current public.team_members;
  v_result public.team_members;
  v_admin_count bigint;
begin
  if p_name is null or length(btrim(p_name)) = 0 or length(btrim(p_name)) > 100 then
    raise exception 'name must be between 1 and 100 characters'
      using errcode = '22023';
  end if;
  if p_role not in ('member', 'admin') then
    raise exception 'role must be member or admin'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('outreach_deck_active_admin_invariant')
  );

  select *
  into v_current
  from public.team_members
  where id = p_member_id
  for update;

  if not found then
    raise exception 'unknown team member'
      using errcode = 'P0002';
  end if;

  if v_current.active
     and v_current.role = 'admin'
     and v_current.auth_user_id is not null
     and (not p_active or p_role <> 'admin') then
    select count(*)
    into v_admin_count
    from public.team_members
    where active
      and role = 'admin'
      and auth_user_id is not null;

    if v_admin_count <= 1 then
      raise exception 'cannot deactivate or demote the final active admin'
        using errcode = '23514';
    end if;
  end if;

  update public.team_members
  set name = btrim(p_name),
      role = p_role,
      active = p_active
  where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$$;


ALTER FUNCTION public.admin_update_team_member(p_member_id bigint, p_name text, p_role text, p_active boolean) OWNER TO postgres;

--
-- Name: ai_execute_sql(text); Type: FUNCTION; Schema: public; Owner: ai_sql_runner
--

CREATE FUNCTION public.ai_execute_sql(query text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  result jsonb;
begin
  query := regexp_replace(query, '[;\s]+$', '');

  if query !~* '^\s*(select|with)\y' then
    raise exception 'Only SELECT / WITH queries are allowed';
  end if;

  perform set_config('statement_timeout', '10000', true);

  -- No `set local role` here: this function is owned by ai_sql_runner (SELECT only)
  -- and runs SECURITY DEFINER, so it already executes with least privilege AND in a
  -- security-restricted context that blocks SET ROLE / set_config('role', ...).
  --
  -- The inner `limit 1000` bounds how many rows jsonb_agg can materialize, so a
  -- query that plans cheap but returns enormous output can't OOM the backend ahead
  -- of the statement_timeout. A `with`/CTE query is valid as the (%s) subquery.
  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) sub limit 1000) t',
    query)
    into result;

  return result;
end;
$_$;


ALTER FUNCTION public.ai_execute_sql(query text) OWNER TO ai_sql_runner;
revoke create on schema public from ai_sql_runner;

--
-- Name: apply_follow_up_action(text, text, text, text, bigint, uuid, bigint, date, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.apply_follow_up_action(p_action text, p_instance_id text, p_profile_url text, p_actor text, p_expected_revision bigint, p_mutation_id uuid, p_owner_id bigint DEFAULT NULL::bigint, p_next_follow_up_date date DEFAULT NULL::date, p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_state conversation_follow_up_state%rowtype;
  v_existing follow_up_events%rowtype;
  v_expected_kind text;
  v_fingerprint text;
  v_actor text := btrim(coalesce(p_actor, ''));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_today date := (now() at time zone 'Europe/Madrid')::date;
  v_new_revision bigint;
  v_previous_owner_name text;
  v_new_owner_name text;
  v_event_id bigint;
  v_events jsonb;
begin
  if p_action not in ('schedule', 'reschedule', 'reassign', 'complete', 'skip', 'cancel') then
    raise exception using errcode = '22023', message = 'unknown follow-up action';
  end if;
  if p_instance_id is null or btrim(p_instance_id) = ''
     or p_profile_url is null or btrim(p_profile_url) = '' then
    raise exception using errcode = '22023', message = 'instance_id and profile_url are required';
  end if;
  if char_length(v_actor) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'actor must be 1-120 characters';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'expected_revision must be a non-negative integer';
  end if;
  if p_mutation_id is null then
    raise exception using errcode = '22023', message = 'mutation_id is required';
  end if;
  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception using errcode = '22023', message = 'reason must be at most 1000 characters';
  end if;

  v_expected_kind := case p_action
    when 'schedule' then 'scheduled'
    when 'reschedule' then 'rescheduled'
    when 'reassign' then 'reassigned'
    when 'complete' then 'completed'
    when 'skip' then 'skipped'
    when 'cancel' then 'canceled'
  end;
  v_fingerprint := md5(jsonb_build_object(
    'action', p_action,
    'instance_id', p_instance_id,
    'profile_url', p_profile_url,
    'actor', v_actor,
    'expected_revision', p_expected_revision,
    'owner_id', p_owner_id,
    'next_follow_up_date', p_next_follow_up_date,
    'reason', v_reason
  )::text);

  perform pg_advisory_xact_lock(
    hashtextextended(jsonb_build_array(p_instance_id, p_profile_url)::text, 0)
  );

  -- Idempotent retry after a response was lost. Every mutation has ordinal 1,
  -- so (mutation_id, ordinal) also prevents cross-conversation UUID reuse.
  select *
    into v_existing
  from follow_up_events
  where mutation_id = p_mutation_id
  order by event_ordinal
  limit 1;
  if found then
    if v_existing.instance_id <> p_instance_id
       or v_existing.profile_url <> p_profile_url
       or v_existing.event_kind <> v_expected_kind
       or v_existing.request_fingerprint <> v_fingerprint then
      raise exception using errcode = '40001', message = 'FOLLOW_UP_CONFLICT: mutation_id was already used with different inputs';
    end if;
    select * into v_state
    from conversation_follow_up_state
    where instance_id = p_instance_id and profile_url = p_profile_url;
    select coalesce(jsonb_agg(to_jsonb(e) order by e.event_ordinal), '[]'::jsonb)
      into v_events
    from follow_up_events e
    where e.mutation_id = p_mutation_id;
    return jsonb_build_object(
      'state', to_jsonb(v_state),
      'events', v_events,
      'replayed', true,
      'mutation_revision', v_existing.state_revision
    );
  end if;

  if not exists (
    select 1 from leads
    where instance_id = p_instance_id and profile_url = p_profile_url
  ) then
    raise exception using errcode = 'P0002', message = 'unknown conversation';
  end if;

  insert into conversation_follow_up_state (
    instance_id, profile_url, revision, updated_by
  )
  values (p_instance_id, p_profile_url, 0, v_actor)
  on conflict (instance_id, profile_url) do nothing;

  select *
    into v_state
  from conversation_follow_up_state
  where instance_id = p_instance_id and profile_url = p_profile_url
  for update;

  if v_state.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'FOLLOW_UP_CONFLICT: stale revision';
  end if;

  if v_state.owner_id is not null then
    select name into v_previous_owner_name
    from team_members where id = v_state.owner_id;
  end if;

  if p_owner_id is not null then
    select name into v_new_owner_name
    from team_members
    where id = p_owner_id and active = true;
    if not found then
      raise exception using errcode = '22023', message = 'owner_id must reference an active team member';
    end if;
  end if;

  v_new_revision := v_state.revision + 1;

  if p_action = 'schedule' then
    if v_state.next_follow_up_date is not null and v_state.archived_at is null then
      raise exception using errcode = '40001', message = 'FOLLOW_UP_CONFLICT: conversation already has an active follow-up';
    end if;
    if p_owner_id is null or p_next_follow_up_date is null then
      raise exception using errcode = '22023', message = 'owner_id and next_follow_up_date are required';
    end if;
    if p_next_follow_up_date < v_today then
      raise exception using errcode = '22023', message = 'next_follow_up_date cannot be in the past';
    end if;

    insert into follow_up_events (
      instance_id, profile_url, mutation_id, event_ordinal, request_fingerprint,
      event_kind, previous_due_date, new_due_date,
      previous_owner_id, new_owner_id, previous_owner_name, new_owner_name,
      state_revision, actor, reason
    ) values (
      p_instance_id, p_profile_url, p_mutation_id, 1, v_fingerprint,
      'scheduled', null, p_next_follow_up_date,
      v_state.owner_id, p_owner_id, v_previous_owner_name, v_new_owner_name,
      v_new_revision, v_actor, null
    ) returning id into v_event_id;

    update conversation_follow_up_state set
      next_follow_up_date = p_next_follow_up_date,
      owner_id = p_owner_id,
      revision = v_new_revision,
      last_event_id = v_event_id,
      last_mutation_id = p_mutation_id,
      updated_at = now(),
      updated_by = v_actor,
      archived_at = null
    where instance_id = p_instance_id and profile_url = p_profile_url
    returning * into v_state;

  elsif p_action = 'reschedule' then
    if v_state.next_follow_up_date is null or v_state.archived_at is not null then
      raise exception using errcode = '40001', message = 'FOLLOW_UP_CONFLICT: no active follow-up to reschedule';
    end if;
    if v_state.owner_id is null then
      raise exception using errcode = '40001', message = 'FOLLOW_UP_CONFLICT: assign an owner before rescheduling';
    end if;
    if p_owner_id is not null and p_owner_id <> v_state.owner_id then
      raise exception using errcode = '40001', message = 'FOLLOW_UP_CONFLICT: use reassign_follow_up to change owner';
    end if;
    if p_next_follow_up_date is null then
      raise exception using errcode = '22023', message = 'next_follow_up_date is required';
    end if;
    if p_next_follow_up_date < v_today then
      raise exception using errcode = '22023', message = 'next_follow_up_date cannot be in the past';
    end if;
    if p_next_follow_up_date = v_state.next_follow_up_date then
      raise exception using errcode = '40001', message = 'FOLLOW_UP_CONFLICT: follow-up is already scheduled for that date';
    end if;

    insert into follow_up_events (
      instance_id, profile_url, mutation_id, event_ordinal, request_fingerprint,
      event_kind, previous_due_date, new_due_date,
      previous_owner_id, new_owner_id, previous_owner_name, new_owner_name,
      state_revision, actor, reason
    ) values (
      p_instance_id, p_profile_url, p_mutation_id, 1, v_fingerprint,
      'rescheduled', v_state.next_follow_up_date, p_next_follow_up_date,
      v_state.owner_id, v_state.owner_id, v_previous_owner_name, v_previous_owner_name,
      v_new_revision, v_actor, null
    ) returning id into v_event_id;

    update conversation_follow_up_state set
      next_follow_up_date = p_next_follow_up_date,
      revision = v_new_revision,
      last_event_id = v_event_id,
      last_mutation_id = p_mutation_id,
      updated_at = now(),
      updated_by = v_actor
    where instance_id = p_instance_id and profile_url = p_profile_url
    returning * into v_state;

  elsif p_action = 'reassign' then
    if v_state.next_follow_up_date is null or v_state.archived_at is not null then
      raise exception using errcode = '40001', message = 'FOLLOW_UP_CONFLICT: no active follow-up to reassign';
    end if;
    if p_owner_id is null then
      raise exception using errcode = '22023', message = 'owner_id is required';
    end if;
    if p_owner_id is not distinct from v_state.owner_id then
      raise exception using errcode = '40001', message = 'FOLLOW_UP_CONFLICT: follow-up already has that owner';
    end if;

    insert into follow_up_events (
      instance_id, profile_url, mutation_id, event_ordinal, request_fingerprint,
      event_kind, previous_due_date, new_due_date,
      previous_owner_id, new_owner_id, previous_owner_name, new_owner_name,
      state_revision, actor, reason
    ) values (
      p_instance_id, p_profile_url, p_mutation_id, 1, v_fingerprint,
      'reassigned', v_state.next_follow_up_date, v_state.next_follow_up_date,
      v_state.owner_id, p_owner_id, v_previous_owner_name, v_new_owner_name,
      v_new_revision, v_actor, null
    ) returning id into v_event_id;

    update conversation_follow_up_state set
      owner_id = p_owner_id,
      revision = v_new_revision,
      last_event_id = v_event_id,
      last_mutation_id = p_mutation_id,
      updated_at = now(),
      updated_by = v_actor
    where instance_id = p_instance_id and profile_url = p_profile_url
    returning * into v_state;

  else
    -- complete / skip / cancel
    if v_state.next_follow_up_date is null or v_state.archived_at is not null then
      raise exception using errcode = '40001', message = 'FOLLOW_UP_CONFLICT: no active follow-up';
    end if;
    if p_action = 'skip' and v_reason is null then
      raise exception using errcode = '22023', message = 'reason is required when skipping';
    end if;
    if p_action = 'cancel' and (p_owner_id is not null or p_next_follow_up_date is not null) then
      raise exception using errcode = '22023', message = 'cancel does not accept a next owner/date';
    end if;
    if p_action in ('complete', 'skip') then
      if (p_owner_id is null) <> (p_next_follow_up_date is null) then
        raise exception using errcode = '22023', message = 'next owner and date must be supplied together';
      end if;
      if p_next_follow_up_date is not null and p_next_follow_up_date <= v_today then
        raise exception using errcode = '22023', message = 'the next follow-up after an outcome must be after today';
      end if;
    end if;

    insert into follow_up_events (
      instance_id, profile_url, mutation_id, event_ordinal, request_fingerprint,
      event_kind, previous_due_date, new_due_date,
      previous_owner_id, new_owner_id, previous_owner_name, new_owner_name,
      state_revision, actor, reason
    ) values (
      p_instance_id, p_profile_url, p_mutation_id, 1, v_fingerprint,
      v_expected_kind, v_state.next_follow_up_date, null,
      v_state.owner_id, null, v_previous_owner_name, null,
      v_new_revision, v_actor, case when p_action in ('skip', 'cancel') then v_reason else null end
    ) returning id into v_event_id;

    if p_next_follow_up_date is not null then
      insert into follow_up_events (
        instance_id, profile_url, mutation_id, event_ordinal, request_fingerprint,
        event_kind, previous_due_date, new_due_date,
        previous_owner_id, new_owner_id, previous_owner_name, new_owner_name,
        state_revision, actor, reason
      ) values (
        p_instance_id, p_profile_url, p_mutation_id, 2, v_fingerprint,
        'scheduled', null, p_next_follow_up_date,
        v_state.owner_id, p_owner_id, v_previous_owner_name, v_new_owner_name,
        v_new_revision, v_actor, null
      ) returning id into v_event_id;
    end if;

    update conversation_follow_up_state set
      next_follow_up_date = p_next_follow_up_date,
      owner_id = case when p_next_follow_up_date is null then v_state.owner_id else p_owner_id end,
      revision = v_new_revision,
      last_event_id = v_event_id,
      last_mutation_id = p_mutation_id,
      updated_at = now(),
      updated_by = v_actor
    where instance_id = p_instance_id and profile_url = p_profile_url
    returning * into v_state;
  end if;

  select coalesce(jsonb_agg(to_jsonb(e) order by e.event_ordinal), '[]'::jsonb)
    into v_events
  from follow_up_events e
  where e.mutation_id = p_mutation_id;

  return jsonb_build_object(
    'state', to_jsonb(v_state),
    'events', v_events,
    'replayed', false,
    'mutation_revision', v_new_revision
  );
end;
$$;


ALTER FUNCTION public.apply_follow_up_action(p_action text, p_instance_id text, p_profile_url text, p_actor text, p_expected_revision bigint, p_mutation_id uuid, p_owner_id bigint, p_next_follow_up_date date, p_reason text) OWNER TO postgres;

--
-- Name: archive_follow_up_after_last_lead(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.archive_follow_up_after_last_lead() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_state conversation_follow_up_state%rowtype;
  v_owner_name text;
  v_mutation_id uuid := gen_random_uuid();
  v_fingerprint text;
  v_event_id bigint;
  v_new_revision bigint;
begin
  if exists (
    select 1 from leads
    where instance_id = old.instance_id and profile_url = old.profile_url
  ) then
    return old;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(jsonb_build_array(old.instance_id, old.profile_url)::text, 0)
  );

  -- Recheck after locking in case a matching row was inserted concurrently.
  if exists (
    select 1 from leads
    where instance_id = old.instance_id and profile_url = old.profile_url
  ) then
    return old;
  end if;

  select * into v_state
  from conversation_follow_up_state
  where instance_id = old.instance_id and profile_url = old.profile_url
  for update;
  if not found then return old; end if;

  if v_state.owner_id is not null then
    select name into v_owner_name from team_members where id = v_state.owner_id;
  end if;

  if v_state.next_follow_up_date is not null and v_state.archived_at is null then
    v_new_revision := v_state.revision + 1;
    v_fingerprint := md5(jsonb_build_object(
      'action', 'cancel',
      'instance_id', old.instance_id,
      'profile_url', old.profile_url,
      'actor', 'system',
      'expected_revision', v_state.revision,
      'owner_id', null,
      'next_follow_up_date', null,
      'reason', 'Last associated lead deleted'
    )::text);

    insert into follow_up_events (
      instance_id, profile_url, mutation_id, event_ordinal, request_fingerprint,
      event_kind, previous_due_date, new_due_date,
      previous_owner_id, new_owner_id, previous_owner_name, new_owner_name,
      state_revision, actor, reason
    ) values (
      old.instance_id, old.profile_url, v_mutation_id, 1, v_fingerprint,
      'canceled', v_state.next_follow_up_date, null,
      v_state.owner_id, null, v_owner_name, null,
      v_new_revision, 'system', 'Last associated lead deleted'
    ) returning id into v_event_id;

    update conversation_follow_up_state set
      next_follow_up_date = null,
      owner_id = null,
      revision = v_new_revision,
      last_event_id = v_event_id,
      last_mutation_id = v_mutation_id,
      updated_at = now(),
      updated_by = 'system',
      archived_at = now()
    where instance_id = old.instance_id and profile_url = old.profile_url;
  else
    update conversation_follow_up_state set
      owner_id = null,
      updated_at = now(),
      updated_by = 'system',
      archived_at = coalesce(archived_at, now())
    where instance_id = old.instance_id and profile_url = old.profile_url;
  end if;

  return old;
end;
$$;


ALTER FUNCTION public.archive_follow_up_after_last_lead() OWNER TO postgres;

--
-- Name: delete_manual_message(bigint); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.delete_manual_message(p_message_id bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  msg messages%rowtype;
  new_min_in  timestamptz;
  new_min_out timestamptz;
  new_min_any timestamptz;
  patched integer := 0;
begin
  delete from messages
  where id = p_message_id
    and source = 'manual'
  returning * into msg;
  if not found then
    -- Missing id OR a sync row: indistinguishable on purpose (the API 404s both).
    return jsonb_build_object('deleted', false);
  end if;

  select min(sent_at) filter (where direction = 'in'),
         min(sent_at) filter (where direction = 'out'),
         min(sent_at)
    into new_min_in, new_min_out, new_min_any
  from messages
  where instance_id = msg.instance_id
    and profile_url = msg.profile_url;

  perform set_config('app.allow_milestone_regress', 'on', true);  -- txn-local

  -- Deliberately broader than the import backfill (which patches only the one
  -- lead row of the imported campaign): every lead row of this person on this
  -- instance is checked, so a milestone derived from this row is repaired
  -- whichever campaign it sits on. Safe because only exact sent_at matches are
  -- touched — LH2 action-run times practically never coincide with a pasted
  -- row's real message time.
  update leads l
     set replied_at       = case when msg.direction = 'in'  and l.replied_at       = msg.sent_at
                                 then new_min_in  else l.replied_at end,
         first_message_at = case when msg.direction = 'out' and l.first_message_at = msg.sent_at
                                 then new_min_out else l.first_message_at end,
         connected_at     = case when l.connected_at = msg.sent_at
                                 then new_min_any else l.connected_at end
   where l.instance_id = msg.instance_id
     and l.profile_url = msg.profile_url
     and (   (msg.direction = 'in'  and l.replied_at       = msg.sent_at)
          or (msg.direction = 'out' and l.first_message_at = msg.sent_at)
          or  l.connected_at = msg.sent_at);
  get diagnostics patched = row_count;

  return jsonb_build_object('deleted', true, 'milestones_recomputed', patched);
end;
$$;


ALTER FUNCTION public.delete_manual_message(p_message_id bigint) OWNER TO postgres;

--
-- Name: is_active_team_member(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_active_team_member() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.team_members tm
    where tm.auth_user_id = auth.uid()
      and tm.active
  );
$$;


ALTER FUNCTION public.is_active_team_member() OWNER TO postgres;

--
-- Name: is_app_admin(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_app_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.team_members tm
    where tm.auth_user_id = auth.uid()
      and tm.active
      and tm.role = 'admin'
  );
$$;


ALTER FUNCTION public.is_app_admin() OWNER TO postgres;

--
-- Name: leads_keep_milestones(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.leads_keep_milestones() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(current_setting('app.allow_milestone_regress', true), '') = 'on' then
    return new;  -- delete_manual_message's recompute path (this migration)
  end if;
  new.invited_at       := coalesce(new.invited_at,       old.invited_at);
  new.connected_at     := coalesce(new.connected_at,     old.connected_at);
  new.first_message_at := coalesce(new.first_message_at, old.first_message_at);
  new.replied_at       := coalesce(new.replied_at,       old.replied_at);
  new.added_at         := coalesce(new.added_at,         old.added_at);
  return new;
end $$;


ALTER FUNCTION public.leads_keep_milestones() OWNER TO postgres;

--
-- Name: pipeline_auto_advance(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.pipeline_auto_advance() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  updated_count integer;
  followup_count integer;
begin
  -- (1) Serialize concurrent invocations (cron vs UI button). Xact-scoped advisory
  -- lock keyed on the function name; auto-released at transaction end.
  perform pg_advisory_xact_lock(hashtext('pipeline_auto_advance'));

  with latest_sentiment as (
    -- One row per lead ROW: the sentiment of its most recent real inbound reply.
    -- Scoped by (instance_id, campaign_id, profile_url) because pipeline status is
    -- per lead row (campaign_id, profile_url) — the same person reached from two
    -- campaigns of one instance must NOT have campaign A triaged from campaign B's
    -- reply. (A message with a NULL campaign_id can't be attributed to a campaign
    -- row and so advances nothing, which is the correct conservative behaviour.)
    -- 'auto' (out-of-office / autoresponder) is skipped, not a real reply.
    select distinct on (instance_id, campaign_id, profile_url)
      instance_id, campaign_id, profile_url, sentiment
    from messages
    where direction = 'in'
      and sentiment is not null
      and sentiment <> 'auto'
    order by instance_id, campaign_id, profile_url, sent_at desc
  ),
  targets as (
    -- Snapshot the pre-update stage here (a plain SELECT CTE sees leads as of the
    -- statement snapshot) so the event's from_stage is the OLD value; an
    -- UPDATE ... RETURNING would only expose the new pipeline_stage.
    select
      l.id,
      l.pipeline_stage as from_stage,
      case ls.sentiment
        when 'positive' then 'interested'
        when 'negative' then 'negative'
        else 'neutral'                      -- neutral/objection/referral/...
      end as to_stage
    from leads l
    join latest_sentiment ls
      on l.instance_id = ls.instance_id
     and l.campaign_id = ls.campaign_id
     and l.profile_url = ls.profile_url
    where l.replied_at is not null
      and (l.pipeline_stage is null or l.pipeline_stage = 'first_contact')
  ),
  updated as (
    update leads l
    set pipeline_stage            = t.to_stage,
        pipeline_stage_changed_at = now()
    from targets t
    where l.id = t.id
      -- (2) Re-assert the stage gate at UPDATE time. Under concurrency the row is
      -- re-read locked here, so a lead another invocation already advanced off
      -- NULL/'first_contact' is skipped and produces no duplicate pipeline_event.
      and (l.pipeline_stage is null or l.pipeline_stage = 'first_contact')
    returning l.id
  ),
  logged as (
    -- Data-modifying CTEs run to completion even when unreferenced by the main
    -- query, so this always fires for every UPDATED row. Driven off `updated`
    -- (not `targets`) so a row skipped by the re-asserted gate logs no event.
    insert into pipeline_events (lead_id, kind, actor, from_stage, to_stage, occurred_at)
    select t.id, 'stage', 'auto', t.from_stage, t.to_stage, now()
    from targets t
    join updated u on u.id = t.id
    returning 1
  )
  select count(*) into updated_count from updated;

  -- Phase 2 (new in 039): interested/neutral -> following_up for ghosted leads.
  with thread as (
    select instance_id, profile_url,
           max(sent_at) filter (where direction = 'in')  as last_in,
           max(sent_at) filter (where direction = 'out') as last_out
    from messages
    group by instance_id, profile_url
  ),
  last_stage_actor as (
    select distinct on (lead_id) lead_id, actor
    from pipeline_events
    where kind = 'stage'
    order by lead_id, occurred_at desc, id desc
  ),
  fu_targets as (
    select l.id, l.pipeline_stage as from_stage
    from leads l
    join thread t
      on t.instance_id = l.instance_id
     and t.profile_url = l.profile_url
    join last_stage_actor a on a.lead_id = l.id
    where l.pipeline_stage in ('interested', 'neutral')
      and a.actor = 'auto'
      and t.last_in is not null
      and t.last_in < now() - interval '14 days'
      and t.last_out > t.last_in
  ),
  fu_updated as (
    update leads l
    set pipeline_stage            = 'following_up',
        pipeline_substatus        = null,
        pipeline_stage_changed_at = now()
    from fu_targets t
    where l.id = t.id
      -- Re-asserted gate, same reasoning as phase 1's (2).
      and l.pipeline_stage in ('interested', 'neutral')
    returning l.id
  ),
  fu_logged as (
    insert into pipeline_events (lead_id, kind, actor, from_stage, to_stage, occurred_at)
    select t.id, 'stage', 'auto', t.from_stage, 'following_up', now()
    from fu_targets t
    join fu_updated u on u.id = t.id
    returning 1
  )
  select count(*) into followup_count from fu_updated;

  return updated_count + followup_count;
end;
$$;


ALTER FUNCTION public.pipeline_auto_advance() OWNER TO postgres;

--
-- Name: refresh_lead_age_estimate(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.refresh_lead_age_estimate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  edu_min int;
  edu_max int;
  job_min int;
  job_max int;
  inferred_min int;
  inferred_max int;
  current_year int := extract(year from now() at time zone 'utc')::int;
begin
  if new.education_start_year is null and new.first_job_start_year is null then
    new.birth_year_min := null;
    new.birth_year_max := null;
    new.age_inferred_at := null;
    new.age_method_version := null;
    new.age_source := null;
    return new;
  end if;

  if new.education_start_year is not null then
    edu_min := new.education_start_year - 21;
    edu_max := new.education_start_year - 16;
  end if;
  if new.first_job_start_year is not null then
    job_min := new.first_job_start_year - 27;
    job_max := new.first_job_start_year - 17;
  end if;

  if edu_min is not null and job_min is not null then
    inferred_min := greatest(edu_min, job_min);
    inferred_max := least(edu_max, job_max);
    new.age_source := 'combined';
  elsif edu_min is not null then
    inferred_min := edu_min;
    inferred_max := edu_max;
    new.age_source := 'education';
  else
    inferred_min := job_min;
    inferred_max := job_max;
    new.age_source := 'first_job';
  end if;

  new.age_inferred_at := now();
  new.age_method_version := 'career-signals-v2';

  if inferred_min is null
     or inferred_max is null
     or inferred_min > inferred_max
     or inferred_min < 1930
     or inferred_max > current_year - 15 then
    new.birth_year_min := null;
    new.birth_year_max := null;
    new.age_source := 'conflict';
  else
    new.birth_year_min := inferred_min;
    new.birth_year_max := inferred_max;
  end if;

  return new;
end $$;


ALTER FUNCTION public.refresh_lead_age_estimate() OWNER TO postgres;

--
-- Name: reset_lead_gender_on_input_change(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.reset_lead_gender_on_input_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (new.full_name, new.headline) is distinct from (old.full_name, old.headline)
     and coalesce(old.demo_model, '') <> 'manual' then
    new.gender := null;
    new.gender_confidence := null;
    new.gender_inferred_at := null;
    new.gender_model_version := null;
    -- Legacy compatibility fields retained until all clients use the split lifecycle.
    new.demo_inferred_at := null;
    new.demo_model := null;
  end if;
  return new;
end $$;


ALTER FUNCTION public.reset_lead_gender_on_input_change() OWNER TO postgres;

--
-- Name: set_hypothesis_campaigns(bigint, text[]); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_hypothesis_campaigns(p_hypothesis_id bigint, p_campaign_ids text[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (select 1 from hypotheses where id = p_hypothesis_id) then
    raise exception 'unknown hypothesis id %', p_hypothesis_id;
  end if;

  -- Drop this hypothesis's old assignments that aren't in the new set.
  delete from hypothesis_campaigns
  where hypothesis_id = p_hypothesis_id
    and not (campaign_id = any(p_campaign_ids));

  -- Release every campaign in the new set from whichever hypothesis currently
  -- holds it (itself included) so the unique(campaign_id) reattachment below
  -- can't 23505 against a stale row.
  delete from hypothesis_campaigns
  where campaign_id = any(p_campaign_ids);

  insert into hypothesis_campaigns (hypothesis_id, campaign_id)
  select p_hypothesis_id, x
  from unnest(p_campaign_ids) as x;
end;
$$;


ALTER FUNCTION public.set_hypothesis_campaigns(p_hypothesis_id bigint, p_campaign_ids text[]) OWNER TO postgres;

--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  -- Reset updated_at to the old value BEFORE comparing so that (1) the column does
  -- not compare against itself (which would always differ once now() advances) and
  -- (2) the agent's manual updated_at = now() stamp is overridden. Then bump only
  -- when some other column actually changed.
  new.updated_at := old.updated_at;
  if new is distinct from old then
    new.updated_at := now();
  end if;
  return new;
end $$;


ALTER FUNCTION public.touch_updated_at() OWNER TO postgres;

--
-- Name: annotations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.annotations (
    id bigint NOT NULL,
    instance_id text,
    campaign_id text,
    note text NOT NULL,
    noted_at date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.annotations OWNER TO postgres;

--
-- Name: annotations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.annotations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.annotations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: briefing_jobs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.briefing_jobs (
    briefing_date date NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    seed text,
    signals_block text,
    prior_md text,
    drafts jsonb,
    verified_text text,
    error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    briefing_kind text DEFAULT 'daily'::text NOT NULL,
    CONSTRAINT briefing_jobs_briefing_kind_check CHECK ((briefing_kind = ANY (ARRAY['daily'::text, 'weekly'::text])))
);


ALTER TABLE public.briefing_jobs OWNER TO postgres;

--
-- Name: briefings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.briefings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    briefing_date date NOT NULL,
    headline text,
    summary text,
    sections jsonb DEFAULT '[]'::jsonb NOT NULL,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    risks jsonb DEFAULT '[]'::jsonb NOT NULL,
    model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    changes jsonb DEFAULT '[]'::jsonb NOT NULL,
    metrics jsonb DEFAULT '[]'::jsonb NOT NULL,
    briefing_kind text DEFAULT 'daily'::text NOT NULL,
    period_start date,
    period_end date,
    CONSTRAINT briefings_briefing_kind_check CHECK ((briefing_kind = ANY (ARRAY['daily'::text, 'weekly'::text])))
);


ALTER TABLE public.briefings OWNER TO postgres;

--
-- Name: COLUMN briefings.briefing_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.briefings.briefing_date IS 'UTC run date for daily rows; Monday week key for weekly rows.';


--
-- Name: COLUMN briefings.briefing_kind; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.briefings.briefing_kind IS 'daily = short weekday operational note; weekly = longer Monday review.';


--
-- Name: campaign_metrics; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.campaign_metrics AS
SELECT
    NULL::text AS campaign_id,
    NULL::text AS campaign_name,
    NULL::text AS instance_id,
    NULL::text AS status,
    NULL::bigint AS total_leads,
    NULL::bigint AS invites_sent,
    NULL::bigint AS accepted,
    NULL::bigint AS replies,
    NULL::numeric AS acceptance_rate,
    NULL::numeric AS reply_rate,
    NULL::timestamp with time zone AS last_activity_at,
    NULL::text AS briefing_context,
    NULL::timestamp with time zone AS briefing_context_updated_at;


ALTER VIEW public.campaign_metrics OWNER TO postgres;

--
-- Name: messages; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.messages (
    id bigint NOT NULL,
    instance_id text NOT NULL,
    campaign_id text,
    profile_url text NOT NULL,
    direction text DEFAULT 'in'::text NOT NULL,
    body text,
    sent_at timestamp with time zone NOT NULL,
    sentiment text,
    reason text,
    classified_at timestamp with time zone,
    classified_model text,
    content_hash text DEFAULT ''::text NOT NULL,
    source text DEFAULT 'sync'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    notified_at timestamp with time zone,
    intent_level text,
    intent_reason text,
    intent_classified_at timestamp with time zone,
    intent_classified_model text,
    intent_taxonomy_version text,
    CONSTRAINT messages_intent_level_check CHECK ((intent_level = ANY (ARRAY['p1'::text, 'p2'::text, 'p3'::text]))),
    CONSTRAINT messages_sentiment_check CHECK ((sentiment = ANY (ARRAY['positive'::text, 'neutral'::text, 'negative'::text, 'objection'::text, 'referral'::text, 'auto'::text]))),
    CONSTRAINT messages_source_check CHECK ((source = ANY (ARRAY['sync'::text, 'manual'::text])))
);


ALTER TABLE public.messages OWNER TO postgres;

--
-- Name: COLUMN messages.intent_level; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.messages.intent_level IS 'Commercial reply intent: p1 polite positive, p2 problem interest, p3 buying intent; independent of sentiment.';


--
-- Name: COLUMN messages.intent_taxonomy_version; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.messages.intent_taxonomy_version IS 'Version of the intent rubric applied. Non-null even when intent_level is NULL.';


--
-- Name: campaign_reply_intent; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.campaign_reply_intent WITH (security_invoker='true') AS
 SELECT campaign_id,
    intent_level,
    count(*) AS cnt
   FROM public.messages
  WHERE ((direction = 'in'::text) AND (intent_level IS NOT NULL))
  GROUP BY campaign_id, intent_level;


ALTER VIEW public.campaign_reply_intent OWNER TO postgres;

--
-- Name: campaign_reply_sentiment; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.campaign_reply_sentiment WITH (security_invoker='true') AS
 SELECT campaign_id,
    sentiment,
    count(*) AS cnt
   FROM public.messages
  WHERE ((direction = 'in'::text) AND (sentiment IS NOT NULL))
  GROUP BY campaign_id, sentiment;


ALTER VIEW public.campaign_reply_sentiment OWNER TO postgres;

--
-- Name: campaign_steps; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.campaign_steps (
    campaign_id text NOT NULL,
    step_index integer NOT NULL,
    step_label text,
    step_type text,
    template_body text,
    sent_count integer DEFAULT 0 NOT NULL,
    replied_count integer DEFAULT 0 NOT NULL,
    current_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.campaign_steps OWNER TO postgres;

--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.campaigns (
    id text NOT NULL,
    instance_id text NOT NULL,
    lh_campaign_id text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    briefing_context text,
    briefing_context_updated_at timestamp with time zone,
    CONSTRAINT campaigns_briefing_context_length CHECK (((briefing_context IS NULL) OR (char_length(briefing_context) <= 4000)))
);


ALTER TABLE public.campaigns OWNER TO postgres;

--
-- Name: COLUMN campaigns.briefing_context; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.campaigns.briefing_context IS 'Team-provided operational background for AI briefings; context, not measured telemetry.';


--
-- Name: coaching_digest; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.coaching_digest (
    instance_id text NOT NULL,
    summary text,
    patterns jsonb DEFAULT '[]'::jsonb NOT NULL,
    computed_at timestamp with time zone,
    model text
);


ALTER TABLE public.coaching_digest OWNER TO postgres;

--
-- Name: conversation_coaching; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.conversation_coaching (
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    next_action text,
    issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    tips jsonb DEFAULT '[]'::jsonb NOT NULL,
    summary text,
    last_msg_marker text,
    coached_at timestamp with time zone,
    model text
);


ALTER TABLE public.conversation_coaching OWNER TO postgres;

--
-- Name: conversation_follow_up_state; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.conversation_follow_up_state (
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    next_follow_up_date date,
    owner_id bigint,
    revision bigint DEFAULT 0 NOT NULL,
    last_event_id bigint,
    last_mutation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text DEFAULT 'unknown'::text NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT conversation_follow_up_state_revision_check CHECK ((revision >= 0)),
    CONSTRAINT conversation_follow_up_state_updated_by_check CHECK (((char_length(btrim(updated_by)) >= 1) AND (char_length(btrim(updated_by)) <= 120)))
);


ALTER TABLE public.conversation_follow_up_state OWNER TO postgres;

--
-- Name: conversation_latest_message; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.conversation_latest_message WITH (security_invoker='true') AS
 SELECT DISTINCT ON (instance_id, profile_url) instance_id,
    profile_url,
    id AS message_id,
    direction,
    body,
    sent_at,
    source
   FROM public.messages m
  WHERE ((body IS NOT NULL) AND (btrim(body) <> ''::text))
  ORDER BY instance_id, profile_url, sent_at DESC, id DESC;


ALTER VIEW public.conversation_latest_message OWNER TO postgres;

--
-- Name: conversation_reply_intent; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.conversation_reply_intent WITH (security_invoker='true') AS
 WITH ranked AS (
         SELECT messages.instance_id,
            messages.profile_url,
            messages.campaign_id,
            messages.sent_at,
            messages.intent_level,
            row_number() OVER (PARTITION BY messages.instance_id, messages.profile_url ORDER BY
                CASE messages.intent_level
                    WHEN 'p3'::text THEN 3
                    WHEN 'p2'::text THEN 2
                    WHEN 'p1'::text THEN 1
                    ELSE 0
                END DESC, messages.sent_at, messages.id) AS highest_rn,
            row_number() OVER (PARTITION BY messages.instance_id, messages.profile_url, messages.intent_level ORDER BY messages.sent_at, messages.id) AS level_rn
           FROM public.messages
          WHERE ((messages.direction = 'in'::text) AND (messages.intent_level IS NOT NULL))
        ), milestones AS (
         SELECT ranked.instance_id,
            ranked.profile_url,
            max(ranked.intent_level) FILTER (WHERE (ranked.highest_rn = 1)) AS highest_intent,
            min(ranked.sent_at) FILTER (WHERE (ranked.intent_level = 'p1'::text)) AS first_p1_at,
            min(ranked.sent_at) FILTER (WHERE (ranked.intent_level = 'p2'::text)) AS first_p2_at,
            min(ranked.sent_at) FILTER (WHERE (ranked.intent_level = 'p3'::text)) AS first_p3_at,
            max(ranked.campaign_id) FILTER (WHERE ((ranked.intent_level = 'p3'::text) AND (ranked.level_rn = 1))) AS first_p3_campaign_id
           FROM ranked
          GROUP BY ranked.instance_id, ranked.profile_url
        )
 SELECT mi.instance_id,
    mi.profile_url,
    mi.highest_intent,
    mi.first_p1_at,
    mi.first_p2_at,
    mi.first_p3_at,
    mi.first_p3_campaign_id,
    max(m.sent_at) FILTER (WHERE ((m.direction = 'out'::text) AND (m.sent_at > mi.first_p3_at))) AS last_out_after_p3_at,
    max(m.sent_at) FILTER (WHERE ((m.direction = 'in'::text) AND (m.sent_at > mi.first_p3_at))) AS last_in_after_p3_at
   FROM (milestones mi
     LEFT JOIN public.messages m ON (((m.instance_id = mi.instance_id) AND (m.profile_url = mi.profile_url))))
  GROUP BY mi.instance_id, mi.profile_url, mi.highest_intent, mi.first_p1_at, mi.first_p2_at, mi.first_p3_at, mi.first_p3_campaign_id;


ALTER VIEW public.conversation_reply_intent OWNER TO postgres;

--
-- Name: events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events (
    id bigint NOT NULL,
    instance_id text NOT NULL,
    campaign_id text,
    profile_url text,
    event_type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    raw jsonb
);


ALTER TABLE public.events OWNER TO postgres;

--
-- Name: daily_activity; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.daily_activity WITH (security_invoker='true') AS
 SELECT (date_trunc('day'::text, occurred_at))::date AS day,
    instance_id,
    event_type,
    count(*) AS cnt
   FROM public.events
  GROUP BY ((date_trunc('day'::text, occurred_at))::date), instance_id, event_type;


ALTER VIEW public.daily_activity OWNER TO postgres;

--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: follow_up_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.follow_up_events (
    id bigint NOT NULL,
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    mutation_id uuid NOT NULL,
    event_ordinal smallint NOT NULL,
    request_fingerprint text NOT NULL,
    event_kind text NOT NULL,
    previous_due_date date,
    new_due_date date,
    previous_owner_id bigint,
    new_owner_id bigint,
    previous_owner_name text,
    new_owner_name text,
    state_revision bigint NOT NULL,
    actor text NOT NULL,
    reason text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT follow_up_events_actor_check CHECK (((char_length(btrim(actor)) >= 1) AND (char_length(btrim(actor)) <= 120))),
    CONSTRAINT follow_up_events_event_kind_check CHECK ((event_kind = ANY (ARRAY['scheduled'::text, 'rescheduled'::text, 'reassigned'::text, 'completed'::text, 'skipped'::text, 'canceled'::text]))),
    CONSTRAINT follow_up_events_event_ordinal_check CHECK (((event_ordinal >= 1) AND (event_ordinal <= 2))),
    CONSTRAINT follow_up_events_new_owner_name_check CHECK (((new_owner_name IS NULL) OR (char_length(new_owner_name) <= 100))),
    CONSTRAINT follow_up_events_previous_owner_name_check CHECK (((previous_owner_name IS NULL) OR (char_length(previous_owner_name) <= 100))),
    CONSTRAINT follow_up_events_reason_check CHECK (((reason IS NULL) OR (char_length(reason) <= 1000))),
    CONSTRAINT follow_up_events_skip_reason_check CHECK (((event_kind <> 'skipped'::text) OR ((reason IS NOT NULL) AND (btrim(reason) <> ''::text)))),
    CONSTRAINT follow_up_events_state_revision_check CHECK ((state_revision > 0)),
    CONSTRAINT follow_up_events_values_check CHECK ((((event_kind = 'scheduled'::text) AND (previous_due_date IS NULL) AND (new_due_date IS NOT NULL) AND (new_owner_name IS NOT NULL)) OR ((event_kind = 'rescheduled'::text) AND (previous_due_date IS NOT NULL) AND (new_due_date IS NOT NULL) AND (previous_due_date <> new_due_date)) OR ((event_kind = 'reassigned'::text) AND (previous_due_date IS NOT NULL) AND (new_due_date = previous_due_date) AND (new_owner_name IS NOT NULL) AND (previous_owner_name IS DISTINCT FROM new_owner_name)) OR ((event_kind = ANY (ARRAY['completed'::text, 'skipped'::text, 'canceled'::text])) AND (previous_due_date IS NOT NULL) AND (new_due_date IS NULL))))
);


ALTER TABLE public.follow_up_events OWNER TO postgres;

--
-- Name: follow_up_events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.follow_up_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.follow_up_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: hypotheses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hypotheses (
    id bigint NOT NULL,
    name text NOT NULL,
    icp_id bigint,
    description text,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hypotheses_description_check CHECK (((description IS NULL) OR (char_length(description) <= 2000))),
    CONSTRAINT hypotheses_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 160)))
);


ALTER TABLE public.hypotheses OWNER TO postgres;

--
-- Name: hypotheses_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.hypotheses ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.hypotheses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: hypothesis_campaigns; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hypothesis_campaigns (
    hypothesis_id bigint NOT NULL,
    campaign_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.hypothesis_campaigns OWNER TO postgres;

--
-- Name: icp_industries; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.icp_industries (
    id bigint NOT NULL,
    icp_id bigint NOT NULL,
    name text NOT NULL,
    include_keywords text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT icp_industries_include_kw_len CHECK (((array_length(include_keywords, 1) IS NULL) OR (array_length(include_keywords, 1) <= 100))),
    CONSTRAINT icp_industries_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 200)))
);


ALTER TABLE public.icp_industries OWNER TO postgres;

--
-- Name: icp_industries_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.icp_industries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.icp_industries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: icp_personas; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.icp_personas (
    id bigint NOT NULL,
    icp_id bigint NOT NULL,
    kind text NOT NULL,
    job_titles text[] DEFAULT '{}'::text[] NOT NULL,
    age_range text,
    location text,
    background text,
    profile_status text,
    connections_note text,
    followers_note text,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT icp_personas_age_range_check CHECK (((age_range IS NULL) OR (char_length(age_range) <= 60))),
    CONSTRAINT icp_personas_background_check CHECK (((background IS NULL) OR (char_length(background) <= 2000))),
    CONSTRAINT icp_personas_connections_note_check CHECK (((connections_note IS NULL) OR (char_length(connections_note) <= 200))),
    CONSTRAINT icp_personas_followers_note_check CHECK (((followers_note IS NULL) OR (char_length(followers_note) <= 200))),
    CONSTRAINT icp_personas_job_titles_len CHECK (((array_length(job_titles, 1) IS NULL) OR (array_length(job_titles, 1) <= 100))),
    CONSTRAINT icp_personas_kind_check CHECK (((char_length(kind) >= 1) AND (char_length(kind) <= 120))),
    CONSTRAINT icp_personas_location_check CHECK (((location IS NULL) OR (char_length(location) <= 300))),
    CONSTRAINT icp_personas_profile_status_check CHECK (((profile_status IS NULL) OR (char_length(profile_status) <= 500)))
);


ALTER TABLE public.icp_personas OWNER TO postgres;

--
-- Name: icp_personas_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.icp_personas ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.icp_personas_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: icps; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.icps (
    id bigint NOT NULL,
    name text NOT NULL,
    airtable_url text,
    main_product text,
    core_sphere text,
    secondary_sphere text,
    product_stage text,
    monetization text,
    features_note text,
    purchase_triggers text[] DEFAULT '{}'::text[] NOT NULL,
    features text[] DEFAULT '{}'::text[] NOT NULL,
    company_countries text[] DEFAULT '{}'::text[] NOT NULL,
    company_headcount text,
    company_age text,
    apollo_industries text[] DEFAULT '{}'::text[] NOT NULL,
    funding text,
    dev_team_availability text,
    dev_team_location text,
    exclude_keywords text[] DEFAULT '{}'::text[] NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT icps_airtable_url_check CHECK (((airtable_url IS NULL) OR (char_length(airtable_url) <= 500))),
    CONSTRAINT icps_company_age_check CHECK (((company_age IS NULL) OR (char_length(company_age) <= 200))),
    CONSTRAINT icps_company_headcount_check CHECK (((company_headcount IS NULL) OR (char_length(company_headcount) <= 200))),
    CONSTRAINT icps_core_sphere_check CHECK (((core_sphere IS NULL) OR (char_length(core_sphere) <= 500))),
    CONSTRAINT icps_countries_len CHECK (((array_length(company_countries, 1) IS NULL) OR (array_length(company_countries, 1) <= 200))),
    CONSTRAINT icps_dev_team_availability_check CHECK (((dev_team_availability IS NULL) OR (char_length(dev_team_availability) <= 500))),
    CONSTRAINT icps_dev_team_location_check CHECK (((dev_team_location IS NULL) OR (char_length(dev_team_location) <= 500))),
    CONSTRAINT icps_exclude_kw_len CHECK (((array_length(exclude_keywords, 1) IS NULL) OR (array_length(exclude_keywords, 1) <= 500))),
    CONSTRAINT icps_features_len CHECK (((array_length(features, 1) IS NULL) OR (array_length(features, 1) <= 50))),
    CONSTRAINT icps_features_note_check CHECK (((features_note IS NULL) OR (char_length(features_note) <= 2000))),
    CONSTRAINT icps_funding_check CHECK (((funding IS NULL) OR (char_length(funding) <= 500))),
    CONSTRAINT icps_industries_len CHECK (((array_length(apollo_industries, 1) IS NULL) OR (array_length(apollo_industries, 1) <= 100))),
    CONSTRAINT icps_main_product_check CHECK (((main_product IS NULL) OR (char_length(main_product) <= 500))),
    CONSTRAINT icps_monetization_check CHECK (((monetization IS NULL) OR (char_length(monetization) <= 500))),
    CONSTRAINT icps_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT icps_product_stage_check CHECK (((product_stage IS NULL) OR (char_length(product_stage) <= 500))),
    CONSTRAINT icps_purchase_triggers_len CHECK (((array_length(purchase_triggers, 1) IS NULL) OR (array_length(purchase_triggers, 1) <= 50))),
    CONSTRAINT icps_secondary_sphere_check CHECK (((secondary_sphere IS NULL) OR (char_length(secondary_sphere) <= 500)))
);


ALTER TABLE public.icps OWNER TO postgres;

--
-- Name: icps_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.icps ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.icps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: instances; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.instances (
    id text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    last_sync_at timestamp with time zone,
    agent_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_name text,
    account_url text,
    account_avatar text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    config_updated_at timestamp with time zone
);


ALTER TABLE public.instances OWNER TO postgres;

--
-- Name: lead_gender_reviews; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.lead_gender_reviews (
    id bigint NOT NULL,
    lead_id uuid,
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    action text NOT NULL,
    predicted_gender text,
    predicted_confidence real,
    predicted_model text,
    predicted_version text,
    reviewed_gender text,
    reviewer text,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_gender_reviews_action_check CHECK ((action = ANY (ARRAY['set'::text, 'clear'::text]))),
    CONSTRAINT lead_gender_reviews_predicted_confidence_check CHECK (((predicted_confidence >= (0)::double precision) AND (predicted_confidence <= (1)::double precision))),
    CONSTRAINT lead_gender_reviews_predicted_gender_check CHECK ((predicted_gender = ANY (ARRAY['male'::text, 'female'::text, 'unknown'::text]))),
    CONSTRAINT lead_gender_reviews_reviewed_gender_check CHECK ((reviewed_gender = ANY (ARRAY['male'::text, 'female'::text, 'unknown'::text])))
);


ALTER TABLE public.lead_gender_reviews OWNER TO postgres;

--
-- Name: lead_gender_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.lead_gender_reviews ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.lead_gender_reviews_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: lead_notes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.lead_notes (
    id bigint NOT NULL,
    lead_id uuid NOT NULL,
    author text,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.lead_notes OWNER TO postgres;

--
-- Name: lead_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.lead_notes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.lead_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: leads; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instance_id text NOT NULL,
    campaign_id text NOT NULL,
    profile_url text NOT NULL,
    full_name text,
    headline text,
    company text,
    status text,
    invited_at timestamp with time zone,
    connected_at timestamp with time zone,
    first_message_at timestamp with time zone,
    replied_at timestamp with time zone,
    last_action_at timestamp with time zone,
    raw jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    added_at timestamp with time zone,
    pipeline_stage text,
    pipeline_substatus text,
    lost_reason text,
    pipeline_stage_changed_at timestamp with time zone,
    assigned_to bigint,
    education_start_year integer,
    first_job_start_year integer,
    birth_year_min integer,
    birth_year_max integer,
    gender text,
    gender_confidence real,
    demo_inferred_at timestamp with time zone,
    demo_model text,
    photo_path text,
    photo_synced_at timestamp with time zone,
    age_inferred_at timestamp with time zone,
    age_method_version text,
    age_source text,
    gender_inferred_at timestamp with time zone,
    gender_model_version text,
    CONSTRAINT leads_age_source_check CHECK ((age_source = ANY (ARRAY['education'::text, 'first_job'::text, 'combined'::text, 'conflict'::text]))),
    CONSTRAINT leads_education_start_year_check CHECK (((education_start_year >= 1950) AND (education_start_year <= 2100))),
    CONSTRAINT leads_first_job_start_year_check CHECK (((first_job_start_year >= 1950) AND (first_job_start_year <= 2100))),
    CONSTRAINT leads_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text, 'unknown'::text]))),
    CONSTRAINT leads_gender_confidence_check CHECK (((gender_confidence >= (0)::double precision) AND (gender_confidence <= (1)::double precision))),
    CONSTRAINT leads_pipeline_stage_check CHECK (((pipeline_stage IS NULL) OR (pipeline_stage = ANY (ARRAY['first_contact'::text, 'interested'::text, 'neutral'::text, 'negative'::text, 'following_up'::text, 'negotiations_call'::text, 'call_booked'::text, 'call_done'::text, 'proposal_in_progress'::text, 'proposal_presented'::text, 'client'::text, 'lost'::text])))),
    CONSTRAINT leads_pipeline_substatus_check CHECK (((pipeline_substatus IS NULL) OR (pipeline_substatus = ANY (ARRAY['soft_no'::text, 'hard_no'::text, 'lost'::text, 'proposal'::text, 'later'::text, 'not_a_fit'::text, 'waiting_decision'::text, 'contract'::text, 'needs_changes'::text]))))
);


ALTER TABLE public.leads OWNER TO postgres;

--
-- Name: messages_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pipeline_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.pipeline_events (
    id bigint NOT NULL,
    lead_id uuid NOT NULL,
    kind text NOT NULL,
    actor text DEFAULT 'unknown'::text NOT NULL,
    from_stage text,
    to_stage text,
    from_substatus text,
    to_substatus text,
    from_assignee text,
    to_assignee text,
    lost_reason text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pipeline_events_kind_check CHECK ((kind = ANY (ARRAY['stage'::text, 'assignment'::text])))
);


ALTER TABLE public.pipeline_events OWNER TO postgres;

--
-- Name: pipeline_events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.pipeline_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pipeline_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pipeline_metrics; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.pipeline_metrics WITH (security_invoker='true') AS
 SELECT campaign_id,
    instance_id,
    pipeline_stage,
    pipeline_substatus,
    count(*) AS leads,
    min(pipeline_stage_changed_at) AS oldest_in_stage,
    count(*) FILTER (WHERE (pipeline_stage_changed_at < (now() - '14 days'::interval))) AS stale_14d
   FROM public.leads
  WHERE (pipeline_stage IS NOT NULL)
  GROUP BY campaign_id, instance_id, pipeline_stage, pipeline_substatus;


ALTER VIEW public.pipeline_metrics OWNER TO postgres;

--
-- Name: playbook; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.playbook (
    id boolean DEFAULT true NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT playbook_singleton CHECK (id)
);


ALTER TABLE public.playbook OWNER TO postgres;

--
-- Name: saved_searches; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.saved_searches (
    id bigint NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    description text,
    include_keywords text[] DEFAULT '{}'::text[] NOT NULL,
    exclude_keywords text[] DEFAULT '{}'::text[] NOT NULL,
    boolean_query text,
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    author text,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    hypothesis_id bigint,
    CONSTRAINT saved_searches_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT saved_searches_platform_check CHECK (((char_length(platform) >= 1) AND (char_length(platform) <= 60)))
);


ALTER TABLE public.saved_searches OWNER TO postgres;

--
-- Name: saved_searches_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.saved_searches ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.saved_searches_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sync_runs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instance_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    rows_upserted integer DEFAULT 0 NOT NULL,
    error text
);


ALTER TABLE public.sync_runs OWNER TO postgres;

--
-- Name: team_members_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.team_members ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.team_members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: annotations annotations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_pkey PRIMARY KEY (id);


--
-- Name: annotations annotations_scope_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_scope_key UNIQUE NULLS NOT DISTINCT (note, noted_at, instance_id, campaign_id);


--
-- Name: briefing_jobs briefing_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.briefing_jobs
    ADD CONSTRAINT briefing_jobs_pkey PRIMARY KEY (briefing_date, briefing_kind);


--
-- Name: briefings briefings_date_kind_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.briefings
    ADD CONSTRAINT briefings_date_kind_key UNIQUE (briefing_date, briefing_kind);


--
-- Name: briefings briefings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.briefings
    ADD CONSTRAINT briefings_pkey PRIMARY KEY (id);


--
-- Name: campaign_steps campaign_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campaign_steps
    ADD CONSTRAINT campaign_steps_pkey PRIMARY KEY (campaign_id, step_index);


--
-- Name: campaigns campaigns_instance_id_lh_campaign_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_instance_id_lh_campaign_id_key UNIQUE (instance_id, lh_campaign_id);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: coaching_digest coaching_digest_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coaching_digest
    ADD CONSTRAINT coaching_digest_pkey PRIMARY KEY (instance_id);


--
-- Name: conversation_coaching conversation_coaching_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.conversation_coaching
    ADD CONSTRAINT conversation_coaching_pkey PRIMARY KEY (instance_id, profile_url);


--
-- Name: conversation_follow_up_state conversation_follow_up_state_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.conversation_follow_up_state
    ADD CONSTRAINT conversation_follow_up_state_pkey PRIMARY KEY (instance_id, profile_url);


--
-- Name: events events_identity_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_identity_key UNIQUE NULLS NOT DISTINCT (instance_id, campaign_id, profile_url, event_type);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: follow_up_events follow_up_events_mutation_id_event_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.follow_up_events
    ADD CONSTRAINT follow_up_events_mutation_id_event_ordinal_key UNIQUE (mutation_id, event_ordinal);


--
-- Name: follow_up_events follow_up_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.follow_up_events
    ADD CONSTRAINT follow_up_events_pkey PRIMARY KEY (id);


--
-- Name: hypotheses hypotheses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_pkey PRIMARY KEY (id);


--
-- Name: hypothesis_campaigns hypothesis_campaigns_campaign_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypothesis_campaigns
    ADD CONSTRAINT hypothesis_campaigns_campaign_id_key UNIQUE (campaign_id);


--
-- Name: hypothesis_campaigns hypothesis_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypothesis_campaigns
    ADD CONSTRAINT hypothesis_campaigns_pkey PRIMARY KEY (hypothesis_id, campaign_id);


--
-- Name: icp_industries icp_industries_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.icp_industries
    ADD CONSTRAINT icp_industries_pkey PRIMARY KEY (id);


--
-- Name: icp_personas icp_personas_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.icp_personas
    ADD CONSTRAINT icp_personas_pkey PRIMARY KEY (id);


--
-- Name: icps icps_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.icps
    ADD CONSTRAINT icps_pkey PRIMARY KEY (id);


--
-- Name: instances instances_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.instances
    ADD CONSTRAINT instances_pkey PRIMARY KEY (id);


--
-- Name: lead_gender_reviews lead_gender_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lead_gender_reviews
    ADD CONSTRAINT lead_gender_reviews_pkey PRIMARY KEY (id);


--
-- Name: lead_notes lead_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lead_notes
    ADD CONSTRAINT lead_notes_pkey PRIMARY KEY (id);


--
-- Name: leads leads_campaign_id_profile_url_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_campaign_id_profile_url_key UNIQUE (campaign_id, profile_url);


--
-- Name: leads leads_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_pkey PRIMARY KEY (id);


--
-- Name: messages messages_identity_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_identity_key UNIQUE (instance_id, profile_url, direction, sent_at, content_hash);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: pipeline_events pipeline_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pipeline_events
    ADD CONSTRAINT pipeline_events_pkey PRIMARY KEY (id);


--
-- Name: playbook playbook_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.playbook
    ADD CONSTRAINT playbook_pkey PRIMARY KEY (id);


--
-- Name: saved_searches saved_searches_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.saved_searches
    ADD CONSTRAINT saved_searches_pkey PRIMARY KEY (id);


--
-- Name: sync_runs sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sync_runs
    ADD CONSTRAINT sync_runs_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_name_key UNIQUE (name);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: briefings_date_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX briefings_date_idx ON public.briefings USING btree (briefing_date DESC);


--
-- Name: briefings_kind_date_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX briefings_kind_date_idx ON public.briefings USING btree (briefing_kind, briefing_date DESC);


--
-- Name: conversation_follow_up_active_due_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX conversation_follow_up_active_due_idx ON public.conversation_follow_up_state USING btree (next_follow_up_date, owner_id) WHERE ((next_follow_up_date IS NOT NULL) AND (archived_at IS NULL));


--
-- Name: conversation_follow_up_owner_due_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX conversation_follow_up_owner_due_idx ON public.conversation_follow_up_state USING btree (owner_id, next_follow_up_date) WHERE ((next_follow_up_date IS NOT NULL) AND (archived_at IS NULL));


--
-- Name: events_time_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_time_idx ON public.events USING btree (occurred_at);


--
-- Name: follow_up_events_thread_time_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX follow_up_events_thread_time_idx ON public.follow_up_events USING btree (instance_id, profile_url, occurred_at DESC, id DESC);


--
-- Name: follow_up_events_time_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX follow_up_events_time_idx ON public.follow_up_events USING btree (occurred_at DESC, id DESC);


--
-- Name: hypotheses_icp_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX hypotheses_icp_id ON public.hypotheses USING btree (icp_id);


--
-- Name: hypotheses_lower_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX hypotheses_lower_name ON public.hypotheses USING btree (lower(name));


--
-- Name: hypothesis_campaigns_hypothesis_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX hypothesis_campaigns_hypothesis_id ON public.hypothesis_campaigns USING btree (hypothesis_id);


--
-- Name: icp_industries_icp_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX icp_industries_icp_id ON public.icp_industries USING btree (icp_id);


--
-- Name: icp_industries_icp_lower_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX icp_industries_icp_lower_name ON public.icp_industries USING btree (icp_id, lower(name));


--
-- Name: icp_personas_icp_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX icp_personas_icp_id ON public.icp_personas USING btree (icp_id);


--
-- Name: icp_personas_icp_lower_kind; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX icp_personas_icp_lower_kind ON public.icp_personas USING btree (icp_id, lower(kind));


--
-- Name: icps_lower_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX icps_lower_name ON public.icps USING btree (lower(name));


--
-- Name: lead_gender_reviews_person_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX lead_gender_reviews_person_idx ON public.lead_gender_reviews USING btree (instance_id, profile_url, reviewed_at DESC);


--
-- Name: lead_notes_lead_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX lead_notes_lead_idx ON public.lead_notes USING btree (lead_id, created_at DESC);


--
-- Name: leads_added_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX leads_added_idx ON public.leads USING btree (added_at);


--
-- Name: leads_assigned_to_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX leads_assigned_to_idx ON public.leads USING btree (assigned_to) WHERE (assigned_to IS NOT NULL);


--
-- Name: leads_campaign_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX leads_campaign_idx ON public.leads USING btree (campaign_id);


--
-- Name: leads_gender_backlog_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX leads_gender_backlog_idx ON public.leads USING btree (instance_id, added_at) WHERE ((gender_inferred_at IS NULL) AND (demo_model IS DISTINCT FROM 'manual'::text));


--
-- Name: leads_instance_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX leads_instance_idx ON public.leads USING btree (instance_id);


--
-- Name: leads_instance_profile_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX leads_instance_profile_idx ON public.leads USING btree (instance_id, profile_url);


--
-- Name: leads_pipeline_stage_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX leads_pipeline_stage_idx ON public.leads USING btree (pipeline_stage) WHERE (pipeline_stage IS NOT NULL);


--
-- Name: leads_updated_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX leads_updated_at_idx ON public.leads USING btree (updated_at);


--
-- Name: messages_campaign_sentiment_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX messages_campaign_sentiment_idx ON public.messages USING btree (campaign_id) WHERE (sentiment IS NOT NULL);


--
-- Name: messages_inbound_sentiment_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX messages_inbound_sentiment_idx ON public.messages USING btree (instance_id, campaign_id, profile_url, sent_at DESC) WHERE ((direction = 'in'::text) AND (sentiment IS NOT NULL));


--
-- Name: messages_intent_backlog_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX messages_intent_backlog_idx ON public.messages USING btree (sent_at DESC) WHERE ((direction = 'in'::text) AND (COALESCE(sentiment, ''::text) <> 'auto'::text) AND (COALESCE(intent_taxonomy_version, ''::text) <> 'p123-v1'::text));


--
-- Name: messages_notify_pending_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX messages_notify_pending_idx ON public.messages USING btree (sent_at) WHERE ((direction = 'in'::text) AND (source = 'sync'::text) AND (notified_at IS NULL));


--
-- Name: messages_thread_latest_nonempty_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX messages_thread_latest_nonempty_idx ON public.messages USING btree (instance_id, profile_url, sent_at DESC, id DESC) WHERE ((body IS NOT NULL) AND (btrim(body) <> ''::text));


--
-- Name: messages_unclassified_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX messages_unclassified_idx ON public.messages USING btree (sent_at) WHERE ((direction = 'in'::text) AND (sentiment IS NULL));


--
-- Name: messages_updated_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX messages_updated_at_idx ON public.messages USING btree (updated_at);


--
-- Name: pipeline_events_lead_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX pipeline_events_lead_idx ON public.pipeline_events USING btree (lead_id, occurred_at);


--
-- Name: pipeline_events_time_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX pipeline_events_time_idx ON public.pipeline_events USING btree (occurred_at);


--
-- Name: saved_searches_hypothesis_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX saved_searches_hypothesis_id ON public.saved_searches USING btree (hypothesis_id);


--
-- Name: saved_searches_platform_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX saved_searches_platform_name ON public.saved_searches USING btree (platform, lower(name));


--
-- Name: team_members_auth_user_id_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX team_members_auth_user_id_uidx ON public.team_members USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);


--
-- Name: team_members_email_lower_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX team_members_email_lower_uidx ON public.team_members USING btree (lower(email)) WHERE (email IS NOT NULL);


--
-- Name: campaign_metrics _RETURN; Type: RULE; Schema: public; Owner: postgres
--

CREATE OR REPLACE VIEW public.campaign_metrics WITH (security_invoker='true') AS
 SELECT c.id AS campaign_id,
    c.name AS campaign_name,
    c.instance_id,
    c.status,
    count(l.id) AS total_leads,
    count(l.invited_at) AS invites_sent,
    count(l.connected_at) AS accepted,
    count(l.replied_at) AS replies,
    round(((100.0 * (count(l.connected_at) FILTER (WHERE (l.invited_at IS NOT NULL)))::numeric) / (NULLIF(count(l.invited_at), 0))::numeric), 1) AS acceptance_rate,
    round(((100.0 * (count(l.replied_at) FILTER (WHERE (l.connected_at IS NOT NULL)))::numeric) / (NULLIF(count(l.connected_at), 0))::numeric), 1) AS reply_rate,
    max(l.last_action_at) AS last_activity_at,
    c.briefing_context,
    c.briefing_context_updated_at
   FROM (public.campaigns c
     LEFT JOIN public.leads l ON ((l.campaign_id = c.id)))
  GROUP BY c.id;


--
-- Name: leads archive_follow_up_on_last_lead_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER archive_follow_up_on_last_lead_delete AFTER DELETE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.archive_follow_up_after_last_lead();


--
-- Name: leads leads_keep_milestones; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER leads_keep_milestones BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.leads_keep_milestones();


--
-- Name: leads refresh_lead_age_estimate; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER refresh_lead_age_estimate BEFORE INSERT OR UPDATE OF education_start_year, first_job_start_year ON public.leads FOR EACH ROW EXECUTE FUNCTION public.refresh_lead_age_estimate();


--
-- Name: leads reset_lead_gender_on_input_change; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER reset_lead_gender_on_input_change BEFORE UPDATE OF full_name, headline ON public.leads FOR EACH ROW EXECUTE FUNCTION public.reset_lead_gender_on_input_change();


--
-- Name: campaigns touch_campaigns_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER touch_campaigns_updated_at BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: hypotheses touch_hypotheses_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER touch_hypotheses_updated_at BEFORE UPDATE ON public.hypotheses FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: icp_industries touch_icp_industries_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER touch_icp_industries_updated_at BEFORE UPDATE ON public.icp_industries FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: icp_personas touch_icp_personas_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER touch_icp_personas_updated_at BEFORE UPDATE ON public.icp_personas FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: icps touch_icps_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER touch_icps_updated_at BEFORE UPDATE ON public.icps FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: leads touch_leads_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER touch_leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: messages touch_messages_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER touch_messages_updated_at BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: saved_searches touch_saved_searches_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER touch_saved_searches_updated_at BEFORE UPDATE ON public.saved_searches FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: campaign_steps campaign_steps_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campaign_steps
    ADD CONSTRAINT campaign_steps_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: campaigns campaigns_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;


--
-- Name: coaching_digest coaching_digest_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.coaching_digest
    ADD CONSTRAINT coaching_digest_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;


--
-- Name: conversation_coaching conversation_coaching_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.conversation_coaching
    ADD CONSTRAINT conversation_coaching_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;


--
-- Name: conversation_follow_up_state conversation_follow_up_state_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.conversation_follow_up_state
    ADD CONSTRAINT conversation_follow_up_state_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;


--
-- Name: conversation_follow_up_state conversation_follow_up_state_last_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.conversation_follow_up_state
    ADD CONSTRAINT conversation_follow_up_state_last_event_id_fkey FOREIGN KEY (last_event_id) REFERENCES public.follow_up_events(id) ON DELETE SET NULL;


--
-- Name: conversation_follow_up_state conversation_follow_up_state_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.conversation_follow_up_state
    ADD CONSTRAINT conversation_follow_up_state_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.team_members(id) ON DELETE SET NULL;


--
-- Name: events events_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: events events_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;


--
-- Name: follow_up_events follow_up_events_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.follow_up_events
    ADD CONSTRAINT follow_up_events_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;


--
-- Name: follow_up_events follow_up_events_new_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.follow_up_events
    ADD CONSTRAINT follow_up_events_new_owner_id_fkey FOREIGN KEY (new_owner_id) REFERENCES public.team_members(id) ON DELETE SET NULL;


--
-- Name: follow_up_events follow_up_events_previous_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.follow_up_events
    ADD CONSTRAINT follow_up_events_previous_owner_id_fkey FOREIGN KEY (previous_owner_id) REFERENCES public.team_members(id) ON DELETE SET NULL;


--
-- Name: hypotheses hypotheses_icp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypotheses
    ADD CONSTRAINT hypotheses_icp_id_fkey FOREIGN KEY (icp_id) REFERENCES public.icps(id) ON DELETE SET NULL;


--
-- Name: hypothesis_campaigns hypothesis_campaigns_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypothesis_campaigns
    ADD CONSTRAINT hypothesis_campaigns_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: hypothesis_campaigns hypothesis_campaigns_hypothesis_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hypothesis_campaigns
    ADD CONSTRAINT hypothesis_campaigns_hypothesis_id_fkey FOREIGN KEY (hypothesis_id) REFERENCES public.hypotheses(id) ON DELETE CASCADE;


--
-- Name: icp_industries icp_industries_icp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.icp_industries
    ADD CONSTRAINT icp_industries_icp_id_fkey FOREIGN KEY (icp_id) REFERENCES public.icps(id) ON DELETE CASCADE;


--
-- Name: icp_personas icp_personas_icp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.icp_personas
    ADD CONSTRAINT icp_personas_icp_id_fkey FOREIGN KEY (icp_id) REFERENCES public.icps(id) ON DELETE CASCADE;


--
-- Name: lead_gender_reviews lead_gender_reviews_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lead_gender_reviews
    ADD CONSTRAINT lead_gender_reviews_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;


--
-- Name: lead_gender_reviews lead_gender_reviews_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lead_gender_reviews
    ADD CONSTRAINT lead_gender_reviews_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;


--
-- Name: lead_notes lead_notes_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lead_notes
    ADD CONSTRAINT lead_notes_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE CASCADE;


--
-- Name: leads leads_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.team_members(id) ON DELETE SET NULL;


--
-- Name: leads leads_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: leads leads_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;


--
-- Name: messages messages_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: messages messages_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;


--
-- Name: pipeline_events pipeline_events_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pipeline_events
    ADD CONSTRAINT pipeline_events_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE CASCADE;


--
-- Name: saved_searches saved_searches_hypothesis_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.saved_searches
    ADD CONSTRAINT saved_searches_hypothesis_id_fkey FOREIGN KEY (hypothesis_id) REFERENCES public.hypotheses(id) ON DELETE SET NULL;


--
-- Name: sync_runs sync_runs_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sync_runs
    ADD CONSTRAINT sync_runs_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: annotations active members can read annotations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read annotations" ON public.annotations FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: briefing_jobs active members can read briefing_jobs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read briefing_jobs" ON public.briefing_jobs FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: briefings active members can read briefings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read briefings" ON public.briefings FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: campaign_steps active members can read campaign_steps; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read campaign_steps" ON public.campaign_steps FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: campaigns active members can read campaigns; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read campaigns" ON public.campaigns FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: coaching_digest active members can read coaching_digest; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read coaching_digest" ON public.coaching_digest FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: conversation_coaching active members can read conversation_coaching; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read conversation_coaching" ON public.conversation_coaching FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: conversation_follow_up_state active members can read conversation_follow_up_state; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read conversation_follow_up_state" ON public.conversation_follow_up_state FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: events active members can read events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read events" ON public.events FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: follow_up_events active members can read follow_up_events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read follow_up_events" ON public.follow_up_events FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: hypotheses active members can read hypotheses; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read hypotheses" ON public.hypotheses FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: hypothesis_campaigns active members can read hypothesis_campaigns; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read hypothesis_campaigns" ON public.hypothesis_campaigns FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: icp_industries active members can read icp_industries; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read icp_industries" ON public.icp_industries FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: icp_personas active members can read icp_personas; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read icp_personas" ON public.icp_personas FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: icps active members can read icps; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read icps" ON public.icps FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: instances active members can read instances; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read instances" ON public.instances FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: lead_gender_reviews active members can read lead_gender_reviews; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read lead_gender_reviews" ON public.lead_gender_reviews FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: lead_notes active members can read lead_notes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read lead_notes" ON public.lead_notes FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: leads active members can read leads; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read leads" ON public.leads FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: messages active members can read messages; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read messages" ON public.messages FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: pipeline_events active members can read pipeline_events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read pipeline_events" ON public.pipeline_events FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: playbook active members can read playbook; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read playbook" ON public.playbook FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: saved_searches active members can read saved_searches; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read saved_searches" ON public.saved_searches FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: sync_runs active members can read sync_runs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read sync_runs" ON public.sync_runs FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: team_members active members can read team_members; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "active members can read team_members" ON public.team_members FOR SELECT TO authenticated USING (public.is_active_team_member());


--
-- Name: annotations ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.annotations FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: briefing_jobs ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.briefing_jobs FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: briefings ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.briefings FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: campaign_steps ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.campaign_steps FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: campaigns ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.campaigns FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: coaching_digest ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.coaching_digest FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: conversation_coaching ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.conversation_coaching FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: conversation_follow_up_state ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.conversation_follow_up_state FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: events ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.events FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: follow_up_events ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.follow_up_events FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: hypotheses ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.hypotheses FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: hypothesis_campaigns ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.hypothesis_campaigns FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: icp_industries ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.icp_industries FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: icp_personas ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.icp_personas FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: icps ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.icps FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: instances ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.instances FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: lead_gender_reviews ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.lead_gender_reviews FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: lead_notes ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.lead_notes FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: leads ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.leads FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: messages ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.messages FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: pipeline_events ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.pipeline_events FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: playbook ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.playbook FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: saved_searches ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.saved_searches FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: sync_runs ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.sync_runs FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: team_members ai sql runner can read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ai sql runner can read" ON public.team_members FOR SELECT TO ai_sql_runner USING (true);


--
-- Name: annotations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.annotations ENABLE ROW LEVEL SECURITY;

--
-- Name: briefing_jobs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.briefing_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: briefings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.briefings ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_steps; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.campaign_steps ENABLE ROW LEVEL SECURITY;

--
-- Name: campaigns; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: coaching_digest; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.coaching_digest ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_coaching; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.conversation_coaching ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_follow_up_state; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.conversation_follow_up_state ENABLE ROW LEVEL SECURITY;

--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: follow_up_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.follow_up_events ENABLE ROW LEVEL SECURITY;

--
-- Name: hypotheses; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.hypotheses ENABLE ROW LEVEL SECURITY;

--
-- Name: hypothesis_campaigns; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.hypothesis_campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: icp_industries; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.icp_industries ENABLE ROW LEVEL SECURITY;

--
-- Name: icp_personas; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.icp_personas ENABLE ROW LEVEL SECURITY;

--
-- Name: icps; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.icps ENABLE ROW LEVEL SECURITY;

--
-- Name: instances; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.instances ENABLE ROW LEVEL SECURITY;

--
-- Name: lead_gender_reviews; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.lead_gender_reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: lead_notes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.lead_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: leads; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: pipeline_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.pipeline_events ENABLE ROW LEVEL SECURITY;

--
-- Name: playbook; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.playbook ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_searches; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.saved_searches ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_runs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: team_members; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO ai_sql_runner;


--
-- Name: TABLE team_members; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.team_members TO authenticated;


--
-- Name: COLUMN team_members.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(id) ON TABLE public.team_members TO ai_sql_runner;


--
-- Name: COLUMN team_members.name; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(name) ON TABLE public.team_members TO ai_sql_runner;


--
-- Name: COLUMN team_members.active; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(active) ON TABLE public.team_members TO ai_sql_runner;


--
-- Name: COLUMN team_members.created_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(created_at) ON TABLE public.team_members TO ai_sql_runner;


--
-- Name: FUNCTION admin_update_team_member(p_member_id bigint, p_name text, p_role text, p_active boolean); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.admin_update_team_member(p_member_id bigint, p_name text, p_role text, p_active boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_update_team_member(p_member_id bigint, p_name text, p_role text, p_active boolean) TO service_role;


--
-- Name: FUNCTION ai_execute_sql(query text); Type: ACL; Schema: public; Owner: ai_sql_runner
--

REVOKE ALL ON FUNCTION public.ai_execute_sql(query text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ai_execute_sql(query text) TO service_role;


--
-- Name: FUNCTION apply_follow_up_action(p_action text, p_instance_id text, p_profile_url text, p_actor text, p_expected_revision bigint, p_mutation_id uuid, p_owner_id bigint, p_next_follow_up_date date, p_reason text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.apply_follow_up_action(p_action text, p_instance_id text, p_profile_url text, p_actor text, p_expected_revision bigint, p_mutation_id uuid, p_owner_id bigint, p_next_follow_up_date date, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_follow_up_action(p_action text, p_instance_id text, p_profile_url text, p_actor text, p_expected_revision bigint, p_mutation_id uuid, p_owner_id bigint, p_next_follow_up_date date, p_reason text) TO service_role;


--
-- Name: FUNCTION archive_follow_up_after_last_lead(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.archive_follow_up_after_last_lead() FROM PUBLIC;


--
-- Name: FUNCTION delete_manual_message(p_message_id bigint); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.delete_manual_message(p_message_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_manual_message(p_message_id bigint) TO service_role;


--
-- Name: FUNCTION is_active_team_member(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_active_team_member() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_active_team_member() TO authenticated;


--
-- Name: FUNCTION is_app_admin(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_app_admin() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_app_admin() TO authenticated;


--
-- Name: FUNCTION pipeline_auto_advance(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.pipeline_auto_advance() FROM PUBLIC;
GRANT ALL ON FUNCTION public.pipeline_auto_advance() TO service_role;


--
-- Name: FUNCTION set_hypothesis_campaigns(p_hypothesis_id bigint, p_campaign_ids text[]); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.set_hypothesis_campaigns(p_hypothesis_id bigint, p_campaign_ids text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_hypothesis_campaigns(p_hypothesis_id bigint, p_campaign_ids text[]) TO service_role;


--
-- Name: TABLE annotations; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.annotations TO ai_sql_runner;
GRANT SELECT ON TABLE public.annotations TO authenticated;


--
-- Name: TABLE briefing_jobs; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.briefing_jobs TO ai_sql_runner;
GRANT SELECT ON TABLE public.briefing_jobs TO authenticated;


--
-- Name: TABLE briefings; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.briefings TO ai_sql_runner;
GRANT SELECT ON TABLE public.briefings TO authenticated;


--
-- Name: TABLE campaign_metrics; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.campaign_metrics TO ai_sql_runner;
GRANT SELECT ON TABLE public.campaign_metrics TO authenticated;


--
-- Name: TABLE messages; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.messages TO ai_sql_runner;
GRANT SELECT ON TABLE public.messages TO authenticated;


--
-- Name: TABLE campaign_reply_intent; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.campaign_reply_intent TO authenticated;
GRANT SELECT ON TABLE public.campaign_reply_intent TO ai_sql_runner;


--
-- Name: TABLE campaign_reply_sentiment; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.campaign_reply_sentiment TO ai_sql_runner;
GRANT SELECT ON TABLE public.campaign_reply_sentiment TO authenticated;


--
-- Name: TABLE campaign_steps; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.campaign_steps TO ai_sql_runner;
GRANT SELECT ON TABLE public.campaign_steps TO authenticated;


--
-- Name: TABLE campaigns; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.campaigns TO ai_sql_runner;
GRANT SELECT ON TABLE public.campaigns TO authenticated;


--
-- Name: TABLE coaching_digest; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.coaching_digest TO ai_sql_runner;
GRANT SELECT ON TABLE public.coaching_digest TO authenticated;


--
-- Name: TABLE conversation_coaching; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.conversation_coaching TO ai_sql_runner;
GRANT SELECT ON TABLE public.conversation_coaching TO authenticated;


--
-- Name: TABLE conversation_follow_up_state; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.conversation_follow_up_state TO authenticated;
GRANT SELECT ON TABLE public.conversation_follow_up_state TO ai_sql_runner;


--
-- Name: TABLE conversation_latest_message; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.conversation_latest_message TO authenticated;
GRANT SELECT ON TABLE public.conversation_latest_message TO ai_sql_runner;


--
-- Name: TABLE conversation_reply_intent; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.conversation_reply_intent TO authenticated;
GRANT SELECT ON TABLE public.conversation_reply_intent TO ai_sql_runner;


--
-- Name: TABLE events; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.events TO ai_sql_runner;
GRANT SELECT ON TABLE public.events TO authenticated;


--
-- Name: TABLE daily_activity; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.daily_activity TO ai_sql_runner;
GRANT SELECT ON TABLE public.daily_activity TO authenticated;


--
-- Name: TABLE follow_up_events; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.follow_up_events TO authenticated;
GRANT SELECT ON TABLE public.follow_up_events TO ai_sql_runner;


--
-- Name: TABLE hypotheses; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.hypotheses TO ai_sql_runner;
GRANT SELECT ON TABLE public.hypotheses TO authenticated;


--
-- Name: TABLE hypothesis_campaigns; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.hypothesis_campaigns TO ai_sql_runner;
GRANT SELECT ON TABLE public.hypothesis_campaigns TO authenticated;


--
-- Name: TABLE icp_industries; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.icp_industries TO ai_sql_runner;
GRANT SELECT ON TABLE public.icp_industries TO authenticated;


--
-- Name: TABLE icp_personas; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.icp_personas TO ai_sql_runner;
GRANT SELECT ON TABLE public.icp_personas TO authenticated;


--
-- Name: TABLE icps; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.icps TO ai_sql_runner;
GRANT SELECT ON TABLE public.icps TO authenticated;


--
-- Name: TABLE instances; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.instances TO authenticated;


--
-- Name: COLUMN instances.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(id) ON TABLE public.instances TO ai_sql_runner;


--
-- Name: COLUMN instances.label; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(label) ON TABLE public.instances TO ai_sql_runner;


--
-- Name: COLUMN instances.last_sync_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(last_sync_at) ON TABLE public.instances TO ai_sql_runner;


--
-- Name: COLUMN instances.agent_version; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(agent_version) ON TABLE public.instances TO ai_sql_runner;


--
-- Name: COLUMN instances.created_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(created_at) ON TABLE public.instances TO ai_sql_runner;


--
-- Name: COLUMN instances.account_name; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(account_name) ON TABLE public.instances TO ai_sql_runner;


--
-- Name: COLUMN instances.account_url; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(account_url) ON TABLE public.instances TO ai_sql_runner;


--
-- Name: COLUMN instances.account_avatar; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(account_avatar) ON TABLE public.instances TO ai_sql_runner;


--
-- Name: COLUMN instances.config_updated_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(config_updated_at) ON TABLE public.instances TO ai_sql_runner;


--
-- Name: TABLE lead_gender_reviews; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.lead_gender_reviews TO authenticated;
GRANT SELECT ON TABLE public.lead_gender_reviews TO ai_sql_runner;


--
-- Name: TABLE lead_notes; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.lead_notes TO ai_sql_runner;
GRANT SELECT ON TABLE public.lead_notes TO authenticated;


--
-- Name: TABLE leads; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.leads TO ai_sql_runner;
GRANT SELECT ON TABLE public.leads TO authenticated;


--
-- Name: TABLE pipeline_events; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.pipeline_events TO ai_sql_runner;
GRANT SELECT ON TABLE public.pipeline_events TO authenticated;


--
-- Name: TABLE pipeline_metrics; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.pipeline_metrics TO ai_sql_runner;
GRANT SELECT ON TABLE public.pipeline_metrics TO authenticated;


--
-- Name: TABLE playbook; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.playbook TO ai_sql_runner;
GRANT SELECT ON TABLE public.playbook TO authenticated;


--
-- Name: TABLE saved_searches; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.saved_searches TO ai_sql_runner;
GRANT SELECT ON TABLE public.saved_searches TO authenticated;


--
-- Name: TABLE sync_runs; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.sync_runs TO ai_sql_runner;
GRANT SELECT ON TABLE public.sync_runs TO authenticated;


--
-- PostgreSQL database dump complete
--

-- Supabase's postgres role has provider-managed default ACLs that grant new
-- tables/functions to anon, authenticated, and service_role. A schema dump
-- records the resulting positive ACLs but cannot preserve historical REVOKE
-- statements. Reassert the final v053 boundaries after all objects exist.
revoke select on all tables in schema public from public, anon;

revoke execute on function public.ai_execute_sql(text)
  from public, anon, authenticated;
revoke execute on function public.pipeline_auto_advance()
  from public, anon, authenticated;
revoke execute on function public.delete_manual_message(bigint)
  from public, anon, authenticated;
revoke execute on function public.set_hypothesis_campaigns(bigint, text[])
  from public, anon, authenticated;
revoke execute on function public.apply_follow_up_action(
  text, text, text, text, bigint, uuid, bigint, date, text
) from public, anon, authenticated;
revoke execute on function public.archive_follow_up_after_last_lead()
  from public, anon, authenticated;
revoke execute on function public.admin_update_team_member(
  bigint, text, text, boolean
) from public, anon, authenticated;

grant execute on function public.ai_execute_sql(text) to service_role;
grant execute on function public.pipeline_auto_advance() to service_role;
grant execute on function public.delete_manual_message(bigint) to service_role;
grant execute on function public.set_hypothesis_campaigns(bigint, text[])
  to service_role;
grant execute on function public.apply_follow_up_action(
  text, text, text, text, bigint, uuid, bigint, date, text
) to service_role;
grant execute on function public.archive_follow_up_after_last_lead()
  to service_role;
grant execute on function public.admin_update_team_member(
  bigint, text, text, boolean
) to service_role;

revoke execute on function public.is_active_team_member() from public, anon;
revoke execute on function public.is_app_admin() from public, anon;
grant execute on function public.is_active_team_member()
  to authenticated, service_role;
grant execute on function public.is_app_admin()
  to authenticated, service_role;

-- pg_dump intentionally excludes Storage bucket metadata. The private bucket
-- is the only provider metadata/data row allowed in a tenant baseline.
insert into storage.buckets (id, name, public)
values ('lead-photos', 'lead-photos', false)
on conflict (id) do update
set name = excluded.name,
    public = false;
