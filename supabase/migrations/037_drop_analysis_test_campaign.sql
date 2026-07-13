-- Remove "Messages and profiles for analysis" (notebook-1:4) — not a real
-- outreach campaign, just a test run to download conversation history. Its
-- leads/events inflate notebook-1 funnel metrics.
--
-- Deleting the campaign row cascades: leads (513), events (575),
-- campaign_steps, lead_notes, pipeline_events. Messages and
-- conversation_coaching have no FK (keyed by instance+profile) and are
-- cleaned up explicitly.
--
-- Deliberately KEPT: messages tagged to real campaigns (e.g. Web 2 Mob)
-- for people who were later moved into this test campaign in LH2 — that is
-- genuine outreach history, attributed by the LH2 action that recorded it.
--
-- NOTE: if the campaign still exists in LH2 on notebook-1, the next sync
-- re-creates all of this. Archive/delete it in LH2 before (or right after)
-- applying.

-- Manual thread imports attributed to the test campaign.
delete from messages where campaign_id = 'notebook-1:4';

-- Coaching rows for people who exist ONLY via this campaign (must run
-- before the leads cascade below, since it consults leads).
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

-- Campaign row; cascades everything FK-linked.
delete from campaigns where id = 'notebook-1:4';
