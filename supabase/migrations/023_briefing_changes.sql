-- Day-over-day continuity for the Morning Briefing.
--
-- /api/briefing now feeds the most recent prior briefing into today's generation
-- so it can report what CHANGED (and progress on prior risks/actions) instead of
-- restating standing facts. The result is a new "changes" block — one short line
-- per delta — stored here alongside the existing actions/risks arrays.
--
-- Additive column only; inherits the existing "read briefings" RLS policy. Old
-- rows keep the '[]' default, so the dashboard and Slack render unchanged for any
-- briefing generated before this migration.

alter table briefings
  add column if not exists changes jsonb not null default '[]';
  -- [{text, trend}] day-over-day deltas / progress vs the previous briefing.
  -- trend ∈ up | down | flat | new | resolved (plain strings; no enum type).
