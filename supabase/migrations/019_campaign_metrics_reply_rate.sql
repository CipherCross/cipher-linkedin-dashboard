-- Fix campaign_metrics.reply_rate exceeding 100%.
--
-- reply_rate was round(100 * count(replied_at) / count(connected_at)). A lead can
-- carry replied_at without connected_at (e.g. an InMail reply, or the CSV
-- --kind replies path before the agent fix), so the numerator could exceed the
-- denominator and the rate blew past 100%. Constrain the numerator to leads that are
-- BOTH replied and accepted, so reply_rate is a true "% of accepted who replied".
-- (The raw `replies` column stays the total replied count for display.)

create or replace view campaign_metrics as
select
  c.id            as campaign_id,
  c.name          as campaign_name,
  c.instance_id,
  c.status,
  count(l.id)                                         as total_leads,
  count(l.invited_at)                                 as invites_sent,
  count(l.connected_at)                               as accepted,
  count(l.replied_at)                                 as replies,
  round(100.0 * count(l.connected_at) / nullif(count(l.invited_at), 0), 1) as acceptance_rate,
  round(100.0 * count(l.replied_at) filter (where l.connected_at is not null)
        / nullif(count(l.connected_at), 0), 1)        as reply_rate,
  max(l.last_action_at)                               as last_activity_at
from campaigns c
left join leads l on l.campaign_id = c.id
group by c.id;
