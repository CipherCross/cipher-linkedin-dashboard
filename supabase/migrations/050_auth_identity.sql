-- Invite-only application auth.
--
-- This is deliberately ADDITIVE: it links Supabase Auth identities to the
-- existing assignment directory without changing the current read-open
-- policies. Deploy the auth-aware frontend/API after this migration, then apply
-- 051_authenticated_rls.sql as a separate cutover.

alter table public.team_members
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null,
  add column if not exists email text,
  add column if not exists role text not null default 'member';

alter table public.team_members
  drop constraint if exists team_members_role_check;
alter table public.team_members
  add constraint team_members_role_check
  check (role in ('member', 'admin'));

create unique index if not exists team_members_auth_user_id_uidx
  on public.team_members (auth_user_id)
  where auth_user_id is not null;

create unique index if not exists team_members_email_lower_uidx
  on public.team_members (lower(email))
  where email is not null;

-- RLS policies call this helper even for team_members itself. SECURITY DEFINER
-- avoids recursive RLS while the empty search_path + fully-qualified names keep
-- the definer boundary safe.
create or replace function public.is_active_team_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.team_members tm
    where tm.auth_user_id = auth.uid()
      and tm.active
  );
$$;

create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.team_members tm
    where tm.auth_user_id = auth.uid()
      and tm.active
      and tm.role = 'admin'
  );
$$;

revoke all on function public.is_active_team_member() from public, anon;
revoke all on function public.is_app_admin() from public, anon;
grant execute on function public.is_active_team_member() to authenticated;
grant execute on function public.is_app_admin() to authenticated;

-- Service-role-only update path for access-bearing fields. The advisory lock
-- serializes concurrent demotions/deactivations so two admins cannot each see
-- the other and remove the final active linked admin at the same time.
create or replace function public.admin_update_team_member(
  p_member_id bigint,
  p_name text,
  p_role text,
  p_active boolean
)
returns public.team_members
language plpgsql
security definer
set search_path = ''
as $$
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

revoke all on function public.admin_update_team_member(bigint, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.admin_update_team_member(bigint, text, text, boolean)
  to service_role;
