-- Minimal Supabase-owned objects required to exercise this repository's
-- migrations in a disposable PostgreSQL 16 database.
--
-- Production projects get these roles/schemas from Supabase. Clean-room tests
-- create only the narrow surface referenced by migrations 001-053 so the test
-- remains independent from a linked project and never needs provider secrets.

do $provider_roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$provider_roles$;

create schema auth;
create table auth.users (
  id uuid primary key
);

create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null
);
alter table storage.objects enable row level security;

-- Supabase Storage grants its API roles access to the storage schema/tables;
-- RLS policies are the authorization boundary exercised by the P1-C smoke test.
grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.objects to anon, authenticated, service_role;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);

-- Supabase-managed projects grant provider roles schema usage and establish
-- default ACLs for objects subsequently created by the postgres migration
-- role. RLS/policies still decide whether anon/authenticated operations are
-- permitted; migrations 051-052 replace their SELECT surfaces explicitly.
grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to postgres, anon, authenticated, service_role;
