-- Maintain updated_at with a change-aware trigger.
--
-- leads and campaigns have `updated_at timestamptz not null default now()` (001)
-- but NO trigger ever maintained them — the sync agent stamps updated_at = now()
-- in its payload. messages had no updated_at column at all. The frontend team is
-- building an INCREMENTAL fetch keyed on updated_at ("give me rows changed since
-- last poll"), and that needs a DB-enforced, trustworthy semantic:
--
--     updated_at moves ONLY when the row's data actually changed.
--
-- The agent upserts EVERY row EVERY sync with PostgREST merge-duplicates, i.e. a
-- no-op UPDATE per unchanged row, AND stamps updated_at = now() in the payload. A
-- naive "always bump" trigger (or trusting the agent's stamp) would push every row
-- forward on every sync and defeat the incremental fetch entirely. So the trigger
-- below is change-aware: it first pins new.updated_at back to the OLD value (which
-- both excludes updated_at itself from the row comparison AND overrides the agent's
-- manual stamp), then bumps to now() only when the rest of the row actually differs.

-- (a) messages needs the column before the trigger can maintain it.
alter table messages add column if not exists updated_at timestamptz not null default now();

-- (b) Change-aware BEFORE UPDATE function, shared by all three tables.
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
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

-- (c) Wire it onto leads, campaigns, messages. drop-then-create for rerunnability.
--
-- ORDERING on leads: leads_keep_milestones (026) is also BEFORE UPDATE, and
-- per-row triggers of the same timing fire in ALPHABETICAL name order. This trigger
-- is named `touch_leads_updated_at` so it sorts AFTER `leads_keep_milestones`
-- ('l' < 't'), which is REQUIRED: the milestone-coalescing trigger must run first so
-- that a re-sync which would regress a non-NULL milestone to NULL (026 rewrites it
-- back to the old value) is already normalized by the time we do the is-distinct
-- comparison. Otherwise that blocked regression would look like a real change and
-- spuriously bump updated_at on an unchanged row — exactly what the incremental
-- fetch must not see.
drop trigger if exists touch_leads_updated_at on leads;
create trigger touch_leads_updated_at
  before update on leads
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_campaigns_updated_at on campaigns;
create trigger touch_campaigns_updated_at
  before update on campaigns
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_messages_updated_at on messages;
create trigger touch_messages_updated_at
  before update on messages
  for each row execute function public.touch_updated_at();
