-- One-time cleanup of messages duplicated by repeated CheckForReplies snapshots.
--
-- `messages.sent_at` was set to the action-run time (action_results.created_at),
-- not the true message time. CheckForReplies re-records the whole conversation
-- thread on every run, so one real message produced one row per run — each with a
-- different sent_at — and the unique constraint (instance_id, profile_url,
-- direction, sent_at) couldn't catch them. The conversation view then showed the
-- same message N times (e.g. Jun 16/17/19/22). The sync agent (MESSAGES_SQL) now
-- de-dupes at extraction time keeping the EARLIEST observation; this migration
-- collapses the duplicates already stored.
--
-- We dedupe by (instance_id, profile_url, direction, body) keeping the earliest
-- row (smallest sent_at, then smallest id) — matching the agent's earliest-wins
-- rule so future syncs stay idempotent. Only non-null bodies are collapsed: the
-- snapshot duplicates always carry reply text, and null-body sends have no key to
-- distinguish them safely, so they are left untouched.

-- 1) Preserve any classification (AI or manual reclassification done in the UI)
--    onto the row that will survive, so the delete below doesn't drop it. Picks
--    the most-recently-classified non-null sentiment within each duplicate group.
with grp as (
  select id,
         row_number() over w_keep as keep_rn,
         first_value(sentiment)        over w_cls as s,
         first_value(reason)           over w_cls as r,
         first_value(classified_at)    over w_cls as ca,
         first_value(classified_model) over w_cls as cm
  from messages
  where body is not null
  window
    w_keep as (partition by instance_id, profile_url, direction, body
               order by sent_at asc, id asc),
    w_cls  as (partition by instance_id, profile_url, direction, body
               order by (sentiment is null) asc, classified_at desc nulls last
               rows between unbounded preceding and unbounded following)
)
update messages m
   set sentiment        = grp.s,
       reason           = grp.r,
       classified_at    = grp.ca,
       classified_model = grp.cm
  from grp
 where m.id = grp.id
   and grp.keep_rn = 1
   and m.sentiment is null
   and grp.s is not null;

-- 2) Delete every duplicate except the earliest in its group.
delete from messages a
using messages b
where a.instance_id = b.instance_id
  and a.profile_url = b.profile_url
  and a.direction   = b.direction
  and a.body is not null and b.body is not null
  and a.body = b.body
  and (a.sent_at > b.sent_at
       or (a.sent_at = b.sent_at and a.id > b.id));
