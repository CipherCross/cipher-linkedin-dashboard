-- Fix campaign_metrics.acceptance_rate exceeding 100%.
--
-- 019 constrained reply_rate's numerator but left acceptance_rate as the plain
-- round(100 * count(connected_at) / count(invited_at)). A lead can carry
-- connected_at WITHOUT invited_at (a manual/InMail import, or a lead that was
-- already a connection when the campaign picked it up), so the numerator could
-- exceed the denominator and the rate blew past 100% — the same class of bug 019
-- fixed for reply_rate. Constrain the numerator to leads that are BOTH accepted
-- and invited, so acceptance_rate is a true "% of invited who accepted".
-- (The raw `accepted` column stays the total connected count for display, mirroring
-- how 019 kept `replies` a total while filtering the reply_rate numerator.)
--
-- This is a straight re-copy of 019's definition with ONLY the acceptance_rate
-- numerator changed; every column name/position is preserved so downstream
-- consumers (frontend, AI SCHEMA_DOC) see no shape change.

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
  round(100.0 * count(l.connected_at) filter (where l.invited_at is not null)
        / nullif(count(l.invited_at), 0), 1)          as acceptance_rate,
  round(100.0 * count(l.replied_at) filter (where l.connected_at is not null)
        / nullif(count(l.connected_at), 0), 1)        as reply_rate,
  max(l.last_action_at)                               as last_activity_at
from campaigns c
left join leads l on l.campaign_id = c.id
group by c.id;
