-- Provider-neutral stored functions, triggers and SELECT-only AI SQL guard.
-- Apply after 002_identity_roles_actor_rls.sql in an empty tenant database.
--
-- Role bootstrap stays outside this artifact, exactly as in S06. The control
-- plane creates app_owner, app_migration, app_runtime, app_readonly,
-- app_machine, app_system and the new app_ai_runner sandbox role, and grants
-- app_ai_runner to app_owner so the AI guard can be handed to its own owner
-- without using a superuser. The migration runner connects as the non-superuser
-- app_migration principal; this first statement makes the owner role explicit.
--
SET ROLE app_owner;

-- Every function below is a 1:1 provider-neutral port of a source v053
-- function. Two source functions resolved the signed-in principal through a
-- provider claim helper; they now resolve the transaction-local canonical
-- actor established by S06. No other business semantics are changed.
--
-- S07 hardening deltas over the source, none of which change business results:
--   * every function pins a fixed search_path, including the five source
--     functions that had none (they only touch NEW/OLD and pg_catalog builtins,
--     or public tables they already referenced unqualified);
--   * the AI SQL guard performs an explicit literal/comment-aware single
--     statement check instead of relying on a later parse failure.

--
-- Name: admin_update_team_member(bigint, text, text, boolean); Owner: app_owner
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

  -- The source counted only members linked to a provider identity. The
  -- canonical link is now team_members.user_id, which S06 made NOT NULL, so
  -- the linkage test is retained verbatim in its portable form.
  if v_current.active
     and v_current.role = 'admin'
     and v_current.user_id is not null
     and (not p_active or p_role <> 'admin') then
    select count(*)
    into v_admin_count
    from public.team_members
    where active
      and role = 'admin'
      and user_id is not null;

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

--
-- Name: apply_follow_up_action(text, text, text, text, bigint, uuid, bigint, date, text); Owner: app_owner
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

--
-- Name: archive_follow_up_after_last_lead(); Owner: app_owner
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

--
-- Name: delete_manual_message(bigint); Owner: app_owner
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

--
-- Name: is_active_team_member(); Owner: app_owner
--
-- Portable replacement for the source provider-claim helper. The signed-in
-- principal is the transaction-local canonical actor S06 established, and the
-- membership test matches the S06 policy contract exactly: a well-formed
-- app.actor_id that resolves to an active canonical user with an active
-- membership. Missing, malformed, unknown and inactive actors return false.
--

CREATE FUNCTION public.is_active_team_member() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.team_members tm
    join public.users u on u.id = tm.user_id
    where tm.user_id = case
        when pg_catalog.current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          then pg_catalog.current_setting('app.actor_id', true)::uuid
        else null::uuid
      end
      and tm.active
      and u.active
  );
$$;

--
-- Name: is_app_admin(); Owner: app_owner
--

CREATE FUNCTION public.is_app_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.team_members tm
    join public.users u on u.id = tm.user_id
    where tm.user_id = case
        when pg_catalog.current_setting('app.actor_id', true) ~* '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          then pg_catalog.current_setting('app.actor_id', true)::uuid
        else null::uuid
      end
      and tm.active
      and u.active
      and tm.role = 'admin'
  );
$$;

--
-- Name: leads_keep_milestones(); Owner: app_owner
--
-- Milestone preservation. A re-sync or any other UPDATE may fill a NULL
-- milestone, but may never regress a non-NULL milestone back to NULL. The one
-- sanctioned exception is delete_manual_message's recompute path, which opts in
-- through the transaction-local app.allow_milestone_regress setting.
--

CREATE FUNCTION public.leads_keep_milestones() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if coalesce(pg_catalog.current_setting('app.allow_milestone_regress', true), '') = 'on' then
    return new;  -- delete_manual_message's recompute path
  end if;
  new.invited_at       := coalesce(new.invited_at,       old.invited_at);
  new.connected_at     := coalesce(new.connected_at,     old.connected_at);
  new.first_message_at := coalesce(new.first_message_at, old.first_message_at);
  new.replied_at       := coalesce(new.replied_at,       old.replied_at);
  new.added_at         := coalesce(new.added_at,         old.added_at);
  return new;
