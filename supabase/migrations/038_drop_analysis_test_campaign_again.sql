-- Re-run of 037: the sync agent resurrected notebook-1:4 ("Messages and
-- profiles for analysis") because archiving a campaign in LH2 does not remove
-- it from lh.db. Agent 1.11.0 adds an `exclude_campaigns` config key; this
-- migration must only be applied AFTER the new agent is deployed and
-- notebook-1's remote config carries exclude_campaigns: ["4"] — otherwise the
-- next sync resurrects it again.
--
-- The 64 manual messages 037 removed did not come back (sync never recreates
-- manual imports); the messages delete is kept for idempotency.

delete from messages where campaign_id = 'notebook-1:4';

delete from conversation_coaching cc
where cc.instance_id = 'notebook-1'
  and exists (
    select 1 from leads l
    where l.campaign_id = 'notebook-1:4'
      and l.profile_url = cc.profile_url)
  and not exists (
    select 1 from leads l2
    where l2.instance_id = 'notebook-1'
      and l2.campaign_id <> 'notebook-1:4'
      and l2.profile_url = cc.profile_url);

-- Cascades leads, events, campaign_steps, lead_notes, pipeline_events.
delete from campaigns where id = 'notebook-1:4';
