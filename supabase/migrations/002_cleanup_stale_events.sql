-- One-time cleanup: the first sync from notebook-1 derived invite_sent events
-- from LH2's add_to_target_date (queued-for-campaign), which was wrong. The
-- corrected mapping re-derived events from InvitePerson action results, but
-- events is append-only so the stale rows remained and double-counted the
-- daily-activity chart.
--
-- All milestone events are derived from leads, so the source of truth is the
-- leads table: drop any derived event that no longer matches its lead's
-- current milestone timestamp. Safe to re-run.

delete from events e
where e.event_type in ('invite_sent', 'invite_accepted', 'reply_received')
  and not exists (
    select 1
    from leads l
    where l.campaign_id = e.campaign_id
      and l.profile_url = e.profile_url
      and ((e.event_type = 'invite_sent'     and l.invited_at   = e.occurred_at)
        or (e.event_type = 'invite_accepted' and l.connected_at = e.occurred_at)
        or (e.event_type = 'reply_received'  and l.replied_at   = e.occurred_at))
  );