end $$;

--
-- Name: pipeline_auto_advance(); Owner: app_owner
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

--
-- Name: refresh_lead_age_estimate(); Owner: app_owner
--

CREATE FUNCTION public.refresh_lead_age_estimate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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

--
-- Name: reset_lead_gender_on_input_change(); Owner: app_owner
--

CREATE FUNCTION public.reset_lead_gender_on_input_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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

--
-- Name: set_hypothesis_campaigns(bigint, text[]); Owner: app_owner
--

CREATE FUNCTION public.set_hypothesis_campaigns(p_hypothesis_id bigint, p_campaign_ids text[]) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
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

--
-- Name: touch_updated_at(); Owner: app_owner
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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

--
-- Triggers. Identical set, timing, events and column lists to the source.
--

CREATE TRIGGER archive_follow_up_on_last_lead_delete AFTER DELETE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.archive_follow_up_after_last_lead();
CREATE TRIGGER leads_keep_milestones BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.leads_keep_milestones();
CREATE TRIGGER refresh_lead_age_estimate BEFORE INSERT OR UPDATE OF education_start_year, first_job_start_year ON public.leads FOR EACH ROW EXECUTE FUNCTION public.refresh_lead_age_estimate();
CREATE TRIGGER reset_lead_gender_on_input_change BEFORE UPDATE OF full_name, headline ON public.leads FOR EACH ROW EXECUTE FUNCTION public.reset_lead_gender_on_input_change();
CREATE TRIGGER touch_campaigns_updated_at BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER touch_hypotheses_updated_at BEFORE UPDATE ON public.hypotheses FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER touch_icp_industries_updated_at BEFORE UPDATE ON public.icp_industries FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER touch_icp_personas_updated_at BEFORE UPDATE ON public.icp_personas FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER touch_icps_updated_at BEFORE UPDATE ON public.icps FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER touch_leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER touch_messages_updated_at BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER touch_saved_searches_updated_at BEFORE UPDATE ON public.saved_searches FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

--
-- Business function ACLs. PUBLIC never executes anything; the server-owned
-- runtime principal receives exactly the source's final grant set, with the
-- provider service role mapped to app_runtime and the provider browser role
-- mapped to the read-only principal. The AI sandbox role deliberately receives
-- no EXECUTE on any of these, so a SELECT that merely calls a SECURITY DEFINER
-- function cannot become a write path.
--

