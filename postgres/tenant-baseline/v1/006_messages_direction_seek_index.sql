--
-- 006_messages_direction_seek_index.sql -- the index the message keyset was
-- written for.
--
-- Session: S13 consolidation. Applied through
-- postgres/tools/portable_migration_ledger.mjs as step 6. Additive: it creates
-- one index and alters nothing that already exists. No role, no grant, no
-- function, no credential.
--
-- WHY THIS STEP EXISTS
--
-- N-S13 part 2 wrote keyset pagination for the two unbounded message reads --
-- messages.inboundHistory and messages.outboundRecent -- and then measured it
-- against the OFFSET formulation it replaced, and found no difference:
--
--     OFFSET 0                  8.23 ms
--     OFFSET 2000               7.57 ms
--     keyset seek to row 2000   6.93 ms
--
-- It recorded that plainly rather than dressing it up, because the plan said
-- exactly why: both formulations came out as a sequential scan feeding a top-N
-- heapsort. The sort key (sent_at DESC, id DESC) had no index behind it that the
-- seek could use, so the ROW comparison landed as a Filter rather than as an
-- Index Cond, and neither formulation avoided scanning the relation. Keyset was
-- still the right shape to write -- OFFSET n discards n rows per page and is
-- therefore quadratic over a full walk -- but its actual benefit was unrealized,
-- and part 2 named this index as the missing half. Part 3 carried it forward
-- unchanged.
--
-- The survey was repeated against the live catalogue before this step was
-- written, because part 3's own 27x win came from an index that already existed
-- and nobody had noticed (messages_identity_key, whose leading columns happen to
-- be the conversation views' grouping key). Nine indexes exist on public.messages
-- and not one of them serves an unpartial (direction, sent_at DESC, id DESC):
--
--   * messages_pkey and messages_identity_key are unique but lead with the wrong
--     columns -- id, and (instance_id, profile_url) respectively;
--   * messages_thread_latest_nonempty_idx carries (sent_at DESC, id DESC) but is
--     partial on a non-empty body and is prefixed by (instance_id, profile_url);
--   * messages_inbound_sentiment_idx, messages_intent_backlog_idx,
--     messages_unclassified_idx, messages_notify_pending_idx and
--     messages_campaign_sentiment_idx are all partial, each on the working set of
--     one background job;
--   * messages_updated_at_idx is on the delta-refresh watermark alone.
--
-- WHAT WAS MEASURED, AND WHAT IT SHOWS
--
-- Server-side EXPLAIN (ANALYZE), p50 of 7 runs, over 4,243 inbound rows, using
-- the operation's verbatim SQL wrapped the way the driver wraps it -- including
-- its "$n IS NULL OR ..." parameter guards, which were the plausible reason an
-- index might not be reached at all and turn out not to be:
--
--     page                      without index    with index
--     OFFSET 0                       4.71 ms       0.85 ms
--     OFFSET 2000                    5.80 ms       2.01 ms
--     keyset seek to row 2000        2.98 ms       0.73 ms
--
-- Two readings matter more than the absolute numbers, which are small at this
-- scale and always will be at this scale:
--
--   * every plan changes from "Seq Scan -> Sort" to "Index Scan", and in the
--     keyset case the ROW comparison becomes an Index Cond rather than a Filter.
--     That is the qualitative change part 2 predicted and could not demonstrate;
--   * with the index the seek is 2.8x the deep offset page (0.73 against 2.01),
--     where without it the two were within noise. The offset's cost grows with
--     the offset and the seek's does not, so that ratio widens as the relation
--     does. This is what makes the keyset shape pay rather than merely be
--     defensible.
--
-- Honest qualifications, recorded because a measurement without them is an
-- advertisement. The plans were taken as app_owner, which is not subject to the
-- messages RLS policy: app_owner is deliberately not a member of app_runtime, so
-- the credential that can create an index cannot assume the role that reads under
-- RLS. The policy references no column of public.messages -- it gates on
-- app.actor_id and two EXISTS probes against users and team_members -- so it
-- cannot constrain an index scan on this key; but that is an argument from the
-- policy text, not a measurement. And the numbers come from one relation at one
-- size in one region.
--
-- PLAIN CREATE INDEX, NOT CONCURRENTLY, AND THE TRADE THAT COSTS
--
-- CREATE INDEX takes a ShareLock on public.messages, which blocks writes for the
-- duration -- and the sync agent writes that table on a cron from every notebook.
-- CREATE INDEX CONCURRENTLY exists precisely to avoid that, and it is not used
-- here, for a reason that is structural rather than a preference:
--
--   * the ledger runner applies each step as BEGIN; SET ROLE app_owner; <the
--     artifact>; INSERT INTO app_ledger.applied_migration ...; COMMIT. One step,
--     one transaction, so the schema change and its ledger row commit together
--     and a half-applied step can never look applied. CREATE INDEX CONCURRENTLY
--     cannot run inside a transaction block at all, so as written this step would
--     fail at apply time;
--   * and the reason not to special-case the runner for it is the same
--     invariant. A CONCURRENTLY build that fails leaves an INVALID index in the
--     catalogue. The ledger is append-only and declares no down migrations, so it
--     has no way to express "recorded, but the object is unusable" -- the one
--     state it exists to make impossible. Trading that guarantee for a lock is
--     the wrong way round.
--
-- The lock is small and it was measured rather than assumed: the same CREATE
-- INDEX took 102 ms over 6,343 rows and produced a 272 kB index. Even an order of
-- magnitude more rows leaves this inside a single sync interval. Still, apply it
-- outside a sync window if that is free to arrange: a blocked write is a stalled
-- agent run, and the agent's own retry is the only thing that recovers it.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
--   * it does not index messages.thread's sort. That read is
--     (instance_id, profile_url) equality ordered by (sent_at, id), which
--     messages_identity_key serves for the equality but not for the sort, because
--     direction sits between them in the key. A thread is bounded by one human
--     conversation, so the sort is over tens of rows and an index for it would be
--     maintenance cost against no measurable read;
--   * it is not partial. Partial on direction would need two indexes to serve two
--     operations, and direction is in the key precisely so one serves both;
--   * it adds no INCLUDE columns. The projection is 17 columns wide, so an
--     index-only scan is not reachable without duplicating most of the row into
--     the index. The measured plans are Index Scans with heap fetches and that is
--     the intended shape;
--   * it grants nothing and revokes nothing. An index carries no ACL, and no role
--     gains or loses any reach because of this step.
--
-- PREREQUISITES, CHECKED IN SQL RATHER THAN ASSUMED
--
-- Step 1 must have been applied: this indexes its table and its columns. Both are
-- checked below and both raise rather than proceeding, because a partially
-- applied step is the one thing an append-only ledger cannot express.
--

SET client_min_messages TO warning;

DO $prereq$
BEGIN
    IF pg_catalog.to_regclass('public.messages') IS NULL THEN
        RAISE EXCEPTION
            'public.messages is absent: apply ledger step '
            '001_portable_business_baseline.sql first'
            USING ERRCODE = '42P01';
    END IF;

    -- The three key columns, named individually so a failure says which one is
    -- missing instead of leaving a syntax error to be interpreted.
    PERFORM 1
       FROM (VALUES ('direction'), ('sent_at'), ('id')) AS required(column_name)
      WHERE NOT EXISTS (
                SELECT 1
                  FROM pg_catalog.pg_attribute a
                 WHERE a.attrelid = 'public.messages'::regclass
                   AND a.attname = required.column_name
                   AND a.attnum > 0
                   AND NOT a.attisdropped
            );
    IF FOUND THEN
        RAISE EXCEPTION
            'public.messages does not carry direction, sent_at and id: the '
            'business baseline in this database is not the one this step indexes'
            USING ERRCODE = '42703';
    END IF;
END
$prereq$;

SET ROLE app_owner;

--
-- The key order is equality column first, then the sort key in the direction it
-- is read. DESC is not decoration: a btree can be scanned backwards, so
-- (direction, sent_at, id) would also be usable, but matching the ORDER BY
-- exactly gives the planner a forward scan and states which read this index is
-- for. `id` is in the key because sent_at is not unique -- a bulk sync stamps one
-- instant across many rows -- which is the same reason it is in the keyset and in
-- the Supabase path's own tiebreaker.
--
CREATE INDEX messages_direction_seek_idx
    ON public.messages USING btree (direction, sent_at DESC, id DESC);

COMMENT ON INDEX public.messages_direction_seek_idx IS
    'Serves the keyset seek and ORDER BY of messages.inboundHistory and messages.outboundRecent: direction equality, then (sent_at DESC, id DESC). Turns the ROW comparison into an index condition instead of a filter over a sequential scan.';

RESET client_min_messages;
RESET ROLE;
