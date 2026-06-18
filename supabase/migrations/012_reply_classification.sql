-- Reply classification: the "decision" for each inbound reply, produced by the
-- server-side Claude classifier (frontend/api/classify.ts). Columns live on
-- messages and are only ever set for inbound rows (direction='in').
--
-- Taxonomy (6 labels):
--   positive  - interested, wants to talk
--   neutral   - acknowledgement / "not now, maybe later"
--   negative  - not interested / unsubscribe
--   objection - a question or pushback to handle
--   referral  - "talk to my colleague X"
--   auto      - out-of-office / autoresponder (not a real human reply)

alter table messages
  add column if not exists sentiment text
    check (sentiment in
      ('positive','neutral','negative','objection','referral','auto')),
  add column if not exists reason text,
  add column if not exists classified_at timestamptz,
  add column if not exists classified_model text;

-- Worklist index: the classifier and cron find unclassified replies fast.
create index if not exists messages_unclassified_idx
  on messages (sent_at)
  where direction = 'in' and sentiment is null;

-- Per-campaign sentiment breakdown for KPIs and the AI copilot.
create or replace view campaign_reply_sentiment as
select campaign_id, sentiment, count(*) as cnt
from messages
where direction = 'in' and sentiment is not null
group by campaign_id, sentiment;

-- The new columns inherit the existing "messages are readable" RLS policy
-- (select using true), so the anon frontend can read sentiment. The classifier
-- writes with the service-role key, which bypasses RLS — no write policy needed.