REVOKE ALL ON FUNCTION public.admin_update_team_member(p_member_id bigint, p_name text, p_role text, p_active boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_follow_up_action(p_action text, p_instance_id text, p_profile_url text, p_actor text, p_expected_revision bigint, p_mutation_id uuid, p_owner_id bigint, p_next_follow_up_date date, p_reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.archive_follow_up_after_last_lead() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_manual_message(p_message_id bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_active_team_member() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_app_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.leads_keep_milestones() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pipeline_auto_advance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_lead_age_estimate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_lead_gender_on_input_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_hypothesis_campaigns(p_hypothesis_id bigint, p_campaign_ids text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_update_team_member(p_member_id bigint, p_name text, p_role text, p_active boolean) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.apply_follow_up_action(p_action text, p_instance_id text, p_profile_url text, p_actor text, p_expected_revision bigint, p_mutation_id uuid, p_owner_id bigint, p_next_follow_up_date date, p_reason text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.archive_follow_up_after_last_lead() TO app_runtime;
GRANT EXECUTE ON FUNCTION public.delete_manual_message(p_message_id bigint) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.is_active_team_member() TO app_runtime, app_readonly;
GRANT EXECUTE ON FUNCTION public.is_app_admin() TO app_runtime, app_readonly;
GRANT EXECUTE ON FUNCTION public.pipeline_auto_advance() TO app_runtime;
GRANT EXECUTE ON FUNCTION public.set_hypothesis_campaigns(p_hypothesis_id bigint, p_campaign_ids text[]) TO app_runtime;

--
-- SELECT-only AI SQL guard.
--
-- The guard is the provider-neutral successor of the source ai_execute_sql. It
-- keeps the source contract: a single SELECT/WITH statement, a 10 second
-- statement timeout, an inner 1000 row cap and a jsonb_agg result shape that is
-- never NULL. It adds an explicit literal- and comment-aware single-statement
-- check so multi-statement, empty, malformed and ambiguous input fail closed
-- before anything is planned rather than after.
--
-- Privilege design, mirroring the source but without provider roles:
--   * app_ai_runner is a NOLOGIN, non-superuser, non-BYPASSRLS, non-owner role
--     that owns this SECURITY DEFINER function, holds SELECT-only table and
--     column grants and is the only role with a permissive read policy. It has
--     no INSERT/UPDATE/DELETE anywhere and no EXECUTE on any other function.
--   * app_system is the server-owned AI execution principal. Its only privilege
--     in the whole schema is USAGE on public plus EXECUTE on this one function,
--     so the guard is the entire capability of the AI path.
--   * app_runtime, app_readonly, PUBLIC and any anonymous principal receive no
--     EXECUTE on the guard, and the browser never reaches the database at all.
--

GRANT USAGE, CREATE ON SCHEMA public TO app_ai_runner;

CREATE FUNCTION public.ai_execute_sql(query text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET statement_timeout TO '10s'
    SET standard_conforming_strings TO on
    AS $_$
declare
  c_quote   constant text := chr(39);
  c_quote2  constant text := chr(39) || chr(39);
  -- Comment bodies collapse to whitespace because a trailing comment is not
  -- part of the statement. Literal and quoted-identifier bodies collapse to a
  -- non-whitespace filler instead, so a statement that legitimately ends in a
  -- literal is never mistaken for trailing whitespace and truncated.
  c_fill    constant text := 'x';
  v_raw       text := query;
  v_len       integer;
  v_i         integer := 1;
  v_scan      text := '';
  v_state     text := 'code';
  v_depth     integer := 0;
  v_open_tag  text;
  v_tag       text;
  v_char      text;
  v_pair      text;
  v_end       integer;
  v_body      text;
  v_body_scan text;
  result      jsonb;
begin
  -- (1) Absent input fails closed before any parsing work.
  if v_raw is null or btrim(v_raw) = '' then
    raise exception 'AI SQL guard: empty statement' using errcode = '22023';
  end if;

  v_len := length(v_raw);

  -- (2) Length-preserving lexical scan. Comment bodies collapse to whitespace
  -- and string literals, quoted identifiers and dollar-quoted bodies collapse to
  -- a neutral filler, so the structural checks below only ever inspect real SQL
  -- code while character offsets still line up with the original text.
  -- standard_conforming_strings is pinned on for this function, so a backslash
  -- inside a normal literal is an ordinary character; escape and unicode
  -- literals, which would reintroduce backslash escaping, are rejected outright
  -- rather than scanned.
  while v_i <= v_len loop
    v_char := substr(v_raw, v_i, 1);
    v_pair := substr(v_raw, v_i, 2);

    if v_state = 'code' then
      if v_pair = '--' then
        v_state := 'line_comment';
        v_scan := v_scan || '  ';
        v_i := v_i + 2;
      elsif v_pair = '/*' then
        v_state := 'block_comment';
        v_depth := 1;
        v_scan := v_scan || '  ';
        v_i := v_i + 2;
      elsif v_char = c_quote then
        if v_i > 1 and substr(v_raw, v_i - 1, 1) ~ '[eEuU&]' then
          raise exception 'AI SQL guard: escape and unicode string literals are not allowed'
            using errcode = '22023';
        end if;
        v_state := 'quote';
        v_scan := v_scan || c_fill;
        v_i := v_i + 1;
      elsif v_char = '"' then
        v_state := 'dquote';
        v_scan := v_scan || c_fill;
        v_i := v_i + 1;
      elsif v_char = '$' then
        v_tag := substring(substr(v_raw, v_i) from '^[$](?:[A-Za-z_][A-Za-z0-9_]*)?[$]');
        if v_tag is null then
          v_scan := v_scan || v_char;
          v_i := v_i + 1;
        else
          v_state := 'dollar';
          v_open_tag := v_tag;
          v_scan := v_scan || repeat(c_fill, length(v_tag));
          v_i := v_i + length(v_tag);
        end if;
      else
        v_scan := v_scan || v_char;
        v_i := v_i + 1;
      end if;

    elsif v_state = 'line_comment' then
      if v_char = chr(10) then
        v_state := 'code';
      end if;
      v_scan := v_scan || ' ';
      v_i := v_i + 1;

    elsif v_state = 'block_comment' then
      if v_pair = '/*' then
        v_depth := v_depth + 1;
        v_scan := v_scan || '  ';
        v_i := v_i + 2;
      elsif v_pair = '*/' then
        v_depth := v_depth - 1;
        v_scan := v_scan || '  ';
        v_i := v_i + 2;
        if v_depth = 0 then
          v_state := 'code';
        end if;
      else
        v_scan := v_scan || ' ';
        v_i := v_i + 1;
      end if;

    elsif v_state = 'quote' then
      if v_pair = c_quote2 then
        v_scan := v_scan || repeat(c_fill, 2);
        v_i := v_i + 2;
      elsif v_char = c_quote then
        v_state := 'code';
        v_scan := v_scan || c_fill;
        v_i := v_i + 1;
      else
        v_scan := v_scan || c_fill;
        v_i := v_i + 1;
      end if;

    elsif v_state = 'dquote' then
      if v_pair = '""' then
        v_scan := v_scan || repeat(c_fill, 2);
        v_i := v_i + 2;
      elsif v_char = '"' then
        v_state := 'code';
        v_scan := v_scan || c_fill;
        v_i := v_i + 1;
      else
        v_scan := v_scan || c_fill;
        v_i := v_i + 1;
      end if;

    else  -- dollar-quoted body
      if substr(v_raw, v_i, length(v_open_tag)) = v_open_tag then
        v_state := 'code';
        v_scan := v_scan || repeat(c_fill, length(v_open_tag));
        v_i := v_i + length(v_open_tag);
      else
        v_scan := v_scan || c_fill;
        v_i := v_i + 1;
      end if;
    end if;
  end loop;

  -- (3) An unterminated literal or comment is malformed input, not a query.
  if v_state <> 'code' then
    raise exception 'AI SQL guard: unterminated literal or comment'
      using errcode = '22023';
  end if;

  -- (4) One trailing terminator and trailing whitespace are tolerated, exactly
  -- as in the source. Anything the scan still sees as a terminator inside the
  -- remaining body means more than one statement was submitted.
  v_end := length(regexp_replace(v_scan, '[;[:space:]]+$', ''));
  v_body := substr(v_raw, 1, v_end);
  v_body_scan := substr(v_scan, 1, v_end);

  if btrim(v_body_scan) = '' then
    raise exception 'AI SQL guard: empty statement' using errcode = '22023';
  end if;

  if position(';' in v_body_scan) > 0 then
    raise exception 'AI SQL guard: only a single statement is allowed'
      using errcode = '22023';
  end if;

  if v_body_scan !~* '^[[:space:]]*(select|with)\y' then
    raise exception 'AI SQL guard: only SELECT / WITH queries are allowed'
      using errcode = '22023';
  end if;

  -- (5) A WITH statement may legally contain a data-modifying CTE, and a SELECT
  -- may legally lock rows or write a new table. The SELECT-only role would deny
  -- those anyway; rejecting them here makes the guard fail closed on intent
  -- rather than on a downstream privilege error.
  if v_body_scan ~* '\y(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|comment|copy|call|do|execute|prepare|deallocate|reindex|refresh|vacuum|cluster|lock|listen|unlisten|notify|discard|reset|set|begin|start|commit|rollback|savepoint|import|declare|checkpoint|reassign|into|analyze|explain|security)\y' then
    raise exception 'AI SQL guard: mutation, DDL and session statements are not allowed'
      using errcode = '22023';
  end if;

  perform set_config('statement_timeout', '10000', true);

  -- No `set local role` here: this function is owned by app_ai_runner (SELECT
  -- only) and runs SECURITY DEFINER, so it already executes with least privilege
  -- AND in a security-restricted context that blocks SET ROLE / set_config('role', ...).
  --
  -- The inner `limit 1000` bounds how many rows jsonb_agg can materialize, so a
  -- query that plans cheap but returns enormous output can't OOM the backend ahead
  -- of the statement_timeout. A `with`/CTE query is valid as the (%s) subquery.
  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) sub limit 1000) t',
    v_body)
    into result;

  return result;
end;
$_$;

REVOKE ALL ON FUNCTION public.ai_execute_sql(query text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_execute_sql(query text) TO app_system;

ALTER FUNCTION public.ai_execute_sql(query text) OWNER TO app_ai_runner;
REVOKE CREATE ON SCHEMA public FROM app_ai_runner;

--
-- AI sandbox privileges. SELECT only, and column-restricted on the two tables
-- that carry operator secrets or membership metadata: instances.config holds
-- machine credentials and team_members exposes only the four columns the source
-- allowed, so neither the member contact/role fields nor the canonical user link
-- are reachable from generated SQL.
--

GRANT USAGE ON SCHEMA public TO app_ai_runner, app_system;

GRANT SELECT ON TABLE
    public.annotations,
    public.briefing_jobs,
    public.briefings,
    public.campaign_steps,
    public.campaigns,
    public.coaching_digest,
    public.conversation_coaching,
    public.conversation_follow_up_state,
    public.events,
    public.follow_up_events,
    public.hypotheses,
    public.hypothesis_campaigns,
    public.icp_industries,
    public.icp_personas,
    public.icps,
    public.lead_gender_reviews,
    public.lead_notes,
    public.leads,
    public.messages,
    public.pipeline_events,
    public.playbook,
    public.saved_searches,
    public.sync_runs
    TO app_ai_runner;

GRANT SELECT ON TABLE
    public.campaign_metrics,
    public.campaign_reply_intent,
    public.campaign_reply_sentiment,
    public.conversation_latest_message,
    public.conversation_reply_intent,
    public.daily_activity,
    public.pipeline_metrics
    TO app_ai_runner;

GRANT SELECT(id, name, active, created_at) ON TABLE public.team_members TO app_ai_runner;
GRANT SELECT(id, label, last_sync_at, agent_version, created_at, account_name, account_url, account_avatar, config_updated_at)
    ON TABLE public.instances TO app_ai_runner;

--
-- AI read policies. The AI path is server-owned and aggregate by nature, so it
-- reads the shared workspace without an actor, exactly as in the source. Row
-- visibility is still bounded by the SELECT-only grants above, and the canonical
-- identity tables users and user_identities deliberately receive no AI policy
-- and no AI grant at all.
--

CREATE POLICY annotations_ai_read ON public.annotations FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY briefing_jobs_ai_read ON public.briefing_jobs FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY briefings_ai_read ON public.briefings FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY campaign_steps_ai_read ON public.campaign_steps FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY campaigns_ai_read ON public.campaigns FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY coaching_digest_ai_read ON public.coaching_digest FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY conversation_coaching_ai_read ON public.conversation_coaching FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY conversation_follow_up_state_ai_read ON public.conversation_follow_up_state FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY events_ai_read ON public.events FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY follow_up_events_ai_read ON public.follow_up_events FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY hypotheses_ai_read ON public.hypotheses FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY hypothesis_campaigns_ai_read ON public.hypothesis_campaigns FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY icp_industries_ai_read ON public.icp_industries FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY icp_personas_ai_read ON public.icp_personas FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY icps_ai_read ON public.icps FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY instances_ai_read ON public.instances FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY lead_gender_reviews_ai_read ON public.lead_gender_reviews FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY lead_notes_ai_read ON public.lead_notes FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY leads_ai_read ON public.leads FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY messages_ai_read ON public.messages FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY pipeline_events_ai_read ON public.pipeline_events FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY playbook_ai_read ON public.playbook FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY saved_searches_ai_read ON public.saved_searches FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY sync_runs_ai_read ON public.sync_runs FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY team_members_ai_read ON public.team_members FOR SELECT TO app_ai_runner USING (true);
