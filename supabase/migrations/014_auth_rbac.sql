-- Auth + RBAC: turn the open dashboard into a logged-in, role-gated app.
--
-- Until now every table was anon-readable (RLS `using (true)`) and the /api
-- endpoints ran the service-role key behind no auth. This migration:
--   1. defines roles (owner > admin > member > viewer) on a profiles table
--      keyed to auth.users, with a default-viewer trigger;
--   2. exposes the caller's role to RLS and the API via current_app_role()
--      and a Custom Access Token hook that stamps `user_role` into the JWT;
--   3. replaces every `using (true)` read policy with authenticated-only, and
--      flips the metric views to security_invoker so they can't leak past RLS.
--
-- Writes stay service-role only (the sync agent and /api bypass RLS), so no
-- write policies are added. Member management goes through /api/members
-- (service role), so profiles needs no client-facing write policy either.
--
-- Safe to run on a fresh project (after 001-013) or an existing one: the old
-- policies are dropped by name first.

-- 1. Roles ------------------------------------------------------------------

do $$ begin
  create type public.app_role as enum ('owner', 'admin', 'member', 'viewer');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       public.app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Every new auth user gets a viewer profile automatically. SECURITY DEFINER so
-- it can insert regardless of the caller; runs inside GoTrue's signup txn.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'viewer')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Caller's role, for use inside RLS policies and helper checks. SECURITY
-- DEFINER + table-owner => bypasses profiles RLS, so no policy recursion.
create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- 2. Custom Access Token hook ----------------------------------------------
-- Stamps the role into every issued JWT as `user_role`, so RLS can read
-- auth.jwt()->>'user_role' and the /api server can authorize without a DB hit.
-- Enable in the project: Authentication -> Hooks -> Custom Access Token ->
-- public.custom_access_token_hook (the provisioner sets this).
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims    jsonb;
  found_role public.app_role;
begin
  select role into found_role
  from public.profiles
  where id = (event->>'user_id')::uuid;

  claims := coalesce(event->'claims', '{}'::jsonb);
  claims := jsonb_set(claims, '{user_role}',
                      to_jsonb(coalesce(found_role::text, 'viewer')));
  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- GoTrue runs the hook as supabase_auth_admin; grant exactly what it needs.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant select on public.profiles to supabase_auth_admin;

drop policy if exists "auth admin reads profiles" on public.profiles;
create policy "auth admin reads profiles" on public.profiles
  for select to supabase_auth_admin using (true);

-- 3. profiles RLS -----------------------------------------------------------
-- A user can read their own profile; admins/owners can read everyone (for the
-- Members admin page). All writes go through the service-role API.
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.current_app_role() in ('admin', 'owner'));

-- 4. Lock down every data table: authenticated-only reads --------------------
-- Replace the original `using (true)` policies (001/005/007) so a leaked
-- URL/anon key reads nothing without a logged-in user in this project.

drop policy if exists "read instances"          on public.instances;
drop policy if exists "read campaigns"          on public.campaigns;
drop policy if exists "read leads"              on public.leads;
drop policy if exists "read events"             on public.events;
drop policy if exists "read sync_runs"          on public.sync_runs;
drop policy if exists "messages are readable"   on public.messages;
drop policy if exists "annotations are readable" on public.annotations;
drop policy if exists "anon read campaign_steps" on public.campaign_steps;

create policy "auth read instances"      on public.instances      for select to authenticated using (true);
create policy "auth read campaigns"      on public.campaigns      for select to authenticated using (true);
create policy "auth read leads"          on public.leads          for select to authenticated using (true);
create policy "auth read events"         on public.events         for select to authenticated using (true);
create policy "auth read sync_runs"      on public.sync_runs      for select to authenticated using (true);
create policy "auth read messages"       on public.messages       for select to authenticated using (true);
create policy "auth read annotations"    on public.annotations    for select to authenticated using (true);
create policy "auth read campaign_steps" on public.campaign_steps for select to authenticated using (true);

-- 5. Views must honor the caller's RLS, not the view owner's --------------
-- Postgres views run as their owner by default, which would bypass the new
-- table policies and leak data to anon. security_invoker makes them apply the
-- querying user's RLS instead. (Requires Postgres 15+, i.e. current Supabase.)
alter view public.campaign_metrics        set (security_invoker = true);
alter view public.daily_activity           set (security_invoker = true);
alter view public.campaign_reply_sentiment set (security_invoker = true);
