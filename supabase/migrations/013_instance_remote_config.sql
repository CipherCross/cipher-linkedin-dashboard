-- Online notebook configuration. Each instance gets a `config` JSON blob holding
-- the DESIRED overrides edited from the dashboard's Health page. The sync agent
-- reads it before every sync and merges it over its local config.yaml (remote
-- wins), so non-secret settings — label, account identity, sync toggles, the LH2
-- db path, even the mapping SQL — can be changed online with no local edits.
--
-- The bootstrap keys (supabase_url, supabase_service_key, instance_id) are NEVER
-- stored here: the agent needs them locally just to connect/identify, and
-- /api/config strips them defensively. `config` holds the desired settings;
-- the existing label/account_* columns remain the agent-rendered effective
-- values the dashboard displays — so the agent never clobbers a human edit.

alter table instances
  add column if not exists config jsonb not null default '{}',
  -- set on every /api/config write; the UI compares it to last_sync_at to show
  -- "pending — applies next sync" until the agent has picked the change up.
  add column if not exists config_updated_at timestamptz;

-- The new columns inherit the existing "read instances" RLS policy
-- (select using true), so the anon frontend can read `config` to populate the
-- editor. /api/config writes with the service-role key, which bypasses RLS —
-- no write policy needed.
