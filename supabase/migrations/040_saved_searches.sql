-- Search Library: a shared database of named sourcing searches (Apollo, Sales
-- Navigator, esun, ...) so data sourcers can share filter setups without
-- screen-share calls. This is a SETTINGS database — the saved filter RECIPE a
-- sourcer reproduces by hand on the platform — NOT executed searches or query
-- history. Browsable/editable on the site, queryable from the AI copilot via
-- run_sql, and writable via the save_search AI tool + /api/playbook actions.
--
-- Reads use the anon key (read-open, like the rest of the data); writes go
-- through /api/playbook with the service-role key (ADMIN_SECRET-guarded).
-- The AI's run_sql runs as ai_sql_runner: 034 REVOKED the default-privilege
-- auto-SELECT on new tables (fail-closed — every new table must be granted
-- explicitly), so this table needs its own grant below or run_sql/chat/MCP would
-- hit permission-denied the moment 040 is pushed.

create table if not exists saved_searches (
  id               bigint generated always as identity primary key,
  name             text not null check (char_length(name) between 1 and 120),
  platform         text not null check (char_length(platform) between 1 and 60),
  description      text,
  include_keywords text[]  not null default '{}',
  exclude_keywords text[]  not null default '{}',
  boolean_query    text,                                 -- free-form AND/OR/NOT string, pasteable into the platform
  filters          jsonb  not null default '{}'::jsonb,  -- platform-specific settings, key -> value
  notes            text,
  author           text,
  archived         boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Natural upsert target for the AI tool and the page; blocks silent same-name
-- duplicates within a platform (case-insensitive).
create unique index if not exists saved_searches_platform_name
  on saved_searches (platform, lower(name));

-- RLS: read-open (001 convention); writes only via the service-role key.
alter table saved_searches enable row level security;
drop policy if exists "read saved_searches" on saved_searches;
create policy "read saved_searches" on saved_searches for select using (true);

-- Explicit SELECT for the AI SQL role — REQUIRED: 034 revoked the default-privilege
-- auto-grant, so without this run_sql/chat/MCP get permission-denied on this table.
grant select on saved_searches to ai_sql_runner;

-- Change-aware updated_at (031 convention; shared public.touch_updated_at()).
drop trigger if exists touch_saved_searches_updated_at on saved_searches;
create trigger touch_saved_searches_updated_at
  before update on saved_searches
  for each row execute function public.touch_updated_at();
