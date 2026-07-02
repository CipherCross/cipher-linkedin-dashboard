-- Manual conversation imports.
--
-- LH2 only captures messages while its automation runs a lead; once the SDR
-- takes a conversation over by hand, new messages never reach the DB. The
-- dashboard now lets the SDR paste a LinkedIn thread into the ConversationDrawer
-- ("Import history"), which POSTs to /api/import-conversation and inserts the
-- parsed messages here with source='manual'.
--
-- source semantics:
--   'sync'   — written by the sync agent; sent_at is the LH2 ACTION-RUN time,
--              which can lag the real message by hours/days (see 017).
--   'manual' — pasted by the SDR; sent_at is the real message time as shown in
--              LinkedIn (interpreted in the paster's browser timezone).
-- Because the two sources stamp sent_at differently, the identity key never
-- merges a manual copy with a synced copy of the same logical message —
-- /api/import-conversation dedupes by normalized body + direction instead.

alter table messages
  add column if not exists source text not null default 'sync';

alter table messages drop constraint if exists messages_source_check;
alter table messages
  add constraint messages_source_check check (source in ('sync', 'manual'));

-- Milestone guard: a known funnel milestone never regresses to unknown.
--
-- The sync agent's leads upsert ALWAYS sends every milestone key, NULL when LH2
-- has no value (see the leads payload in sync-agent/agent.py extract_local), so
-- without this trigger the next scheduled sync would clobber milestones that
-- /api/import-conversation backfilled from an imported conversation.
--
-- Scope: funnel milestones + added_at. last_action_at is deliberately excluded —
-- it is LH2-operational and never set manually. A non-NULL value from LH2 still
-- overwrites a manual one (LH2 stays ground truth); only non-NULL -> NULL is
-- blocked.
--
-- Deliberate limitation: no writer can NULL these columns via a plain UPDATE
-- anymore. To correct a bad value, update it to a different value; for one-off
-- surgery, ALTER TABLE leads DISABLE TRIGGER leads_keep_milestones first.
create or replace function public.leads_keep_milestones() returns trigger
language plpgsql as $$
begin
  new.invited_at       := coalesce(new.invited_at,       old.invited_at);
  new.connected_at     := coalesce(new.connected_at,     old.connected_at);
  new.first_message_at := coalesce(new.first_message_at, old.first_message_at);
  new.replied_at       := coalesce(new.replied_at,       old.replied_at);
  new.added_at         := coalesce(new.added_at,         old.added_at);
  return new;
end $$;

drop trigger if exists leads_keep_milestones on leads;
create trigger leads_keep_milestones
  before update on leads
  for each row execute function public.leads_keep_milestones();
