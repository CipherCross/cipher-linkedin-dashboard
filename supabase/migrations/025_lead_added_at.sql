-- When each lead was queued into its campaign, so the dashboard can show lead
-- additions over time. LH2 records this as add_to_target_date on
-- person_in_campaigns_history — distinct from invited_at, which is when the
-- InvitePerson step actually ran (see config.example.yaml). Notebooks whose
-- leads mapping exposes an `added_at` alias sync the exact value; the agent
-- falls back to the earliest milestone otherwise.

alter table leads add column if not exists added_at timestamptz;

-- Best-effort backfill for rows synced before this column existed: the earliest
-- known milestone (least() ignores NULLs). Leads with no milestones stay NULL —
-- unknown until a sync supplies the real date. The same fallback is used by the
-- agent, so re-syncs converge rather than fight the backfill.
update leads
set added_at = least(invited_at, connected_at, first_message_at, replied_at, last_action_at)
where added_at is null;

create index if not exists leads_added_idx on leads (added_at);
