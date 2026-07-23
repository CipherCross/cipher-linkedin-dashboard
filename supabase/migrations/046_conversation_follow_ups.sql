-- Conversation-scoped follow-up tasks.
--
-- A follow-up belongs to one LinkedIn thread (instance_id + profile_url), not
-- to one campaign lead row. `conversation_follow_up_state` is the read-optimized
-- current projection; `follow_up_events` is the append-only audit trail.
-- Neither table is touched by the LH2 sync agent.

-- Latest-message cards must not use DataContext's intentionally windowed
-- outbound slice. This partial index supports the one-row-per-thread view below.
create index if not exists messages_thread_latest_nonempty_idx
  on messages (instance_id, profile_url, sent_at desc, id desc)
  where body is not null and btrim(body) <> '';

create table if not exists follow_up_events (
  id                  bigint generated always as identity primary key,
  instance_id         text not null references instances(id) on delete cascade,
  profile_url         text not null,
  mutation_id         uuid not null,
  event_ordinal       smallint not null check (event_ordinal between 1 and 2),
  request_fingerprint text not null,
  event_kind          text not null check (
    event_kind in ('scheduled', 'rescheduled', 'reassigned', 'completed', 'skipped', 'canceled')
  ),
  previous_due_date   date,
  new_due_date        date,
  previous_owner_id   bigint references team_members(id) on delete set null,
  new_owner_id        bigint references team_members(id) on delete set null,
  previous_owner_name text check (
    previous_owner_name is null or char_length(previous_owner_name) <= 100
  ),
  new_owner_name      text check (
    new_owner_name is null or char_length(new_owner_name) <= 100
  ),
  state_revision      bigint not null check (state_revision > 0),
  actor               text not null check (char_length(btrim(actor)) between 1 and 120),
  reason              text check (reason is null or char_length(reason) <= 1000),
  occurred_at         timestamptz not null default now(),
  unique (mutation_id, event_ordinal),
  constraint follow_up_events_values_check check (
    (
      event_kind = 'scheduled'
      and previous_due_date is null
      and new_due_date is not null
      and new_owner_name is not null
    )
    or (
      event_kind = 'rescheduled'
      and previous_due_date is not null
      and new_due_date is not null
      and previous_due_date <> new_due_date
    )
    or (
      event_kind = 'reassigned'
      and previous_due_date is not null
      and new_due_date = previous_due_date
      and new_owner_name is not null
      and previous_owner_name is distinct from new_owner_name
    )
    or (
      event_kind in ('completed', 'skipped', 'canceled')
      and previous_due_date is not null
      and new_due_date is null
    )
  ),
  constraint follow_up_events_skip_reason_check check (
    event_kind <> 'skipped' or (reason is not null and btrim(reason) <> '')
  )
);

create index if not exists follow_up_events_thread_time_idx
  on follow_up_events (instance_id, profile_url, occurred_at desc, id desc);
create index if not exists follow_up_events_time_idx
  on follow_up_events (occurred_at desc, id desc);

create table if not exists conversation_follow_up_state (
  instance_id         text not null references instances(id) on delete cascade,
  profile_url         text not null,
  next_follow_up_date date,
  owner_id            bigint references team_members(id) on delete set null,
  revision            bigint not null default 0 check (revision >= 0),
  last_event_id       bigint references follow_up_events(id) on delete set null,
  last_mutation_id    uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          text not null default 'unknown'
    check (char_length(btrim(updated_by)) between 1 and 120),
  archived_at         timestamptz,
  primary key (instance_id, profile_url)
);

create index if not exists conversation_follow_up_active_due_idx
  on conversation_follow_up_state (next_follow_up_date, owner_id)
  where next_follow_up_date is not null and archived_at is null;
create index if not exists conversation_follow_up_owner_due_idx
  on conversation_follow_up_state (owner_id, next_follow_up_date)
  where next_follow_up_date is not null and archived_at is null;

alter table follow_up_events enable row level security;
alter table conversation_follow_up_state enable row level security;

drop policy if exists "read follow_up_events" on follow_up_events;
create policy "read follow_up_events"
  on follow_up_events for select using (true);
drop policy if exists "read conversation_follow_up_state" on conversation_follow_up_state;
create policy "read conversation_follow_up_state"
  on conversation_follow_up_state for select using (true);

-- One authoritative latest non-empty message per LinkedIn thread.
create or replace view public.conversation_latest_message
with (security_invoker = true)
as
select distinct on (m.instance_id, m.profile_url)
  m.instance_id,
  m.profile_url,
  m.id as message_id,
  m.direction,
  m.body,
  m.sent_at,
  m.source
from messages m
where m.body is not null
  and btrim(m.body) <> ''
order by m.instance_id, m.profile_url, m.sent_at desc, m.id desc;

grant select on follow_up_events, conversation_follow_up_state
  to anon, authenticated, ai_sql_runner;
grant select on conversation_latest_message
  to anon, authenticated, ai_sql_runner;

-- Apply one task mutation atomically. The transaction advisory lock works even
-- for a first schedule, when no state row exists yet. Every caller supplies a
-- monotonic revision and a mutation UUID so stale tabs and committed-response
-- retries cannot silently overwrite or duplicate history.
create or replace function public.apply_follow_up_action(
  p_action text,
  p_instance_id text,
  p_profile_url text,
  p_actor text,
  p_expected_revision bigint,
  p_mutation_id uuid,
  p_owner_id bigint default null,
  p_next_follow_up_date date default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
    hashtextextended(p_instance_id || chr(0) || p_profile_url, 0)
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

revoke all on function public.apply_follow_up_action(
  text, text, text, text, bigint, uuid, bigint, date, text
) from public, anon, authenticated;
grant execute on function public.apply_follow_up_action(
  text, text, text, text, bigint, uuid, bigint, date, text
) to service_role;

-- Campaign deletion cascades leads. Only the final exact matching lead archives
-- the shared task. The event/history remains until its instance is deleted.
create or replace function public.archive_follow_up_after_last_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
    hashtextextended(old.instance_id || chr(0) || old.profile_url, 0)
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

revoke all on function public.archive_follow_up_after_last_lead()
  from public, anon, authenticated;

drop trigger if exists archive_follow_up_on_last_lead_delete on leads;
create trigger archive_follow_up_on_last_lead_delete
  after delete on leads
  for each row execute function public.archive_follow_up_after_last_lead();
